import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { modelSupportsReasoning } from '../src/models.js';
import { createMongoStore } from '../src/mongo-store.js';
import { createIdentifierProtector } from '../src/security.js';
import type { JolandaStore, Usage } from '../src/types.js';

const protectIdentifier = createIdentifierProtector('test-data-protection-secret-value');
const logger = pino({ enabled: false });
const usage = (costMicrodollars: number): Usage => ({
  costMicrodollars,
  promptTokens: 10,
  completionTokens: 5,
  reasoningTokens: 2,
  webSearchRequests: 0,
});

describe('Mongo store integration', () => {
  let replicaSet: MongoMemoryReplSet;
  let uri: string;
  let databaseName: string;
  const stores: JolandaStore[] = [];

  beforeAll(async () => {
    replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    uri = replicaSet.getUri();
  }, 60_000);

  beforeEach(() => {
    databaseName = `jolanda-test-${randomUUID()}`;
  });

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
    const client = new MongoClient(uri);
    await client.connect();
    await client.db(databaseName).dropDatabase();
    await client.close();
  });

  afterAll(async () => replicaSet.stop());

  const createStore = async (
    overrides: Partial<{
      dailyLimitMicrodollars: number;
      monthlyLimitMicrodollars: number;
      promptsPerMinute: number;
      instanceId: string;
      requestLeaseMs: number;
      recoveryIntervalMs: number;
    }> = {},
  ) => {
    const store = createMongoStore({
      uri,
      databaseName,
      dailyLimitMicrodollars: 2_000_000,
      monthlyLimitMicrodollars: 10_000_000,
      promptsPerMinute: 3,
      transcriptTtlMs: 7 * 24 * 60 * 60 * 1_000,
      instanceId: 'instance',
      protectIdentifier,
      logger,
      recoveryIntervalMs: 60 * 60_000,
      ...overrides,
    });
    await store.initialize();
    stores.push(store);
    return store;
  };

  const authorize = (
    store: JolandaStore,
    requestId: string,
    input: Partial<{ userId: string; now: Date; reservationMicrodollars: number }> = {},
  ) =>
    store.authorizeTurn({
      requestId,
      guildId: 'raw-guild-id',
      channelId: 'raw-channel-id',
      userId: input.userId ?? 'raw-user-id',
      reservationMicrodollars: input.reservationMicrodollars ?? 200_000,
      now: input.now ?? new Date(),
    });

  it('stores channel settings separately and atomically claims Reel deliveries across replicas', async () => {
    const first = await createStore();
    const second = await createStore({ instanceId: 'second' });
    const scope = { guildId: 'raw-guild', channelId: 'raw-channel' };
    expect(await first.reels.getEnabled(scope)).toBe(false);
    await first.reels.setEnabled(scope, true);
    expect(await second.reels.getEnabled(scope)).toBe(true);
    expect(await first.reels.getEnabled({ ...scope, channelId: 'other' })).toBe(false);
    expect(await first.reels.getEnabled({ ...scope, guildId: 'other' })).toBe(false);
    const event = { ...scope, messageId: 'raw-source', shortcode: 'sample' };
    const claims = await Promise.all([first.reels.claim(event), second.reels.claim(event)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find((value) => value !== null)!;
    expect(
      await first.reels.transition({ ...claim, owner: 'wrong' }, 'processing', 'publishing'),
    ).toBe(false);
    expect(await first.reels.transition(claim, 'processing', 'publishing')).toBe(true);
    expect(await second.reels.claim(event)).toBeNull();
    expect(await first.reels.transition(claim, 'publishing', 'uncertain', 'uncertain')).toBe(true);
    expect(await second.reels.claim(event)).toBeNull();
    expect(
      await second.reels.claim({ ...event, messageId: 'later-deliberate-post' }),
    ).not.toBeNull();
    await first.reels.setEnabled(scope, false);
    expect(await second.reels.getEnabled(scope)).toBe(false);
    const client = new MongoClient(uri);
    await client.connect();
    try {
      const documents = await client
        .db(databaseName)
        .collection('reel_deliveries')
        .find()
        .toArray();
      expect(JSON.stringify(documents)).not.toMatch(/raw-guild|raw-channel|raw-source|sample/);
      const indexes = await client.db(databaseName).collection('reel_deliveries').indexes();
      expect(indexes.some((index) => index.expireAfterSeconds === 0)).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('checks Reel claim expiry before asynchronous TTL deletion and never reclaims publishing leases', async () => {
    const store = await createStore();
    const event = {
      guildId: 'guild',
      channelId: 'channel',
      messageId: 'source',
      shortcode: 'sample',
    };
    const client = new MongoClient(uri);
    await client.connect();
    try {
      const deliveries = client.db(databaseName).collection('reel_deliveries');
      const claim = (await store.reels.claim(event))!;
      await deliveries.updateOne(
        { _id: claim.key as never },
        { $set: { leaseExpiresAt: new Date(0) } },
      );
      expect(await store.reels.transition(claim, 'processing', 'publishing')).toBe(false);
      const reclaimed = (await store.reels.claim(event))!;
      expect(reclaimed.owner).not.toBe(claim.owner);
      expect(await store.reels.transition(claim, 'processing', 'failed')).toBe(false);
      await store.reels.transition(reclaimed, 'processing', 'publishing');
      await deliveries.updateOne(
        { _id: claim.key as never },
        { $set: { leaseExpiresAt: new Date(0) } },
      );
      expect(await store.reels.claim(event)).toBeNull();
      await store.reels.transition(reclaimed, 'publishing', 'sent', 'sent', 'raw-delivered');
      expect(await store.reels.claim(event)).toBeNull();
      const stored = await deliveries.findOne({ _id: claim.key as never });
      expect(JSON.stringify(stored)).not.toContain('raw-delivered');
      await deliveries.updateOne({ _id: claim.key as never }, { $set: { expiresAt: new Date(0) } });
      expect(await store.reels.claim(event)).not.toBeNull();
    } finally {
      await client.close();
    }
  });

  it('enforces rolling rate limits and request deduplication transactionally', async () => {
    const store = await createStore();
    const start = new Date('2026-08-25T10:00:00.000Z');

    for (let index = 0; index < 3; index += 1) {
      await expect(
        authorize(store, `request-${index}`, {
          now: new Date(start.getTime() + index * 1_000),
        }),
      ).resolves.toEqual({ ok: true });
    }
    await expect(
      authorize(store, 'request-3', { now: new Date(start.getTime() + 3_000) }),
    ).resolves.toEqual({ ok: false, reason: 'rate_limited' });
    await expect(
      authorize(store, 'request-0', { userId: 'another-user', now: start }),
    ).resolves.toEqual({ ok: false, reason: 'duplicate' });
    await expect(
      authorize(store, 'request-at-window', {
        now: new Date(start.getTime() + 60_000),
      }),
    ).resolves.toEqual({ ok: true });
  });

  it('reserves concurrent worst-case costs without crossing the daily cap', async () => {
    const store = await createStore({ dailyLimitMicrodollars: 400_000 });
    const results = await Promise.all(
      ['one', 'two', 'three'].map((requestId) =>
        authorize(store, requestId, { userId: requestId, reservationMicrodollars: 200_000 }),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: 'daily_budget' }]);
    const budget = await store.getBudgetSummary('raw-guild-id', new Date());
    expect(budget.dailyReservedMicrodollars).toBe(400_000);
  });

  it('replaces reservations with exact or conservative usage', async () => {
    const store = await createStore();
    await authorize(store, 'exact');
    await authorize(store, 'missing', { userId: 'other' });

    await store.settleRequest({ requestId: 'exact', usage: usage(150_000), status: 'completed' });
    await store.settleRequest({
      requestId: 'missing',
      usage: usage(200_000),
      status: 'usage_missing',
    });

    const budget = await store.getBudgetSummary('raw-guild-id', new Date());
    expect(budget.dailyUsedMicrodollars).toBe(350_000);
    expect(budget.dailyReservedMicrodollars).toBe(0);
    expect(budget.monthlyUsedMicrodollars).toBe(350_000);
  });

  it('settles concurrent duplicate callbacks exactly once without a negative reservation', async () => {
    const store = await createStore();
    await authorize(store, 'concurrent-settlement');

    await Promise.all(
      Array.from({ length: 5 }, () =>
        store.settleRequest({
          requestId: 'concurrent-settlement',
          usage: usage(150_000),
          status: 'completed',
        }),
      ),
    );

    const budget = await store.getBudgetSummary('raw-guild-id', new Date());
    expect(budget).toMatchObject({
      dailyUsedMicrodollars: 150_000,
      dailyReservedMicrodollars: 0,
      monthlyUsedMicrodollars: 150_000,
      monthlyReservedMicrodollars: 0,
    });
  });

  it('charges the reservation when direct settlement receives a non-finite cost', async () => {
    const store = await createStore();
    await authorize(store, 'invalid-cost');

    await store.settleRequest({
      requestId: 'invalid-cost',
      usage: usage(Number.POSITIVE_INFINITY),
      status: 'completed',
    });

    await expect(store.getBudgetSummary('raw-guild-id', new Date())).resolves.toMatchObject({
      dailyUsedMicrodollars: 200_000,
      dailyReservedMicrodollars: 0,
      monthlyUsedMicrodollars: 200_000,
      monthlyReservedMicrodollars: 0,
    });
  });

  it('serializes exact settlement against expired-request recovery', async () => {
    const first = await createStore({ instanceId: 'first', requestLeaseMs: 1_000 });
    await authorize(first, 'settlement-recovery-race', {
      now: new Date(Date.now() - 2_000),
    });

    const [, replacement] = await Promise.all([
      first.settleRequest({
        requestId: 'settlement-recovery-race',
        usage: usage(120_000),
        status: 'completed',
      }),
      createStore({ instanceId: 'replacement', requestLeaseMs: 1_000 }),
    ]);
    const budget = await replacement.getBudgetSummary('raw-guild-id', new Date());

    expect([120_000, 200_000]).toContain(budget.dailyUsedMicrodollars);
    expect(budget.dailyReservedMicrodollars).toBe(0);
    expect(budget.monthlyUsedMicrodollars).toBe(budget.dailyUsedMicrodollars);
    expect(budget.monthlyReservedMicrodollars).toBe(0);
  });

  it('enforces monthly limits independently and releases failed pre-inference reservations', async () => {
    const store = await createStore({
      dailyLimitMicrodollars: 2_000_000,
      monthlyLimitMicrodollars: 300_000,
    });
    await expect(authorize(store, 'first', { reservationMicrodollars: 200_000 })).resolves.toEqual({
      ok: true,
    });
    await expect(
      authorize(store, 'second', {
        userId: 'other',
        reservationMicrodollars: 200_000,
      }),
    ).resolves.toEqual({ ok: false, reason: 'monthly_budget' });

    await store.failRequest('first', 'before_inference');
    const budget = await store.getBudgetSummary('raw-guild-id', new Date());
    expect(budget).toMatchObject({
      dailyUsedMicrodollars: 0,
      dailyReservedMicrodollars: 0,
      monthlyUsedMicrodollars: 0,
      monthlyReservedMicrodollars: 0,
    });
  });

  it('serializes concurrent settings changes and preserves valid model reasoning', async () => {
    const store = await createStore();
    const updates = await Promise.allSettled([
      store.updateSettings('raw-guild-id', {
        model: 'deepseek-v4-flash',
        reasoning: 'high',
      }),
      store.updateSettings('raw-guild-id', { contextLimitMessages: 20 }),
    ]);
    const settings = await store.getSettings('raw-guild-id');

    expect(updates).toEqual([
      expect.objectContaining({ status: 'fulfilled' }),
      expect.objectContaining({ status: 'fulfilled' }),
    ]);
    expect(settings).toMatchObject({
      model: 'deepseek-v4-flash',
      reasoning: 'high',
      contextLimitMessages: 20,
    });
    expect(modelSupportsReasoning(settings.model, settings.reasoning)).toBe(true);
  });

  it('reads the legacy ambient-context setting as the new per-turn limit and migrates it on update', async () => {
    const store = await createStore();
    const client = new MongoClient(uri);
    await client.connect();
    const settingsCollection = client.db(databaseName).collection<{
      _id: string;
      model: string;
      reasoning: string;
      contextMessages?: number;
      contextLimitMessages?: number;
      updatedAt: Date;
    }>('guild_settings');
    await settingsCollection.insertOne({
      _id: protectIdentifier('raw-guild-id'),
      model: 'deepseek-v4-flash',
      reasoning: 'high',
      contextMessages: 12,
      updatedAt: new Date(),
    });

    await expect(store.getSettings('raw-guild-id')).resolves.toMatchObject({
      contextLimitMessages: 12,
    });
    await store.updateSettings('raw-guild-id', { reasoning: 'low' });
    const migrated = await settingsCollection.findOne({
      _id: protectIdentifier('raw-guild-id'),
    });
    await client.close();

    expect(migrated).toMatchObject({ contextLimitMessages: 12 });
    expect(migrated).not.toHaveProperty('contextMessages');
  });

  it('rejects invalid model, reasoning, and context-limit settings inside the transaction', async () => {
    const store = await createStore();

    await expect(
      store.updateSettings('raw-guild-id', {
        model: 'deepseek-v4-flash',
        reasoning: 'medium',
      }),
    ).rejects.toThrow('does not support');
    await expect(store.getSettings('raw-guild-id')).resolves.toMatchObject({
      model: 'glm-5.3-flash',
      reasoning: 'high',
    });
    await expect(
      store.updateSettings('raw-guild-id', { contextLimitMessages: -1 }),
    ).rejects.toThrow('non-negative safe integer');
  });

  it('owner-binds conversations, scopes links, and stores only pseudonymous identifiers', async () => {
    const store = await createStore();
    const expiresAt = new Date(Date.now() + 60_000);
    await store.appendTurn({
      conversationId: 'conversation',
      guildId: 'raw-guild-id',
      channelId: 'raw-channel-id',
      ownerId: 'raw-user-id',
      requestId: 'raw-request-id',
      assistantMessageIds: ['raw-message-id'],
      turn: { userContent: 'hello', assistantContent: 'hi', createdAt: new Date() },
      expiresAt,
    });

    const conversation = await store.findConversationByMessage({
      messageId: 'raw-message-id',
      guildId: 'raw-guild-id',
      channelId: 'raw-channel-id',
    });
    expect(conversation).toMatchObject({
      id: 'conversation',
      ownerKey: protectIdentifier('raw-user-id'),
      replyCount: 1,
    });
    await expect(
      store.findConversationByMessage({
        messageId: 'raw-message-id',
        guildId: 'raw-guild-id',
        channelId: 'different-channel',
      }),
    ).resolves.toBeNull();

    await authorize(store, 'raw-accounting-request-id', { userId: 'raw-accounting-user-id' });
    await store.updateSettings('raw-guild-id', { contextLimitMessages: 10 });
    await store.tryLockConversation('conversation', 'raw-lock-token', new Date());

    const client = new MongoClient(uri);
    await client.connect();
    const database = client.db(databaseName);
    const collectionNames = (await database.listCollections().toArray()).map(({ name }) => name);
    const dump = JSON.stringify(
      await Promise.all(collectionNames.map((name) => database.collection(name).find().toArray())),
    );
    await client.close();
    expect(dump).not.toContain('raw-guild-id');
    expect(dump).not.toContain('raw-channel-id');
    expect(dump).not.toContain('raw-user-id');
    expect(dump).not.toContain('raw-request-id');
    expect(dump).not.toContain('raw-message-id');
    expect(dump).not.toContain('raw-accounting-request-id');
    expect(dump).not.toContain('raw-accounting-user-id');
    expect(dump).not.toContain('raw-lock-token');
  });

  it('deduplicates, owner-binds, caps, and locks conversations', async () => {
    const store = await createStore();
    const expiresAt = new Date(Date.now() + 60_000);
    const turn = {
      conversationId: 'conversation',
      guildId: 'raw-guild-id',
      channelId: 'raw-channel-id',
      ownerId: 'raw-user-id',
      requestId: 'request-one',
      assistantMessageIds: ['message-one'],
      turn: { userContent: 'hello', assistantContent: 'hi', createdAt: new Date() },
      expiresAt,
    };
    await store.appendTurn(turn);
    await store.appendTurn(turn);

    const conversation = await store.findConversationByMessage({
      messageId: 'message-one',
      guildId: 'raw-guild-id',
      channelId: 'raw-channel-id',
    });
    expect(conversation?.replyCount).toBe(1);

    await expect(
      store.appendTurn({
        ...turn,
        ownerId: 'different-owner',
        requestId: 'different-owner-request',
      }),
    ).rejects.toThrow('scope or owner changed');

    for (let index = 2; index <= 10; index += 1) {
      await store.appendTurn({
        ...turn,
        requestId: `request-${index}`,
        assistantMessageIds: [`message-${index}`],
        turn: {
          userContent: `question ${index}`,
          assistantContent: `answer ${index}`,
          createdAt: new Date(Date.now() + index),
        },
      });
    }
    await expect(
      store.appendTurn({
        ...turn,
        requestId: 'request-11',
        assistantMessageIds: ['message-11'],
      }),
    ).rejects.toThrow('maximum turn count');
    await expect(
      store.findConversationByMessage({
        messageId: 'message-10',
        guildId: 'raw-guild-id',
        channelId: 'raw-channel-id',
      }),
    ).resolves.toMatchObject({ replyCount: 10 });

    const now = new Date();
    await expect(store.tryLockConversation('conversation', 'lock-one', now)).resolves.toBe(true);
    await expect(store.tryLockConversation('conversation', 'lock-one', now)).resolves.toBe(false);
    await expect(store.tryLockConversation('conversation', 'lock-two', now)).resolves.toBe(false);
    await store.releaseConversation('conversation', 'wrong-lock');
    await expect(store.tryLockConversation('conversation', 'lock-two', now)).resolves.toBe(false);
    await store.releaseConversation('conversation', 'lock-one');
    await expect(store.tryLockConversation('conversation', 'lock-two', now)).resolves.toBe(true);
  });

  it('uses independent UTC budget buckets after a day boundary', async () => {
    const store = await createStore({ dailyLimitMicrodollars: 200_000 });
    const beforeMidnight = new Date('2026-08-25T23:59:59.000Z');
    const afterMidnight = new Date('2026-08-26T00:00:00.000Z');

    await expect(authorize(store, 'before', { now: beforeMidnight })).resolves.toEqual({
      ok: true,
    });
    await expect(
      authorize(store, 'after', { userId: 'other', now: afterMidnight }),
    ).resolves.toEqual({ ok: true });
  });

  it('uses independent UTC monthly budget buckets after a month boundary', async () => {
    const store = await createStore({
      dailyLimitMicrodollars: 400_000,
      monthlyLimitMicrodollars: 200_000,
    });

    await expect(
      authorize(store, 'december', {
        now: new Date('2026-12-31T23:59:59.999Z'),
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      authorize(store, 'january', {
        userId: 'other',
        now: new Date('2027-01-01T00:00:00.000Z'),
      }),
    ).resolves.toEqual({ ok: true });
  });

  it('recovers only expired request leases', async () => {
    const first = await createStore({ instanceId: 'old', requestLeaseMs: 60_000 });
    await authorize(first, 'stale', { now: new Date(Date.now() - 120_000) });
    await authorize(first, 'live');
    await first.close();
    stores.splice(stores.indexOf(first), 1);

    const replacement = await createStore({ instanceId: 'new', requestLeaseMs: 60_000 });
    const budget = await replacement.getBudgetSummary('raw-guild-id', new Date());

    expect(budget.dailyUsedMicrodollars).toBe(200_000);
    expect(budget.dailyReservedMicrodollars).toBe(200_000);
  });

  it('periodically recovers a reservation that expires after startup', async () => {
    const store = await createStore({ recoveryIntervalMs: 20, requestLeaseMs: 60_000 });
    const staleTime = new Date(Date.now() - 120_000);
    await authorize(store, 'periodic-stale', {
      now: staleTime,
    });

    await expect
      .poll(async () => store.getBudgetSummary('raw-guild-id', staleTime), {
        timeout: 2_000,
      })
      .toMatchObject({ dailyUsedMicrodollars: 200_000, dailyReservedMicrodollars: 0 });
  });

  it('recovers at most 100 stale reservations per sweep', async () => {
    const staleTime = new Date(Date.now() - 120_000);
    const first = await createStore({ requestLeaseMs: 60_000 });
    for (let index = 0; index < 101; index += 1) {
      await expect(
        authorize(first, `stale-batch-${index}`, {
          userId: `batch-user-${index}`,
          now: staleTime,
          reservationMicrodollars: 1,
        }),
      ).resolves.toEqual({ ok: true });
    }
    await first.close();
    stores.splice(stores.indexOf(first), 1);

    const second = await createStore({ requestLeaseMs: 60_000 });
    await expect(second.getBudgetSummary('raw-guild-id', staleTime)).resolves.toMatchObject({
      dailyUsedMicrodollars: 100,
      dailyReservedMicrodollars: 1,
    });
    await second.close();
    stores.splice(stores.indexOf(second), 1);

    const third = await createStore({ requestLeaseMs: 60_000 });
    await expect(third.getBudgetSummary('raw-guild-id', staleTime)).resolves.toMatchObject({
      dailyUsedMicrodollars: 101,
      dailyReservedMicrodollars: 0,
    });
  }, 60_000);

  it('rejects expired conversation links before the TTL monitor deletes them', async () => {
    const store = await createStore();
    await store.appendTurn({
      conversationId: 'expired-conversation',
      guildId: 'raw-guild-id',
      channelId: 'raw-channel-id',
      ownerId: 'raw-user-id',
      requestId: 'expired-request',
      assistantMessageIds: ['expired-message'],
      turn: { userContent: 'hello', assistantContent: 'hi', createdAt: new Date() },
      expiresAt: new Date(Date.now() - 1),
    });

    await expect(
      store.findConversationByMessage({
        messageId: 'expired-message',
        guildId: 'raw-guild-id',
        channelId: 'raw-channel-id',
      }),
    ).resolves.toBeNull();
  });
});
