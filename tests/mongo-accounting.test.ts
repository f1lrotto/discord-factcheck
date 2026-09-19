import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createMongoAccounting } from '../src/mongo-accounting.js';
import type { MongoContext } from '../src/mongo-context.js';

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const accountingWithScan = (scan: () => Promise<void>) => {
  const logger = pino({ enabled: false });
  const cursor = {
    limit: vi.fn(() => cursor),
    [Symbol.asyncIterator]: () => {
      let scanned = false;
      return {
        next: async () => {
          if (!scanned) {
            scanned = true;
            await scan();
          }
          return { done: true as const, value: undefined };
        },
      };
    },
  };
  const context = {
    client: {},
    collections: { requests: { find: vi.fn(() => cursor) } },
    protectIdentifier: (value: string) => value,
    logger,
  } as unknown as MongoContext;
  const accounting = createMongoAccounting(context, {
    monthlyLimitMicrodollars: 10_000_000,
    promptsPerMinute: 3,
    transcriptTtlMs: 60_000,
    instanceId: 'instance',
  });
  return { accounting, cursor, logger };
};

describe('Mongo reservation recovery control', () => {
  it('shares one bounded sweep and waits for it during shutdown', async () => {
    const scan = deferred();
    const { accounting, cursor } = accountingWithScan(async () => {
      await scan.promise;
    });

    const first = accounting.recoverExpiredRequests();
    const overlapping = accounting.recoverExpiredRequests();
    let stopped = false;
    const stopping = accounting.stopRecovery().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(overlapping).toBe(first);
    expect(cursor.limit).toHaveBeenCalledOnce();
    expect(cursor.limit).toHaveBeenCalledWith(100);
    expect(stopped).toBe(false);

    scan.resolve();
    await Promise.all([first, stopping]);
    expect(stopped).toBe(true);
  });

  it('logs a rejected active sweep safely', async () => {
    const { accounting, logger } = accountingWithScan(async () => {
      throw new Error('private recovery detail');
    });
    const logError = vi.spyOn(logger, 'error');

    void accounting.recoverExpiredRequests();
    await accounting.stopRecovery();

    expect(logError).toHaveBeenCalledWith({
      event: 'reservation_recovery_drain_failed',
      error: { type: 'Error', message: 'Unexpected error' },
    });
  });
});
