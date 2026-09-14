import { randomBytes, randomUUID } from 'node:crypto';
import { MongoServerError, type ClientSession } from 'mongodb';
import { mongoOperationOptions, type MongoContext } from '../mongo-context.js';
import { mongoOperationTimeoutMs } from '../limits.js';
import { createNewsCipher, NewsDecryptionError } from './cipher.js';
import {
  activateContinuousBaseline,
  canAdmitSend,
  dailyCollectionSlot,
  dailySchedule,
  isCurrentDailyEdition,
  nextContinuousCollectionAt,
  nextContinuousDeliveryAt,
  observeStory,
  planContinuousPublication,
  planDailyPublication,
  safeRetryAt,
} from './policy.js';
import type {
  NewsClock,
  NewsContent,
  NewsObservation,
  NewsPublication,
  NewsSourceState,
  NewsSubscription,
  NewsSubscriptionRecord,
  NewsStore,
} from './types.js';

export type NewsSubscriptionDocument = Omit<NewsSubscriptionRecord, 'key'> & {
  _id: string;
  guildKey: string;
};
export type NewsSourceDocument = NewsSourceState & { _id: NewsSourceState['source'] };
export type NewsMetadataDocument = { _id: 'encryption-v1'; keyVerifier: string; fence?: number };
export type NewsObservationDocument = NewsObservation & { _id: string; retainedUntil: Date };
export type NewsPublicationDocument = Omit<NewsPublication, 'key' | 'content'> & {
  _id: string;
  content?: NewsContent;
  retainedUntil: Date;
};
export type NewsMongoOptions = { secret: string; clock?: NewsClock; leaseMs?: number };
const dayMs = 24 * 60 * 60_000;
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
const sourceView = (document: NewsSourceDocument) =>
  ({
    source: document.source,
    nextAttemptAt: document.nextAttemptAt,
    cache: document.cache,
    failures: document.failures,
    ...(document.snapshot ? { snapshot: document.snapshot } : {}),
    ...(document.daily ? { daily: document.daily } : {}),
    ...(document.lease ? { lease: document.lease } : {}),
    ...(document.backoffUntil ? { backoffUntil: document.backoffUntil } : {}),
    ...(document.lastOutcome ? { lastOutcome: document.lastOutcome } : {}),
    ...(document.lastSuccessAt ? { lastSuccessAt: document.lastSuccessAt } : {}),
  }) satisfies NewsSourceState;
const publicationView = (document: NewsPublicationDocument) => {
  if (!document.content) throw new Error('News publication payload missing');
  return {
    key: document._id,
    subscriptionKey: document.subscriptionKey,
    configurationRevision: document.configurationRevision,
    content: document.content,
    dueAt: document.dueAt,
    expiresAt: document.expiresAt,
    status: document.status,
    attempts: document.attempts,
    nonce: document.nonce,
    ...(document.lease ? { lease: document.lease } : {}),
    ...(document.messageKey ? { messageKey: document.messageKey } : {}),
  } satisfies NewsPublication;
};
const duplicateKey = (error: unknown) => error instanceof MongoServerError && error.code === 11000;
const dailyState = (source: NewsSourceState, instant: Date) => {
  const { date } = dailySchedule(instant);
  const keys = ['primary', 'fallback'].map((kind) => JSON.stringify(['aktuality', date, kind]));
  const edition = source.daily?.collectedEdition;
  return {
    attemptedSlots: (source.daily?.attemptedSlots ?? []).filter((key) => keys.includes(key)),
    ...(edition && isCurrentDailyEdition(edition, instant) ? { collectedEdition: edition } : {}),
  };
};
type Transaction = { session: ClientSession; events: Set<string>; deadline?: Date };
class LostLease extends Error {}

export const createMongoNews = (context: MongoContext, options: NewsMongoOptions) => {
  const {
    newsSubscriptions: subscriptions,
    newsSources: sources,
    newsMetadata: metadata,
    newsObservations: observations,
    newsPublications: publications,
  } = context.collections;
  const cipher = createNewsCipher(options.secret);
  const now = options.clock ?? (() => new Date());
  const leaseMs = options.leaseMs ?? 60_000;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0)
    throw new Error('News lease must be positive and finite');
  // Transaction statements inherit its overall timeout; the driver forbids per-call timeoutMS here.
  const dbOptions = (tx: Transaction) => ({ session: tx.session });
  const initialize = async () => {
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
  // Deliberately serialize short news transactions. A shared write fence prevents
  // source/configuration/admission write skew and phantoms during first activation.
  // HTTP and Discord calls never run within these transactions. Driver retries and
  // commit are bounded by the overall timeout, not just individual statements.
  const transaction = async <T>(work: (tx: Transaction) => Promise<T>) => {
    await initialize();
    let events = new Set<string>();
    const result = await context.client.withSession((session) =>
      session.withTransaction(
        async () => {
          events = new Set();
          const tx: Transaction = { session, events };
          await metadata.updateOne({ _id: 'encryption-v1' }, { $inc: { fence: 1 } }, dbOptions(tx));
          const result = await work(tx);
          if (tx.deadline && tx.deadline <= now()) throw new LostLease();
          return result;
        },
        { timeoutMS: mongoOperationTimeoutMs, maxCommitTimeMS: mongoOperationTimeoutMs },
      ),
    );
    events.forEach((event) => context.logger.error({ event }));
    return result;
  };
  const readDestination = async (document: NewsSubscriptionDocument, tx: Transaction) => {
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
        dbOptions(tx),
      );
      if (paused.modifiedCount) tx.events.add('news_destination_decryption_failed');
      return null;
    }
  };
  const inspect = async (document: NewsSubscriptionDocument, tx: Transaction) => {
    const failed = document.enabled && !(await readDestination(document, tx));
    return {
      ...subscriptionView(document),
      ...(failed ? { pausedReason: 'decryption-failed' as const } : {}),
    };
  };
  const cancelUnsent = async (key: string, tx: Transaction) => {
    await publications.updateMany(
      { subscriptionKey: key, status: { $in: ['pending', 'claimed'] } },
      { $set: { status: 'cancelled' }, $unset: { lease: '', content: '' } },
      dbOptions(tx),
    );
  };
  const configure: NewsStore['configure'] = ({ feed, destination }) =>
    transaction(async (tx) => {
      if (
        !destination.guildId ||
        !destination.channelId ||
        (feed === 'continuous' && destination.notifyRoleId)
      )
        throw new Error('Invalid news destination configuration');
      const key = cipher.subscriptionKey(destination.guildId, feed);
      const previous = await subscriptions.findOne({ _id: key }, dbOptions(tx));
      if (previous?.enabled && !previous.pausedReason) {
        const saved = await readDestination(previous, tx);
        if (
          saved &&
          saved.guildId === destination.guildId &&
          saved.channelId === destination.channelId &&
          saved.notifyRoleId === destination.notifyRoleId
        )
          return subscriptionView(previous);
      }
      const source =
        feed === 'continuous' ? await sources.findOne({ _id: 'dennikn' }, dbOptions(tx)) : null;
      const activatedAt = now();
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
      await subscriptions.replaceOne({ _id: key }, document, { upsert: true, ...dbOptions(tx) });
      await cancelUnsent(key, tx);
      return subscriptionView(document);
    });
  const disableRecord = async (document: NewsSubscriptionDocument, tx: Transaction) => {
    await subscriptions.updateOne(
      { _id: document._id, enabled: true },
      {
        $set: { enabled: false, baseline: null },
        $inc: { revision: 1 },
        $unset: { destination: '', pausedReason: '' },
      },
      dbOptions(tx),
    );
    await cancelUnsent(document._id, tx);
  };
  const disable: NewsStore['disable'] = ({ guildId, feed }) =>
    transaction(async (tx) => {
      const document = await subscriptions.findOne(
        { _id: cipher.subscriptionKey(guildId, feed) },
        dbOptions(tx),
      );
      if (document) await disableRecord(document, tx);
    });
  const removeGuild = (guildId: string) =>
    transaction(async (tx) => {
      const documents = await subscriptions
        .find({ guildKey: cipher.guildKey(guildId) }, dbOptions(tx))
        .toArray();
      for (const document of documents) await disableRecord(document, tx);
    });
  const getSubscription: NewsStore['getSubscription'] = ({ guildId, feed }) =>
    transaction(async (tx) => {
      const document = await subscriptions.findOne(
        { _id: cipher.subscriptionKey(guildId, feed) },
        dbOptions(tx),
      );
      return document ? inspect(document, tx) : null;
    });
  const getDestination: NewsStore['getDestination'] = async ({ subscriptionKey, revision }) => {
    const result = await transaction(async (tx) => {
      const document = await subscriptions.findOne(
        { _id: subscriptionKey, revision, enabled: true },
        dbOptions(tx),
      );
      return {
        exists: Boolean(document),
        destination: document ? await readDestination(document, tx) : null,
      };
    });
    if (result.exists && !result.destination) throw new NewsDecryptionError();
    return result.destination;
  };
  const listEnabled = () =>
    transaction(async (tx) => {
      const documents = await subscriptions.find({ enabled: true }, dbOptions(tx)).toArray();
      const result: NewsSubscription[] = [];
      for (const document of documents) result.push(await inspect(document, tx));
      return result;
    });
  const readSource = async (source: NewsSourceState['source'], tx: Transaction) =>
    (await sources.findOne({ _id: source }, dbOptions(tx))) ?? {
      _id: source,
      source,
      nextAttemptAt: new Date(0),
      cache: {},
      failures: 0,
    };
  const getSource: NewsStore['getSource'] = (source) =>
    transaction(async (tx) => sourceView(await readSource(source, tx)));
  const claimPoll: NewsStore['claimPoll'] = (source) =>
    transaction(async (tx) => {
      const feed = source === 'dennikn' ? 'continuous' : 'daily';
      if (
        !(await subscriptions.findOne(
          { feed, enabled: true, pausedReason: { $exists: false } },
          dbOptions(tx),
        ))
      )
        return null;
      const state = await readSource(source, tx);
      const instant = now();
      if (
        (state.lease && state.lease.expiresAt > instant) ||
        state.nextAttemptAt > instant ||
        (state.backoffUntil && state.backoffUntil > instant)
      )
        return null;
      const daily = dailyState(state, instant);
      const slot =
        source === 'aktuality' ? dailyCollectionSlot(instant, daily, state.backoffUntil) : null;
      if (source === 'aktuality' && !slot) return null;
      const lease = { owner: randomUUID(), expiresAt: new Date(+instant + leaseMs) };
      const updated: NewsSourceDocument = {
        ...state,
        lease,
        nextAttemptAt: slot
          ? slot.expiresAt
          : nextContinuousCollectionAt(instant, state.backoffUntil),
        ...(slot
          ? { daily: { ...daily, attemptedSlots: [...daily.attemptedSlots, slot.key] } }
          : {}),
      };
      await sources.replaceOne({ _id: source }, updated, { upsert: true, ...dbOptions(tx) });
      return { source, lease, ...(slot ? { slot } : {}) };
    });
  const commitPoll: NewsStore['commitPoll'] = async (claim, result) => {
    try {
      return await transaction(async (tx) => {
        const state = await readSource(claim.source, tx);
        const instant = now();
        if (
          !state.lease ||
          state.lease.owner !== claim.lease.owner ||
          +state.lease.expiresAt !== +claim.lease.expiresAt ||
          state.lease.expiresAt <= instant
        )
          return false;
        tx.deadline = state.lease.expiresAt;
        const successful = 'cache' in result;
        const failures = successful ? 0 : Math.min(state.failures + 1, 30);
        const backoffUntil = successful
          ? undefined
          : new Date(
              Math.max(
                +instant + Math.min(60 * 60_000, 60_000 * 2 ** (failures - 1)),
                +('retryAt' in result && result.retryAt ? result.retryAt : instant),
              ),
            );
        const updated: NewsSourceDocument = { ...state, failures, lastOutcome: result.outcome };
        delete updated.lease;
        if (backoffUntil) updated.backoffUntil = backoffUntil;
        else delete updated.backoffUntil;
        if (claim.source === 'dennikn' && backoffUntil)
          updated.nextAttemptAt = new Date(Math.max(+updated.nextAttemptAt, +backoffUntil));
        if (successful) {
          updated.cache = result.cache;
          updated.lastSuccessAt = instant;
        }
        if (
          claim.source === 'dennikn' &&
          (result.outcome === 'stories' ||
            result.outcome === 'unchanged' ||
            result.outcome === 'empty')
        ) {
          const snapshot = { sequence: (state.snapshot?.sequence ?? 0) + 1, collectedAt: instant };
          updated.snapshot = snapshot;
          if (result.outcome === 'stories')
            for (const story of result.stories) {
              const key = JSON.stringify([story.source, story.id]);
              const previous = await observations.findOne({ _id: key }, dbOptions(tx));
              const observation = observeStory(story, snapshot, previous ?? undefined);
              await observations.replaceOne(
                { _id: key },
                { ...observation, retainedUntil: new Date(+instant + 7 * dayMs) },
                { upsert: true, ...dbOptions(tx) },
              );
            }
          await subscriptions.updateMany(
            { feed: 'continuous', enabled: true, baseline: null },
            { $set: { baseline: snapshot } },
            dbOptions(tx),
          );
        }
        if (claim.source === 'aktuality') {
          updated.daily = dailyState(state, instant);
          if (result.outcome === 'edition' && isCurrentDailyEdition(result.edition, instant))
            updated.daily.collectedEdition = result.edition;
        }
        // Roll back observations/baselines as well if processing consumed the poll lease.
        if (state.lease.expiresAt <= now()) throw new LostLease();
        const saved = await sources.replaceOne(
          {
            _id: claim.source,
            'lease.owner': claim.lease.owner,
            'lease.expiresAt': { $gt: now() },
          },
          updated,
          dbOptions(tx),
        );
        if (!saved.modifiedCount) throw new LostLease();
        return true;
      });
    } catch (error) {
      if (error instanceof LostLease) return false;
      throw error;
    }
  };
  const recover = async (tx: Transaction) => {
    const instant = now();
    await publications.updateMany(
      { status: 'sending', 'lease.expiresAt': { $lte: instant } },
      { $set: { status: 'uncertain' }, $unset: { lease: '', content: '' } },
      dbOptions(tx),
    );
    await publications.updateMany(
      { status: { $in: ['pending', 'claimed'] }, expiresAt: { $lte: instant } },
      { $set: { status: 'expired' }, $unset: { lease: '', content: '' } },
      dbOptions(tx),
    );
    await publications.updateMany(
      { status: 'claimed', 'lease.expiresAt': { $lte: instant } },
      { $set: { status: 'pending' }, $unset: { lease: '' } },
      dbOptions(tx),
    );
  };
  const planPublications = () =>
    transaction(async (tx) => {
      await recover(tx);
      const instant = now();
      const active = await subscriptions
        .find({ enabled: true, pausedReason: { $exists: false } }, dbOptions(tx))
        .toArray();
      const source = await readSource('aktuality', tx);
      const edition = dailyState(source, instant).collectedEdition;
      const items = await observations
        .find({ retainedUntil: { $gt: instant } }, dbOptions(tx))
        .toArray();
      for (const subscription of active) {
        const existing = await publications
          .find({ subscriptionKey: subscription._id }, dbOptions(tx))
          .toArray();
        if (
          subscription.feed === 'continuous' &&
          existing.some((value) => ['pending', 'claimed', 'sending'].includes(value.status))
        )
          continue;
        const reserved = new Set(
          existing.filter((value) => value.status !== 'cancelled').map((value) => value._id),
        );
        const view = subscriptionView(subscription);
        const draft =
          subscription.feed === 'continuous'
            ? planContinuousPublication(view, items, instant, reserved)
            : edition
              ? planDailyPublication(view, edition, instant, reserved)
              : null;
        if (!draft) continue;
        const previous = existing.find((value) => value._id === draft.key);
        const document: NewsPublicationDocument = {
          _id: draft.key,
          subscriptionKey: draft.subscriptionKey,
          configurationRevision: draft.configurationRevision,
          content: draft.content,
          dueAt: draft.dueAt,
          expiresAt: draft.expiresAt,
          status: 'pending',
          attempts: previous?.attempts ?? 0,
          nonce: previous?.nonce ?? randomBytes(12).toString('hex'),
          retainedUntil: new Date(+draft.expiresAt + 30 * dayMs),
        };
        await publications.replaceOne({ _id: draft.key }, document, {
          upsert: true,
          ...dbOptions(tx),
        });
      }
    });
  const claimPublication: NewsStore['claimPublication'] = () =>
    transaction(async (tx) => {
      await recover(tx);
      for (;;) {
        const instant = now();
        const document = await publications.findOne(
          { status: 'pending', dueAt: { $lte: instant }, expiresAt: { $gt: instant } },
          { sort: { dueAt: 1, _id: 1 }, ...dbOptions(tx) },
        );
        if (!document) return null;
        const subscription = await subscriptions.findOne(
          { _id: document.subscriptionKey },
          dbOptions(tx),
        );
        if (
          !subscription?.enabled ||
          subscription.pausedReason ||
          subscription.revision !== document.configurationRevision
        ) {
          await publications.updateOne(
            { _id: document._id },
            { $set: { status: 'cancelled' }, $unset: { content: '' } },
            dbOptions(tx),
          );
          continue;
        }
        if (subscription.feed === 'continuous' && subscription.nextDeliveryAt > instant) {
          await publications.updateOne(
            { _id: document._id },
            { $set: { dueAt: subscription.nextDeliveryAt } },
            dbOptions(tx),
          );
          continue;
        }
        const lease = { owner: randomUUID(), expiresAt: new Date(+instant + leaseMs) };
        const claimed = { ...document, status: 'claimed' as const, lease };
        await publications.replaceOne({ _id: document._id }, claimed, dbOptions(tx));
        return { publication: publicationView(claimed), lease };
      }
    });
  const ownedPublication = async (claim: Parameters<NewsStore['beginSend']>[0], tx: Transaction) =>
    publications.findOne(
      {
        _id: claim.publication.key,
        'lease.owner': claim.lease.owner,
        'lease.expiresAt': { $eq: claim.lease.expiresAt, $gt: now() },
      },
      dbOptions(tx),
    );
  const beginSend: NewsStore['beginSend'] = (claim) =>
    transaction(async (tx) => {
      await recover(tx);
      const document = await ownedPublication(claim, tx);
      if (!document || document.status !== 'claimed') return null;
      const subscription = await subscriptions.findOne(
        { _id: document.subscriptionKey },
        dbOptions(tx),
      );
      if (
        !subscription ||
        !canAdmitSend(publicationView(document), subscriptionView(subscription), now())
      ) {
        const paced =
          subscription?.enabled &&
          !subscription.pausedReason &&
          subscription.revision === document.configurationRevision &&
          document.expiresAt > now();
        await publications.updateOne(
          { _id: document._id },
          {
            $set: {
              status: paced ? 'pending' : 'cancelled',
              ...(paced ? { dueAt: subscription.nextDeliveryAt } : {}),
            },
            $unset: { lease: '', ...(!paced ? { content: '' } : {}) },
          },
          dbOptions(tx),
        );
        return null;
      }
      const destination = await readDestination(subscription, tx);
      if (!destination) {
        await cancelUnsent(subscription._id, tx);
        return null;
      }
      const instant = now();
      if (
        document.lease!.expiresAt <= instant ||
        !canAdmitSend(publicationView(document), subscriptionView(subscription), instant)
      )
        return null;
      tx.deadline = new Date(Math.min(+document.lease!.expiresAt, +document.expiresAt));
      await publications.updateOne(
        { _id: document._id },
        {
          $set: { status: 'sending' },
          $inc: { attempts: 1 },
        },
        dbOptions(tx),
      );
      // This write shares the transaction/fence with configure/disable and the outbox.
      // The persisted sending transition is the point after which a crash is uncertain.
      if (subscription.feed === 'continuous')
        await subscriptions.updateOne(
          { _id: subscription._id },
          { $set: { nextDeliveryAt: nextContinuousDeliveryAt(instant) } },
          dbOptions(tx),
        );
      return destination;
    }).catch((error: unknown) => {
      if (error instanceof LostLease) return null;
      throw error;
    });
  const finishSend: NewsStore['finishSend'] = (claim, result) =>
    transaction(async (tx) => {
      await recover(tx);
      const document = await ownedPublication(claim, tx);
      if (!document || document.status !== 'sending') return;
      tx.deadline = document.lease!.expiresAt;
      const instant = now();
      if (result.outcome === 'rejected') {
        const retryAt = safeRetryAt(
          publicationView(document),
          instant,
          Math.max(60_000, +(result.retryAt ?? instant) - +instant),
        );
        await publications.updateOne(
          { _id: document._id },
          {
            $set: {
              status: retryAt ? 'pending' : 'expired',
              ...(retryAt ? { dueAt: retryAt } : {}),
            },
            $unset: { lease: '', ...(!retryAt ? { content: '' } : {}) },
          },
          dbOptions(tx),
        );
        return;
      }
      if (result.outcome === 'destination-unavailable') {
        await subscriptions.updateOne(
          {
            _id: document.subscriptionKey,
            revision: document.configurationRevision,
            enabled: true,
          },
          { $set: { pausedReason: 'destination-unavailable' } },
          dbOptions(tx),
        );
      }
      await publications.updateOne(
        { _id: document._id },
        {
          $set: {
            status:
              result.outcome === 'sent'
                ? 'sent'
                : result.outcome === 'uncertain'
                  ? 'uncertain'
                  : 'cancelled',
            ...(result.outcome === 'sent'
              ? { messageKey: cipher.messageKey(result.messageId) }
              : {}),
          },
          $unset: { lease: '', content: '' },
        },
        dbOptions(tx),
      );
    }).catch((error: unknown) => {
      if (!(error instanceof LostLease)) throw error;
    });
  const getDeliveryCounts: NewsStore['getDeliveryCounts'] = (subscriptionKey) =>
    transaction(async (tx) => {
      await recover(tx);
      const pending = await publications.countDocuments(
        { subscriptionKey, status: { $in: ['pending', 'claimed', 'sending'] } },
        dbOptions(tx),
      );
      const uncertain = await publications.countDocuments(
        { subscriptionKey, status: 'uncertain' },
        dbOptions(tx),
      );
      return { pending, uncertain };
    });
  return {
    initialize,
    configure,
    disable,
    removeGuild,
    getSubscription,
    getDestination,
    listEnabled,
    getSource,
    claimPoll,
    commitPoll,
    planPublications,
    claimPublication,
    beginSend,
    finishSend,
    getDeliveryCounts,
  } satisfies NewsStore & { initialize: () => Promise<void> };
};
