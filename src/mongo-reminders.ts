import { randomBytes, randomUUID } from 'node:crypto';
import { createDestinationCipher, type EncryptedDestination } from './crypto/destination.js';
import { mongoOperationOptions, type MongoContext } from './mongo-context.js';
import { isDuplicateKey } from './mongo-helpers.js';
import {
  reminderLimits,
  type Reminder,
  type ReminderDestination,
  type ReminderStatus,
  type ReminderStore,
} from './reminders.js';

export class ReminderDecryptionError extends Error {
  constructor() {
    super('Reminder destination authentication failed');
    this.name = 'ReminderDecryptionError';
  }
}

export type ReminderDocument = {
  _id: string;
  guildKey: string;
  ownerKey: string;
  channelKey: string;
  slot: number;
  /** Short, member-visible handle. Random, not derived from any Discord identifier. */
  publicId: string;
  status: ReminderStatus;
  text: string;
  dueAt: Date;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  attempts: number;
  nonce: string;
  destination?: EncryptedDestination;
  leaseOwnerKey?: string;
  leaseExpiresAt?: Date;
  deliveredMessageKey?: string;
};

const parseDestination = (value: unknown) =>
  value &&
  typeof value === 'object' &&
  'guildId' in value &&
  typeof value.guildId === 'string' &&
  'channelId' in value &&
  typeof value.channelId === 'string' &&
  'userId' in value &&
  typeof value.userId === 'string'
    ? (value as ReminderDestination)
    : null;

export const createMongoReminders = (
  context: MongoContext,
  input: { secret: string; now?: () => Date },
): ReminderStore => {
  if (!input.secret.trim()) throw new Error('Reminders require a deployment secret');
  const now = input.now ?? (() => new Date());
  const reminders = context.collections.reminders;
  const cipher = createDestinationCipher({
    secret: input.secret,
    namespace: 'jolanda/reminders/v1',
    aadDomain: 'jolanda/reminders/destination',
    parse: parseDestination,
    reject: () => {
      throw new ReminderDecryptionError();
    },
  });
  const guildKeyOf = (guildId: string) => cipher.hash('guild', [guildId]);
  const ownerKeyOf = (guildId: string, userId: string) => cipher.hash('owner', [guildId, userId]);
  const publicId = () =>
    randomBytes(reminderLimits.publicIdCharacters)
      .toString('hex')
      .slice(0, reminderLimits.publicIdCharacters);

  const toReminder = (document: ReminderDocument): Reminder => ({
    id: document.publicId,
    text: document.text,
    dueAt: document.dueAt,
    createdAt: document.createdAt,
    status: document.status,
  });

  // Only work that has not fired yet is a member's to see or cancel.
  const pendingFilter = (date: Date) => ({
    status: { $in: ['pending', 'claimed', 'sending'] as ReminderStatus[] },
    dueAt: { $exists: true },
    expiresAt: { $gt: date },
  });

  return {
    create: async ({ destination, text, dueAt, now: date }) => {
      const guildKey = guildKeyOf(destination.guildId);
      const ownerKey = ownerKeyOf(destination.guildId, destination.userId);
      const pending = await reminders.countDocuments(
        { ownerKey, ...pendingFilter(date) },
        mongoOperationOptions,
      );
      if (pending >= reminderLimits.maximumPending) return 'limit_reached';

      // Retry a colliding public handle rather than surfacing a duplicate-key failure.
      for (let attempt = 0; attempt < reminderLimits.maximumPending; attempt += 1) {
        const id = publicId();
        const key = cipher.hash('reminder', [
          destination.guildId,
          destination.userId,
          randomUUID(),
        ]);
        const document: ReminderDocument = {
          _id: key,
          guildKey,
          ownerKey,
          channelKey: cipher.hash('channel', [destination.guildId, destination.channelId]),
          slot: attempt,
          publicId: id,
          status: 'pending',
          text,
          dueAt,
          createdAt: date,
          updatedAt: date,
          expiresAt: new Date(+dueAt + reminderLimits.receiptMs),
          attempts: 0,
          nonce: cipher.hash('nonce', [key]).slice(0, 24),
          destination: cipher.encrypt(destination, key, 1),
        };
        const collision = await reminders.findOne(
          { ownerKey, publicId: id, ...pendingFilter(date) },
          { projection: { _id: 1 }, ...mongoOperationOptions },
        );
        if (collision) continue;
        try {
          await reminders.insertOne(document, mongoOperationOptions);
          return toReminder(document);
        } catch (error) {
          if (!isDuplicateKey(error)) throw error;
        }
      }
      return 'limit_reached';
    },

    listForMember: async ({ guildId, userId, now: date }) => {
      const documents = await reminders
        .find(
          {
            ownerKey: ownerKeyOf(guildId, userId),
            ...pendingFilter(date),
            status: { $in: ['pending', 'claimed', 'sending', 'uncertain'] },
          },
          mongoOperationOptions,
        )
        .sort({ dueAt: 1 })
        .limit(reminderLimits.maximumPending)
        .toArray();
      return documents.map(toReminder);
    },

    cancel: async ({ guildId, userId, id }) => {
      const result = await reminders.updateOne(
        {
          ownerKey: ownerKeyOf(guildId, userId),
          publicId: id,
          // A reminder already being sent is past the point of cancellation.
          status: { $in: ['pending', 'claimed'] },
        },
        { $set: { status: 'cancelled', updatedAt: now() }, $unset: { destination: '' } },
        mongoOperationOptions,
      );
      return result.modifiedCount === 1;
    },

    dueInWindow: async ({ guildId, channelId, from, to }) => {
      const documents = await reminders
        .find(
          {
            guildKey: guildKeyOf(guildId),
            channelKey: cipher.hash('channel', [guildId, channelId]),
            status: 'pending',
            dueAt: { $gte: from, $lt: to },
          },
          mongoOperationOptions,
        )
        .sort({ dueAt: 1 })
        .limit(reminderLimits.maximumPending)
        .toArray();
      return documents.map(toReminder);
    },

    claimDue: async (date) => {
      // Once a POST may have started, a crash is ambiguous: never retry it automatically.
      await reminders.updateMany(
        { status: 'sending', leaseExpiresAt: { $lte: date } },
        { $set: { status: 'uncertain', updatedAt: date }, $unset: { destination: '' } },
        mongoOperationOptions,
      );
      const owner = cipher.hash('lease', [randomUUID()]);
      const document = await reminders.findOneAndUpdate(
        {
          dueAt: { $lte: date },
          expiresAt: { $gt: date },
          $or: [
            {
              status: 'pending',
              $or: [{ leaseExpiresAt: { $exists: false } }, { leaseExpiresAt: { $lte: date } }],
            },
            // Recover a send whose lease expired without a receipt.
            { status: 'claimed', leaseExpiresAt: { $lte: date } },
          ],
        },
        {
          $set: {
            status: 'claimed',
            leaseOwnerKey: owner,
            leaseExpiresAt: new Date(+date + reminderLimits.leaseMs),
            updatedAt: date,
          },
          $inc: { attempts: 1 },
        },
        { returnDocument: 'after', sort: { dueAt: 1 }, ...mongoOperationOptions },
      );
      if (!document) return null;
      return { key: document._id, owner, nonce: document.nonce, reminder: toReminder(document) };
    },

    beginSend: async (claim) => {
      const date = now();
      const document = await reminders.findOneAndUpdate(
        {
          _id: claim.key,
          leaseOwnerKey: claim.owner,
          leaseExpiresAt: { $gt: date },
          status: 'claimed',
          expiresAt: { $gt: date },
        },
        { $set: { status: 'sending', updatedAt: date } },
        { returnDocument: 'after', ...mongoOperationOptions },
      );
      if (!document?.destination) return null;
      const destination = cipher.decrypt(document.destination, document._id, 1);
      return destination;
    },

    finishSend: async (claim, result) => {
      const date = now();
      // An ambiguous send is never returned to pending: a duplicate ping is worse than a
      // missed one, so it is parked as uncertain for a human to judge.
      const status: ReminderStatus =
        result.outcome === 'sent'
          ? 'sent'
          : result.outcome === 'uncertain'
            ? 'uncertain'
            : result.outcome === 'destination-unavailable'
              ? 'cancelled'
              : 'pending';
      await reminders.updateOne(
        { _id: claim.key, leaseOwnerKey: claim.owner, status: 'sending' },
        {
          $set: {
            status,
            updatedAt: date,
            ...(status === 'pending'
              ? {
                  leaseExpiresAt: new Date(
                    Math.max(
                      +date + 60_000,
                      +(result.outcome === 'rejected' && result.retryAt ? result.retryAt : date),
                    ),
                  ),
                }
              : {}),
            ...(result.outcome === 'sent'
              ? { deliveredMessageKey: cipher.hash('message', [result.messageId]) }
              : {}),
          },
          $unset:
            status === 'pending'
              ? { leaseOwnerKey: '' }
              : { leaseOwnerKey: '', leaseExpiresAt: '', destination: '' },
        },
        mongoOperationOptions,
      );
    },
  };
};
