import { MongoServerError } from 'mongodb';
import { mongoOperationOptions, type MongoContext } from '../mongo-context.js';
import { createNewsCipher, NewsDecryptionError } from './cipher.js';
import { activateContinuousBaseline } from './policy.js';
import type {
  NewsClock,
  NewsSourceState,
  NewsSubscription,
  NewsSubscriptionRecord,
  NewsSubscriptionStore,
} from './types.js';

export type NewsSubscriptionDocument = Omit<NewsSubscriptionRecord, 'key'> & {
  _id: string;
  guildKey: string;
};
export type NewsSourceDocument = NewsSourceState & { _id: NewsSourceState['source'] };
export type NewsMetadataDocument = { _id: 'encryption-v1'; keyVerifier: string };
export type NewsMongoOptions = { secret: string; clock?: NewsClock };

const subscriptionView = (document: NewsSubscriptionDocument) =>
  ({
    key: document._id,
    feed: document.feed,
    revision: document.revision,
    enabled: document.enabled,
    activatedAt: document.activatedAt,
    baseline: document.baseline,
    nextDeliveryAt: document.nextDeliveryAt,
    ...(document.pausedReason ? { pausedReason: document.pausedReason } : {}),
  }) satisfies NewsSubscription;
const duplicateKey = (error: unknown) => error instanceof MongoServerError && error.code === 11000;

export const createMongoNews = (context: MongoContext, options: NewsMongoOptions) => {
  const {
    newsSubscriptions: subscriptions,
    newsSources: sources,
    newsMetadata: metadata,
  } = context.collections;
  const cipher = createNewsCipher(options.secret);
  const now = options.clock ?? (() => new Date());

  const initialize = async () => {
    // The unique marker also prevents two processes with different secrets from creating
    // disjoint subscription identities in the same database.
    try {
      await metadata.updateOne(
        { _id: 'encryption-v1' },
        { $setOnInsert: { keyVerifier: cipher.keyVerifier } },
        { upsert: true, ...mongoOperationOptions },
      );
    } catch (error) {
      if (!duplicateKey(error)) throw error;
    }
    const marker = await metadata.findOne({ _id: 'encryption-v1' }, mongoOperationOptions);
    if (marker?.keyVerifier !== cipher.keyVerifier) {
      context.logger.error({ event: 'news_encryption_key_mismatch' });
      throw new Error(
        'News deployment secret differs from stored key; restore the original secret',
      );
    }
  };

  const decrypt = async (document: NewsSubscriptionDocument) => {
    try {
      if (!document.destination) throw new NewsDecryptionError();
      return cipher.decrypt(document.destination, document._id, document.revision);
    } catch {
      const paused = await subscriptions.updateOne(
        {
          _id: document._id,
          revision: document.revision,
          enabled: true,
          pausedReason: { $ne: 'decryption-failed' },
        },
        { $set: { pausedReason: 'decryption-failed' } },
        mongoOperationOptions,
      );
      if (paused.modifiedCount)
        context.logger.error({ event: 'news_destination_decryption_failed' });
      throw new NewsDecryptionError();
    }
  };

  const inspect = async (document: NewsSubscriptionDocument) => {
    if (document.enabled) {
      try {
        await decrypt(document);
      } catch (error) {
        if (!(error instanceof NewsDecryptionError)) throw error;
        return { ...subscriptionView(document), pausedReason: 'decryption-failed' as const };
      }
    }
    return subscriptionView(document);
  };

  const configure: NewsSubscriptionStore['configure'] = async ({ feed, destination }) => {
    await initialize();
    if (
      !destination.guildId ||
      !destination.channelId ||
      (feed === 'continuous' && destination.notifyRoleId)
    )
      throw new Error('Invalid news destination configuration');
    const key = cipher.subscriptionKey(destination.guildId, feed);
    // CAS retries serialize competing configurations without allowing revision reuse.
    for (;;) {
      const previous = await subscriptions.findOne({ _id: key }, mongoOperationOptions);
      if (previous?.enabled && !previous.pausedReason) {
        try {
          const saved = await decrypt(previous);
          if (
            saved.guildId === destination.guildId &&
            saved.channelId === destination.channelId &&
            saved.notifyRoleId === destination.notifyRoleId
          )
            return subscriptionView(previous);
        } catch (error) {
          if (!(error instanceof NewsDecryptionError)) throw error;
          // An explicit configuration can replace corrupt ciphertext after permission validation.
        }
      }
      const activatedAt = now();
      const source =
        feed === 'continuous'
          ? await sources.findOne({ _id: 'dennikn' }, mongoOperationOptions)
          : null;
      const revision = (previous?.revision ?? 0) + 1;
      const document: NewsSubscriptionDocument = {
        _id: key,
        guildKey: cipher.guildKey(destination.guildId),
        feed,
        revision,
        enabled: true,
        activatedAt,
        baseline:
          feed === 'continuous'
            ? activateContinuousBaseline(source?.snapshot ?? null, activatedAt)
            : null,
        nextDeliveryAt: new Date(
          Math.max(+activatedAt, +(previous?.nextDeliveryAt ?? activatedAt)),
        ),
        destination: cipher.encrypt(destination, key, revision),
      };
      if (previous) {
        const result = await subscriptions.replaceOne(
          { _id: key, revision: previous.revision },
          document,
          mongoOperationOptions,
        );
        if (result.modifiedCount) return subscriptionView(document);
      } else {
        try {
          await subscriptions.insertOne(document, mongoOperationOptions);
          return subscriptionView(document);
        } catch (error) {
          if (!duplicateKey(error)) throw error;
        }
      }
    }
  };

  const disable: NewsSubscriptionStore['disable'] = async ({ guildId, feed }) => {
    await initialize();
    await subscriptions.updateOne(
      { _id: cipher.subscriptionKey(guildId, feed), enabled: true },
      {
        $set: { enabled: false, baseline: null },
        $inc: { revision: 1 },
        $unset: { destination: '', pausedReason: '' },
      },
      mongoOperationOptions,
    );
  };
  const removeGuild = async (guildId: string) => {
    await initialize();
    await subscriptions.updateMany(
      { guildKey: cipher.guildKey(guildId), enabled: true },
      {
        $set: { enabled: false, baseline: null },
        $inc: { revision: 1 },
        $unset: { destination: '', pausedReason: '' },
      },
      mongoOperationOptions,
    );
  };
  const getSubscription: NewsSubscriptionStore['getSubscription'] = async ({ guildId, feed }) => {
    await initialize();
    const document = await subscriptions.findOne(
      { _id: cipher.subscriptionKey(guildId, feed) },
      mongoOperationOptions,
    );
    return document ? inspect(document) : null;
  };
  const getDestination: NewsSubscriptionStore['getDestination'] = async ({
    subscriptionKey,
    revision,
  }) => {
    await initialize();
    const document = await subscriptions.findOne(
      { _id: subscriptionKey, revision, enabled: true },
      mongoOperationOptions,
    );
    return document ? decrypt(document) : null;
  };
  const listEnabled = async () => {
    await initialize();
    const documents = await subscriptions.find({ enabled: true }, mongoOperationOptions).toArray();
    return Promise.all(documents.map(inspect));
  };
  return {
    initialize,
    configure,
    disable,
    removeGuild,
    getSubscription,
    getDestination,
    listEnabled,
  } satisfies NewsSubscriptionStore & { initialize: () => Promise<void> };
};
