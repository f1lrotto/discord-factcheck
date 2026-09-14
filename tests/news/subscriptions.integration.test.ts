import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongoStore } from '../../src/mongo-store.js';
import { getCollections } from '../../src/mongo-schema.js';
import { createIdentifierProtector } from '../../src/security.js';
import { createNewsCipher, NewsDecryptionError } from '../../src/news/cipher.js';
import { publicationKey } from '../../src/news/policy.js';
import type { NewsEdition } from '../../src/news/types.js';

const secret = 'news-test-deployment-secret';
const destination = { guildId: 'private-guild-123', channelId: 'private-channel-456' };
const daily = {
  feed: 'daily' as const,
  destination: { ...destination, notifyRoleId: 'private-role-789' },
};
const continuous = { feed: 'continuous' as const, destination };
const address = (value: { key: string; revision: number }) => ({
  subscriptionKey: value.key,
  revision: value.revision,
});

describe('encrypted Mongo news subscriptions', () => {
  let replicaSet: MongoMemoryReplSet;
  let databaseName: string;
  let inspector: MongoClient;
  let instant: Date;
  let logs: string[];
  const stores: ReturnType<typeof createMongoStore>[] = [];
  beforeAll(async () => {
    replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    inspector = await new MongoClient(replicaSet.getUri()).connect();
  });
  beforeEach(() => {
    databaseName = `news-test-${randomUUID()}`;
    instant = new Date('2026-09-14T18:30:00Z');
    logs = [];
  });
  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
    await inspector.db(databaseName).dropDatabase();
  });
  afterAll(async () => {
    await inspector.close();
    await replicaSet.stop();
  });
  const collections = () => getCollections(inspector.db(databaseName));
  const makeStore = (deploymentSecret = secret) => {
    const store = createMongoStore({
      uri: replicaSet.getUri(),
      databaseName,
      dailyLimitMicrodollars: 1_000_000,
      monthlyLimitMicrodollars: 10_000_000,
      promptsPerMinute: 3,
      transcriptTtlMs: 60_000,
      instanceId: randomUUID(),
      protectIdentifier: createIdentifierProtector(secret),
      logger: pino(
        {},
        {
          write: (chunk) => {
            logs.push(chunk);
          },
        },
      ),
      news: { secret: deploymentSecret, clock: () => instant },
    });
    stores.push(store);
    return store;
  };
  const open = async () => {
    const store = makeStore();
    await store.initialize();
    return store.news!;
  };

  it('persists through independent clients and restart; indexes and logs contain no destination IDs', async () => {
    const first = await open();
    const saved = await first.configure(daily);
    await stores.shift()!.close();
    const second = await open();
    expect(await second.getSubscription({ guildId: destination.guildId, feed: 'daily' })).toEqual(
      saved,
    );
    expect(await second.getDestination(address(saved))).toEqual(daily.destination);
    const documents = await collections().newsSubscriptions.find().toArray();
    expect(documents[0]).not.toHaveProperty('channelId');
    expect(documents[0]?.destination).toMatchObject({ version: 1 });
    expect(JSON.stringify(saved)).not.toContain('destination');
    for (const id of Object.values(daily.destination)) {
      expect(JSON.stringify(documents)).not.toContain(id);
      expect(logs.join('')).not.toContain(id);
    }
    const indexes = await collections().newsSubscriptions.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { _id: 1 } }),
        expect.objectContaining({ key: { guildKey: 1, feed: 1 }, unique: true }),
        expect.objectContaining({ key: { enabled: 1, feed: 1 } }),
      ]),
    );
  });

  it('isolates guilds and feed types, including duplicate channel names and rename with the same ID', async () => {
    const first = await open();
    const second = await open();
    const a = await first.configure(daily);
    const b = await second.configure(continuous);
    const c = await first.configure({
      ...daily,
      destination: { ...daily.destination, guildId: 'another-guild' },
    });
    expect(new Set([a.key, b.key, c.key]).size).toBe(3);
    instant = new Date(+instant + 60_000);
    expect(await second.configure(daily)).toEqual(a); // Names are never persisted or used for identity.
    expect(await first.listEnabled()).toHaveLength(3);
    expect(await first.getSubscription({ guildId: 'missing', feed: 'daily' })).toBeNull();
    expect(await first.getDestination({ subscriptionKey: 'missing', revision: 1 })).toBeNull();
    expect(await first.getDestination(address(b))).toEqual(destination);
    expect(await first.getDestination(address(c))).toEqual({
      ...daily.destination,
      guildId: 'another-guild',
    });
  });

  it('serializes concurrent same-value configuration and key initialization without extra revisions', async () => {
    const a = makeStore();
    const b = makeStore();
    await Promise.all([a.initialize(), b.initialize()]);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).news!.configure(daily)),
    );
    expect(results.every((result) => result.revision === 1 && result.key === results[0]?.key)).toBe(
      true,
    );
    expect(await collections().newsSubscriptions.countDocuments()).toBe(1);
    expect(await collections().newsMetadata.countDocuments()).toBe(1);
  });

  it('assigns distinct monotonic revisions to competing destination replacements', async () => {
    const first = await open();
    const second = await open();
    const original = await first.configure(daily);
    const replacements = await Promise.all([
      first.configure({
        ...daily,
        destination: { ...daily.destination, channelId: 'first-replacement' },
      }),
      second.configure({
        ...daily,
        destination: { ...daily.destination, channelId: 'second-replacement' },
      }),
    ]);
    expect(replacements.map((value) => value.revision).sort()).toEqual([2, 3]);
    const latest = replacements.find((value) => value.revision === 3)!;
    const superseded = replacements.find((value) => value.revision === 2)!;
    expect(await first.getDestination(address(original))).toBeNull();
    expect(await second.getDestination(address(superseded))).toBeNull();
    expect(await first.getDestination(address(latest))).not.toBeNull();
  });

  it('replaces channels/roles with a fresh revision and nonce while preserving daily identity and pacing', async () => {
    const news = await open();
    const saved = await news.configure(daily);
    const before = await collections().newsSubscriptions.findOne({ _id: saved.key });
    const pacedAt = new Date(+instant + 20 * 60_000);
    await collections().newsSubscriptions.updateOne(
      { _id: saved.key },
      { $set: { nextDeliveryAt: pacedAt } },
    );
    const replacement = await news.configure({
      ...daily,
      destination: { ...destination, channelId: 'replacement-channel' },
    });
    expect(replacement).toMatchObject({ key: saved.key, revision: 2, nextDeliveryAt: pacedAt });
    expect(await news.getDestination(address(saved))).toBeNull();
    expect(await news.getDestination(address(replacement))).toEqual({
      ...destination,
      channelId: 'replacement-channel',
    });
    const after = await collections().newsSubscriptions.findOne({ _id: saved.key });
    expect(after?.destination?.nonce).not.toBe(before?.destination?.nonce);
    const edition: NewsEdition = {
      id: 'edition',
      kind: 'edition',
      source: 'aktuality',
      title: 'News',
      url: 'https://www.aktuality.sk/example',
      publishedAt: instant,
      revision: '1',
      sections: [],
    };
    expect(publicationKey(saved.key, edition)).toBe(publicationKey(replacement.key, edition));
  });

  it('erases ciphertext on disable and guild removal, retaining revision and identity across re-enable', async () => {
    const news = await open();
    const saved = await news.configure(daily);
    await news.configure(continuous);
    const other = await news.configure({
      ...daily,
      destination: { ...destination, guildId: 'other-guild' },
    });
    await news.disable({ guildId: destination.guildId, feed: 'daily' });
    await news.disable({ guildId: destination.guildId, feed: 'daily' });
    const disabled = await collections().newsSubscriptions.findOne({ _id: saved.key });
    expect(disabled).toMatchObject({ enabled: false, revision: 2, baseline: null });
    expect(disabled).not.toHaveProperty('destination');
    expect(await news.getDestination(address(saved))).toBeNull();
    expect(
      await news.getSubscription({ guildId: destination.guildId, feed: 'daily' }),
    ).toMatchObject({ enabled: false });
    const enabled = await news.configure(daily);
    expect(enabled).toMatchObject({ key: saved.key, revision: 3, baseline: null });
    await news.removeGuild(destination.guildId);
    expect(await news.listEnabled()).toEqual([other]);
    const removed = await collections()
      .newsSubscriptions.find({ guildKey: createNewsCipher(secret).guildKey(destination.guildId) })
      .toArray();
    expect(removed.every((record) => !record.enabled && !record.destination)).toBe(true);
  });

  it('reads activation baselines from the actual source snapshot and excludes stale/future snapshots', async () => {
    const news = await open();
    const saved = await news.configure(continuous);
    expect(saved.baseline).toBeNull();
    const snapshot = { sequence: 42, collectedAt: new Date(+instant - 60_000) };
    await collections().newsSources.insertOne({
      _id: 'dennikn',
      source: 'dennikn',
      snapshot,
      nextAttemptAt: instant,
      failures: 0,
      cache: {},
    });
    const second = await news.configure({
      ...continuous,
      destination: { ...destination, guildId: 'second-guild' },
    });
    expect(second.baseline).toEqual(snapshot);
    expect((await news.configure(daily)).baseline).toBeNull();
    instant = new Date(+instant + 20 * 60_000);
    await news.disable({ guildId: 'second-guild', feed: 'continuous' });
    expect(
      (
        await news.configure({
          ...continuous,
          destination: { ...destination, guildId: 'second-guild' },
        })
      ).baseline,
    ).toBeNull();
    await collections().newsSources.updateOne(
      { _id: 'dennikn' },
      { $set: { snapshot: { sequence: 43, collectedAt: new Date(+instant + 1) } } },
    );
    expect(
      (
        await news.configure({
          ...continuous,
          destination: { ...destination, channelId: 'new-channel' },
        })
      ).baseline,
    ).toBeNull();
  });

  it('surfaces tampering in status and revision-bound reads and permits explicit repair', async () => {
    const news = await open();
    const saved = await news.configure(daily);
    await collections().newsSubscriptions.updateOne(
      { _id: saved.key },
      { $set: { 'destination.tag': Buffer.alloc(16).toString('base64') } },
    );
    await expect(news.getDestination(address(saved))).rejects.toThrow(NewsDecryptionError);
    expect(
      await news.getSubscription({ guildId: destination.guildId, feed: 'daily' }),
    ).toMatchObject({ pausedReason: 'decryption-failed' });
    expect(await news.listEnabled()).toEqual([
      expect.objectContaining({ pausedReason: 'decryption-failed' }),
    ]);
    expect(logs.join('')).toContain('news_destination_decryption_failed');
    for (const id of Object.values(daily.destination)) expect(logs.join('')).not.toContain(id);
    const repaired = await news.configure(daily);
    expect(repaired.revision).toBe(2);
    expect(repaired.pausedReason).toBeUndefined();
    expect(await news.getDestination(address(repaired))).toEqual(daily.destination);
  });

  it('rejects swapped records, swapped revisions and missing ciphertext', async () => {
    const news = await open();
    const a = await news.configure(daily);
    const b = await news.configure(continuous);
    const original = await collections().newsSubscriptions.findOne({ _id: a.key });
    await collections().newsSubscriptions.updateOne(
      { _id: b.key },
      { $set: { destination: original!.destination! } },
    );
    await expect(news.getDestination(address(b))).rejects.toThrow(NewsDecryptionError);
    await collections().newsSubscriptions.updateOne({ _id: a.key }, { $inc: { revision: 1 } });
    await expect(news.getDestination({ subscriptionKey: a.key, revision: 2 })).rejects.toThrow(
      NewsDecryptionError,
    );
    await collections().newsSubscriptions.updateOne(
      { _id: a.key },
      { $unset: { destination: '' } },
    );
    await expect(news.getDestination({ subscriptionKey: a.key, revision: 2 })).rejects.toThrow(
      NewsDecryptionError,
    );
  });

  it('rejects wrong deployment keys before creating orphaned identities and leaves existing records intact', async () => {
    const news = await open();
    const saved = await news.configure(daily);
    const before = await collections().newsSubscriptions.find().toArray();
    const wrong = makeStore('different-deployment-secret');
    await expect(wrong.initialize()).rejects.toThrow('restore the original secret');
    expect(await collections().newsSubscriptions.find().toArray()).toEqual(before);
    expect(await news.getDestination(address(saved))).toEqual(daily.destination);
    expect(logs.join('')).toContain('news_encryption_key_mismatch');
  });

  it('allows only one competing deployment key to initialize a fresh database', async () => {
    const first = makeStore();
    const second = makeStore('different-deployment-secret');
    const outcomes = await Promise.allSettled([first.initialize(), second.initialize()]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(await collections().newsMetadata.countDocuments()).toBe(1);
  });

  it('rejects invalid configuration and binds encryption format, context and key', async () => {
    const news = await open();
    await expect(news.configure({ ...continuous, destination: daily.destination })).rejects.toThrow(
      'Invalid news',
    );
    await expect(
      news.configure({ ...daily, destination: { ...destination, channelId: '' } }),
    ).rejects.toThrow('Invalid news');
    expect(() => createNewsCipher('  ')).toThrow('requires a deployment secret');
    const cipher = createNewsCipher(secret);
    const value = cipher.encrypt(destination, 'context', 1);
    expect(cipher.decrypt(value, 'context', 1)).toEqual(destination);
    expect(() => createNewsCipher('wrong').decrypt(value, 'context', 1)).toThrow(
      NewsDecryptionError,
    );
    expect(() => cipher.decrypt({ ...value, nonce: '' }, 'context', 1)).toThrow(
      NewsDecryptionError,
    );
    expect(() =>
      cipher.decrypt({ ...value, version: 2 } as unknown as typeof value, 'context', 1),
    ).toThrow(NewsDecryptionError);
    expect(() =>
      cipher.decrypt(
        cipher.encrypt({ channelId: 42 } as unknown as typeof destination, 'context', 1),
        'context',
        1,
      ),
    ).toThrow(NewsDecryptionError);
    expect(cipher.messageKey('id')).not.toBe(cipher.guildKey('id'));
    expect(cipher.subscriptionKey('id', 'daily')).not.toBe(
      cipher.subscriptionKey('id', 'continuous'),
    );
  });
});
