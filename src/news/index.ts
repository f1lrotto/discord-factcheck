import { setImmediate } from 'node:timers/promises';
import type { Logger } from 'pino';
import { mongoOperationTimeoutMs } from '../limits.js';
import { createAktualitySource } from './sources/aktuality.js';
import { createDenniknSource } from './sources/dennikn.js';
import type {
  NewsClock,
  NewsPublicationClaim,
  NewsPublisher,
  NewsPublishResult,
  NewsSource,
  NewsSourceResult,
  NewsStore,
} from './types.js';

const timeout = Symbol('news runtime deadline');
const bounded = async <T>(
  milliseconds: number,
  parent: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
  { preserveResultOnAbort = false } = {},
) => {
  parent.throwIfAborted();
  if (milliseconds <= 0) throw timeout;
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  const timer = setTimeout(() => controller.abort(timeout), milliseconds);
  timer.unref();
  let onAbort = () => {};
  let pending: Promise<T> | undefined;
  try {
    pending = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation(signal);
    });
    return await Promise.race([
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
      pending,
    ]);
  } catch (error) {
    // A publisher's drained result can establish acceptance or a known safe rejection.
    // Source callers instead retain the timeout/cancellation that ended collection.
    if (preserveResultOnAbort && signal.aborted && pending) return await pending;
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    controller.abort();
    // Production adapters honor cancellation. Drain their cleanup before Mongo/Discord closure.
    await pending?.catch(() => {});
  }
};

export const createNewsRuntime = ({
  store,
  publisher,
  logger,
  sources = [createDenniknSource(), createAktualitySource()],
  clock = () => new Date(),
  enabled = true,
  tickIntervalMs = 30_000,
  deliveryChunkSize = 10,
  collectionTimeoutMs = 40_000,
  sendTimeoutMs = 15_000,
}: {
  store: NewsStore;
  publisher: NewsPublisher;
  logger: Pick<Logger, 'info' | 'error'>;
  sources?: readonly NewsSource[];
  clock?: NewsClock;
  enabled?: boolean;
  tickIntervalMs?: number;
  deliveryChunkSize?: number;
  collectionTimeoutMs?: number;
  sendTimeoutMs?: number;
}) => {
  for (const [value, maximum] of [
    [tickIntervalMs, 60_000],
    [deliveryChunkSize, 100],
    [collectionTimeoutMs, 40_000],
    [sendTimeoutMs, 30_000],
  ] as const)
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum)
      throw new Error('Invalid news runtime limit');
  if (sources.length > 2 || new Set(sources.map(({ id }) => id)).size !== sources.length)
    throw new Error('News runtime sources must be unique');

  let lifetime = new AbortController();
  let active: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let running = false;
  let lifecycleRevision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const remaining = (deadline: Date) => +deadline - +clock() - mongoOperationTimeoutMs;
  const failed = (stage: string) => logger.error({ event: 'news_runtime_failed', stage });

  const collect = async (source: NewsSource, signal: AbortSignal) => {
    try {
      if (signal.aborted) return;
      const claim = await store.claimPoll(source.id);
      if (!claim || signal.aborted) return;
      const state = await store.getSource(source.id);
      let result: NewsSourceResult;
      try {
        result = await bounded(
          Math.min(collectionTimeoutMs, remaining(claim.lease.expiresAt)),
          signal,
          (signal) => source.collect({ now: clock(), cache: state.cache, signal }),
        );
      } catch (error) {
        result = {
          outcome: signal.aborted ? 'cancelled' : error === timeout ? 'timeout' : 'unavailable',
        };
      }
      // Drain persistence even during shutdown; slot consumption and failures survive restart.
      const committed = await store.commitPoll(claim, result);
      logger.info({
        event: 'news_collection_completed',
        source: source.id,
        outcome: result.outcome,
        committed,
      });
    } catch {
      failed('collection');
    }
  };

  const send = async (claim: NewsPublicationClaim, signal: AbortSignal) => {
    if (signal.aborted || !publisher.ready()) return;
    const destination = await store.beginSend(claim);
    if (!destination) return;
    let invoked = false;
    let result: NewsPublishResult;
    try {
      if (signal.aborted || !publisher.ready()) result = { outcome: 'rejected' };
      else
        result = await bounded(
          Math.min(
            sendTimeoutMs,
            remaining(claim.lease.expiresAt),
            +claim.publication.expiresAt - +clock(),
          ),
          signal,
          (signal) => {
            invoked = true;
            return publisher.publish({
              destination: claim.publication.manual
                ? { guildId: destination.guildId, channelId: destination.channelId }
                : destination,
              content: claim.publication.content,
              nonce: claim.publication.nonce,
              signal,
            });
          },
          { preserveResultOnAbort: true },
        );
    } catch {
      // Only a result from the publisher can establish safe rejection after invocation.
      result = { outcome: invoked ? 'uncertain' : 'rejected' };
    }
    await store.finishSend(claim, result);
    logger.info({ event: 'news_delivery_completed', outcome: result.outcome });
  };

  const runTick = async (signal: AbortSignal) => {
    const subscriptions = await store.listEnabled();
    if (signal.aborted || !subscriptions.length) return;
    let deliveriesSinceYield = 0;
    let deliveries = Promise.resolve();
    const deliver = () => {
      deliveries = deliveries.then(async () => {
        try {
          if (signal.aborted) return;
          await store.planPublications();
          while (!signal.aborted && publisher.ready()) {
            const claim = await store.claimPublication();
            if (!claim) break;
            await send(claim, signal);
            // Drain the complete ready batch, yielding between chunks for cancellation and I/O.
            if (++deliveriesSinceYield >= deliveryChunkSize) {
              deliveriesSinceYield = 0;
              await setImmediate();
            }
          }
        } catch {
          // A failed receipt remains sending for conservative store recovery.
          failed('delivery');
        }
      });
      return deliveries;
    };
    await Promise.all([
      deliver(),
      ...sources
        .filter(({ id }) =>
          subscriptions.some(
            (subscription) =>
              !subscription.pausedReason &&
              subscription.feed === (id === 'dennikn' ? 'continuous' : 'daily'),
          ),
        )
        .map(async (source) => {
          await collect(source, signal);
          await deliver();
        }),
    ]);
  };

  // Explicit ticks are useful for deterministic operation without starting a timer.
  const tick = () => {
    if (!enabled || lifetime.signal.aborted || stopping) return Promise.resolve();
    active ??= runTick(lifetime.signal)
      .catch(() => failed('tick'))
      .finally(() => {
        active = null;
      });
    return active;
  };
  const loop = (signal: AbortSignal) => {
    void tick().then(() => {
      if (!running || signal.aborted || signal !== lifetime.signal) return;
      timer = setTimeout(() => loop(signal), tickIntervalMs);
      timer.unref();
    });
  };
  const start = async () => {
    const requestedRevision = ++lifecycleRevision;
    await stopping;
    if (requestedRevision !== lifecycleRevision || !enabled || running) return;
    if (lifetime.signal.aborted) lifetime = new AbortController();
    running = true;
    loop(lifetime.signal);
  };
  const shutdown = () => {
    // Cancel every earlier start, including one waiting for an already-running shutdown.
    lifecycleRevision++;
    if (stopping) return stopping;
    running = false;
    clearTimeout(timer);
    lifetime.abort();
    stopping = Promise.resolve(active)
      .then(() => {})
      .finally(() => {
        stopping = null;
      });
    return stopping;
  };
  return { start, tick, shutdown };
};
