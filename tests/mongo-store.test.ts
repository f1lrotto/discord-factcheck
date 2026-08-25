import type { MongoClient } from 'mongodb';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { mongoOperationTimeoutMs, requestLeaseMs } from '../src/limits.js';
import { createMongoAccounting } from '../src/mongo-accounting.js';
import { mongoOperationOptions } from '../src/mongo-context.js';
import { createMongoStore, mongoClientOptions } from '../src/mongo-store.js';

describe('Mongo client policy', () => {
  it('bounds selection, connection, socket, and individual operations within the request lease', () => {
    expect(mongoClientOptions).toMatchObject({
      connectTimeoutMS: mongoOperationTimeoutMs,
      serverSelectionTimeoutMS: mongoOperationTimeoutMs,
      socketTimeoutMS: mongoOperationTimeoutMs,
    });
    expect(mongoOperationOptions).toEqual({ timeoutMS: mongoOperationTimeoutMs });
    for (const timeout of [
      mongoOperationOptions.timeoutMS,
      mongoClientOptions.connectTimeoutMS,
      mongoClientOptions.serverSelectionTimeoutMS,
      mongoClientOptions.socketTimeoutMS,
    ]) {
      expect(timeout).toBeTypeOf('number');
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThan(requestLeaseMs);
    }
  });

  it('drains a rejected production recovery before closing the injected client', async () => {
    let releaseScan: () => void = () => undefined;
    const scanReleased = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const cursor = {
      limit: () => cursor,
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await scanReleased;
          throw new Error('private recovery detail');
        },
      }),
    };
    const close = vi.fn(async () => undefined);
    const client = {
      db: () => ({
        collection: (name: string) => (name === 'requests' ? { find: () => cursor } : {}),
      }),
      close,
    } as unknown as MongoClient;
    const logger = pino({ enabled: false });
    const logError = vi.spyOn(logger, 'error');
    let accounting: ReturnType<typeof createMongoAccounting> | undefined;
    const store = createMongoStore(
      {
        uri: 'mongodb://unused',
        databaseName: 'jolanda',
        dailyLimitMicrodollars: 2_000_000,
        monthlyLimitMicrodollars: 10_000_000,
        promptsPerMinute: 3,
        transcriptTtlMs: 60_000,
        instanceId: 'instance',
        protectIdentifier: (value) => value,
        logger,
      },
      {
        client,
        createAccounting: (context, input) => {
          accounting = createMongoAccounting(context, input);
          return accounting;
        },
      },
    );
    if (!accounting) throw new Error('Accounting test seam was not initialized');

    void accounting.recoverExpiredRequests();
    const closing = store.close();
    releaseScan();
    await closing;

    expect(logError).toHaveBeenCalledWith({
      event: 'reservation_recovery_drain_failed',
      error: { type: 'Error', message: 'Unexpected error' },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(logError.mock.invocationCallOrder[0]).toBeLessThan(
      close.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });
});
