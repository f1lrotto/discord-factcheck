import type { Db } from 'mongodb';
import { createDestinationCipher, type EncryptedDestination } from '../crypto/destination.js';
import { mongoOperationOptions } from '../mongo-context.js';
import { isDuplicateKey } from '../mongo-helpers.js';

export type ReleaseDestination = { guildId: string; channelId: string };

export type ReleaseSubscription = {
  _id: string;
  revision: number;
  destination?: EncryptedDestination;
  enabled: boolean;
  lastReleaseId?: string;
  lastOutcome?: 'sending' | 'sent' | 'uncertain' | 'rejected';
};

const parseDestination = (value: unknown) =>
  value &&
  typeof value === 'object' &&
  'guildId' in value &&
  typeof value.guildId === 'string' &&
  'channelId' in value &&
  typeof value.channelId === 'string'
    ? (value as ReleaseDestination)
    : null;

export const createReleaseStore = (database: Db, secret: string) => {
  if (!secret.trim()) throw new Error('Releases require a deployment secret');
  const subscriptions = database.collection<ReleaseSubscription>('release_subscriptions');
  const cipher = createDestinationCipher({
    secret,
    namespace: 'jolanda/releases/v1',
    aadDomain: 'jolanda/releases/destination',
    parse: parseDestination,
    reject: () => {
      throw new Error('Release destination authentication failed');
    },
  });
  const keyOf = (guildId: string) => cipher.hash('subscription', [guildId]);
  const get = (guildId: string) =>
    subscriptions.findOne({ _id: keyOf(guildId) }, mongoOperationOptions);

  return {
    get,
    destination: (subscription: ReleaseSubscription) =>
      subscription.destination
        ? cipher.decrypt(subscription.destination, subscription._id, subscription.revision)
        : null,
    configure: async (route: ReleaseDestination) => {
      if (!route.guildId || !route.channelId) throw new Error('Invalid release destination');
      const key = keyOf(route.guildId);
      for (;;) {
        const current = await subscriptions.findOne({ _id: key }, mongoOperationOptions);
        const revision = (current?.revision ?? 0) + 1;
        const destination = cipher.encrypt(route, key, revision);
        if (!current) {
          const subscription: ReleaseSubscription = {
            _id: key,
            revision,
            destination,
            enabled: true,
          };
          try {
            await subscriptions.insertOne(subscription, mongoOperationOptions);
            return subscription;
          } catch (error) {
            if (!isDuplicateKey(error)) throw error;
          }
        } else {
          const updated = await subscriptions.findOneAndUpdate(
            { _id: key, revision: current.revision },
            { $set: { enabled: true, destination }, $inc: { revision: 1 } },
            { returnDocument: 'after', ...mongoOperationOptions },
          );
          if (updated) return updated;
        }
      }
    },
    disable: async (guildId: string) => {
      await subscriptions.updateOne(
        { _id: keyOf(guildId) },
        { $set: { enabled: false }, $unset: { destination: '' }, $inc: { revision: 1 } },
        mongoOperationOptions,
      );
    },
    beginSend: async (subscription: ReleaseSubscription, releaseId: string) =>
      (
        await subscriptions.updateOne(
          {
            _id: subscription._id,
            enabled: true,
            revision: subscription.revision,
            $or: [
              { lastReleaseId: { $exists: false } },
              { lastReleaseId: { $lt: releaseId } },
              { lastReleaseId: releaseId, lastOutcome: 'rejected' },
            ],
          },
          { $set: { lastReleaseId: releaseId, lastOutcome: 'sending' } },
          mongoOperationOptions,
        )
      ).modifiedCount === 1,
    finishSend: async (
      subscription: ReleaseSubscription,
      releaseId: string,
      outcome: 'sent' | 'uncertain' | 'rejected',
    ) => {
      await subscriptions.updateOne(
        { _id: subscription._id, lastReleaseId: releaseId, lastOutcome: 'sending' },
        { $set: { lastOutcome: outcome } },
        mongoOperationOptions,
      );
    },
  };
};
