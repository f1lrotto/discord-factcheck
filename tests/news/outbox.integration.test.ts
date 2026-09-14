import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIndexes, getCollections } from '../../src/mongo-schema.js';
import { createMongoNews } from '../../src/news/mongo.js';
import type { NewsEdition, NewsSourceResult, NewsStory } from '../../src/news/types.js';

const destination = { guildId: 'private-guild', channelId: 'private-channel' };
const daily = { feed: 'daily' as const, destination };
const continuous = { feed: 'continuous' as const, destination };
const at = (time: string, date = '2026-09-14') => new Date(`${date}T${time}Z`);
const story = (id: string, publishedAt = at('17:30:00'), important = true): NewsStory => ({
  id,
  kind: 'story',
  source: 'dennikn',
  publishedAt,
  important,
  revision: '1',
  title: id,
  url: `https://dennikn.sk/minuta/${id}`,
});
const edition = (publishedAt = at('17:00:00'), id = 'edition'): NewsEdition => ({
  id,
  kind: 'edition',
  source: 'aktuality',
  publishedAt,
  revision: '1',
  title: 'Editorial edition',
  url: 'https://www.aktuality.sk/editorial',
  sections: [{ title: 'First' }],
});
const stories = (...items: NewsStory[]): NewsSourceResult => ({
  outcome: 'stories',
  stories: items,
  cache: { listing: { etag: 'v1' } },
});

describe('durable news source coordination and outbox', () => {
  let replicaSet: MongoMemoryReplSet;
  let databaseName: string;
  let instant: Date;
  const clients: MongoClient[] = [];
  beforeAll(async () => {
    replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  });
  beforeEach(() => {
    databaseName = `outbox-${randomUUID()}`;
    instant = at('18:00:00');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (clients[0]) await clients[0].db(databaseName).dropDatabase();
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });
  afterAll(async () => replicaSet.stop());
  const open = async (leaseMs = 60_000) => {
    const client = await new MongoClient(replicaSet.getUri()).connect();
    clients.push(client);
    const collections = getCollections(client.db(databaseName));
    await createIndexes(collections);
    const context = {
      client,
      collections,
      protectIdentifier: (value: string) => value,
      logger: pino({ enabled: false }),
    };
    const news = createMongoNews(context, {
      secret: 'test-news-deployment-secret',
      clock: () => instant,
      leaseMs,
    });
    await news.initialize();
    return { news, collections, context };
  };
  const collect = async (
    news: Awaited<ReturnType<typeof open>>['news'],
    source: 'dennikn' | 'aktuality',
    result: NewsSourceResult,
  ) => {
    const claim = await news.claimPoll(source);
    expect(claim).not.toBeNull();
    expect(await news.commitPoll(claim!, result)).toBe(true);
    return claim!;
  };
  const readyDaily = async () => {
    const instance = await open();
    const subscription = await instance.news.configure(daily);
    await collect(instance.news, 'aktuality', {
      outcome: 'edition',
      edition: edition(),
      cache: {},
    });
    await instance.news.planPublications();
    return { ...instance, subscription };
  };
  const readyContinuous = async () => {
    const instance = await open();
    const subscription = await instance.news.configure(continuous);
    await collect(instance.news, 'dennikn', stories(story('bootstrap')));
    instant = at('18:20:00');
    await collect(
      instance.news,
      'dennikn',
      stories(story('bootstrap'), story('fresh-a'), story('fresh-b')),
    );
    await instance.news.planPublications();
    return { ...instance, subscription };
  };

  it('does no source work without subscribers and uniquely owns a continuous poll across instances', async () => {
    const a = await open();
    const b = await open();
    expect(await a.news.claimPoll('dennikn')).toBeNull();
    expect(await a.news.claimPoll('aktuality')).toBeNull();
    await a.news.configure(continuous);
    const claims = await Promise.all([a.news.claimPoll('dennikn'), b.news.claimPoll('dennikn')]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!;
    expect(await b.news.getSource('dennikn')).toMatchObject({
      lease: claim.lease,
      nextAttemptAt: at('18:20:00'),
    });
    instant = at('18:01:00');
    expect(await a.news.commitPoll(claim, stories(story('too-late')))).toBe(false);
    expect(await b.news.claimPoll('dennikn')).toBeNull();
    instant = at('18:20:00');
    const next = await b.news.claimPoll('dennikn');
    expect(next!.lease.owner).not.toBe(claim.lease.owner);
    expect(await a.news.commitPoll(claim, stories(story('stale-owner')))).toBe(false);
    expect(await a.news.commitPoll(next!, stories())).toBe(true);
    expect(await a.collections.newsObservations.countDocuments()).toBe(0);
  });

  it('consumes daily slots before HTTP and never repeats a crashed attempt or overlaps a lease', async () => {
    const a = await open();
    const b = await open();
    instant = at('17:59:59');
    await a.news.configure(daily);
    expect(await a.news.claimPoll('aktuality')).toBeNull();
    instant = at('18:00:00');
    const primary = await a.news.claimPoll('aktuality');
    expect(primary?.slot?.kind).toBe('primary');
    expect(await b.news.claimPoll('aktuality')).toBeNull();
    instant = at('18:30:00');
    expect(await b.news.claimPoll('aktuality')).toBeNull();
    instant = at('19:00:00');
    const fallback = await b.news.claimPoll('aktuality');
    expect(fallback?.slot?.kind).toBe('fallback');
    expect(
      await a.news.commitPoll(primary!, { outcome: 'edition', edition: edition(), cache: {} }),
    ).toBe(false);
    instant = at('19:30:00');
    expect(await a.news.claimPoll('aktuality')).toBeNull();
    instant = at('20:00:00');
    expect(await b.news.claimPoll('aktuality')).toBeNull();
    expect((await b.news.getSource('aktuality')).daily?.attemptedSlots).toHaveLength(2);
  });

  it('persists publisher backoff and good validators without committing failed parse cache', async () => {
    const { news } = await open();
    await news.configure(continuous);
    await collect(news, 'dennikn', stories());
    instant = at('18:20:00');
    await collect(news, 'dennikn', { outcome: 'rate-limited', retryAt: at('19:15:00') });
    expect(await news.getSource('dennikn')).toMatchObject({
      failures: 1,
      backoffUntil: at('19:15:00'),
      nextAttemptAt: at('19:15:00'),
      cache: { listing: { etag: 'v1' } },
    });
    instant = at('19:00:00');
    expect(await news.claimPoll('dennikn')).toBeNull();
    instant = at('19:15:00');
    await collect(news, 'dennikn', { outcome: 'malformed' });
    expect((await news.getSource('dennikn')).failures).toBe(2);
    instant = at('19:35:00');
    await collect(news, 'dennikn', { outcome: 'unchanged', cache: { listing: { etag: 'v2' } } });
    expect(await news.getSource('dennikn')).toMatchObject({
      failures: 0,
      cache: { listing: { etag: 'v2' } },
    });
    expect((await news.getSource('dennikn')).backoffUntil).toBeUndefined();
  });

  it.each(['empty', 'stale', 'malformed'] as const)(
    'allows only the fallback after a primary %s, preserving source-wide slots through configuration',
    async (outcome) => {
      const { news } = await open();
      await news.configure(daily);
      await collect(
        news,
        'aktuality',
        outcome === 'malformed'
          ? { outcome }
          : { outcome, cache: { candidate: { url: 'https://www.aktuality.sk/candidate' } } },
      );
      await news.disable({ guildId: destination.guildId, feed: 'daily' });
      instant = at('18:30:00');
      await news.configure(daily);
      expect(await news.claimPoll('aktuality')).toBeNull();
      instant = at('19:00:00');
      await collect(news, 'aktuality', { outcome: 'edition', edition: edition(), cache: {} });
      await news.planPublications();
      expect(await news.claimPublication()).not.toBeNull();
    },
  );

  it('suppresses fallback after collected edition even if Discord is unavailable and late activation uses cached content', async () => {
    const { news, subscription } = await readyDaily();
    const claim = (await news.claimPublication())!;
    expect(await news.beginSend(claim)).toEqual(destination);
    await news.finishSend(claim, { outcome: 'rejected' });
    instant = at('19:00:00');
    expect(await news.claimPoll('aktuality')).toBeNull();
    expect(await news.getDeliveryCounts(subscription.key)).toEqual({ pending: 1, uncertain: 0 });
    await news.configure({ ...daily, destination: { ...destination, guildId: 'late-guild' } });
    await news.planPublications();
    expect(
      await news.getDeliveryCounts(
        (await news.getSubscription({ guildId: 'late-guild', feed: 'daily' }))!.key,
      ),
    ).toEqual({ pending: 1, uncertain: 0 });
  });

  it('supports late first activation in the remaining daily slot and resets bounded metadata next day', async () => {
    const { news } = await open();
    instant = at('19:30:00');
    await news.configure(daily);
    const claim = await collect(news, 'aktuality', {
      outcome: 'unchanged',
      cache: {
        candidate: {
          url: 'https://www.aktuality.sk/cached',
          edition: edition(at('17:00:00', '2026-09-13')),
        },
      },
    });
    expect(claim.slot?.kind).toBe('fallback');
    await news.planPublications();
    expect(await news.claimPublication()).toBeNull();
    instant = at('18:00:00', '2026-09-15');
    const next = await news.claimPoll('aktuality');
    expect(next?.slot?.kind).toBe('primary');
    expect((await news.getSource('aktuality')).daily?.attemptedSlots).toHaveLength(1);
  });

  it('makes bootstrap and unchanged snapshots durable without replay and serializes activation against collection', async () => {
    const a = await open();
    const b = await open();
    await a.news.configure(continuous);
    await collect(a.news, 'dennikn', stories(story('already-seen')));
    await a.news.planPublications();
    expect(await a.news.claimPublication()).toBeNull();
    instant = at('18:20:00');
    const poll = (await a.news.claimPoll('dennikn'))!;
    const [subscription] = await Promise.all([
      b.news.configure({ ...continuous, destination: { ...destination, guildId: 'racing-guild' } }),
      a.news.commitPoll(poll, stories(story('new-observation'))),
    ]);
    // At exact freshness boundary activation either waits for this snapshot or captures it
    // after commit. Both serial orders exclude its existing contents for the new guild.
    const current = await b.news.getSubscription({ guildId: 'racing-guild', feed: 'continuous' });
    expect(current?.baseline?.sequence).toBe(2);
    await b.news.planPublications();
    expect(await b.news.getDeliveryCounts(subscription.key)).toEqual({ pending: 0, uncertain: 0 });
    instant = at('18:40:00');
    await b.news.configure({
      ...continuous,
      destination: { ...destination, guildId: 'waiting-for-304' },
    });
    await collect(a.news, 'dennikn', { outcome: 'unchanged', cache: {} });
    expect(
      (await b.news.getSubscription({ guildId: 'waiting-for-304', feed: 'continuous' }))?.baseline
        ?.sequence,
    ).toBe(3);
  });

  it('rolls back observations and waiting baselines on source commit failure or a lease expiring during processing', async () => {
    const a = await open();
    await a.news.configure(continuous);
    const claim = (await a.news.claimPoll('dennikn'))!;
    const original = a.collections.newsSources.replaceOne.bind(a.collections.newsSources);
    vi.spyOn(a.collections.newsSources, 'replaceOne').mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error('injected before transaction commit');
    });
    await expect(a.news.commitPoll(claim, stories(story('rolled-back')))).rejects.toThrow(
      'injected',
    );
    expect(await a.collections.newsObservations.countDocuments()).toBe(0);
    expect(
      (await a.news.getSubscription({ guildId: destination.guildId, feed: 'continuous' }))
        ?.baseline,
    ).toBeNull();
    const originalObservation = a.collections.newsObservations.replaceOne.bind(
      a.collections.newsObservations,
    );
    vi.spyOn(a.collections.newsObservations, 'replaceOne').mockImplementationOnce(
      async (...args) => {
        const result = await originalObservation(...args);
        instant = at('18:01:00');
        return result;
      },
    );
    expect(await a.news.commitPoll(claim, stories(story('expired-during-commit')))).toBe(false);
    expect(await a.collections.newsObservations.countDocuments()).toBe(0);
  });

  it('recovers planning after a committed snapshot with importance promotion, duplicates and edits', async () => {
    const a = await open();
    await a.news.configure(continuous);
    await collect(a.news, 'dennikn', stories(story('promoted', at('17:00:00'), false)));
    instant = at('18:20:00');
    await collect(
      a.news,
      'dennikn',
      stories(story('promoted', at('17:00:00')), {
        ...story('promoted', at('17:00:00')),
        revision: '2',
      }),
    );
    const b = await open(); // Original process stopped after durable commit, before planning.
    await Promise.all([a.news.planPublications(), b.news.planPublications()]);
    expect(await a.collections.newsObservations.countDocuments()).toBe(1);
    expect(await a.collections.newsPublications.countDocuments()).toBe(1);
    const claim = (await b.news.claimPublication())!;
    expect(claim.publication.content.revision).toBe('2');
    await b.news.beginSend(claim);
    await b.news.finishSend(claim, { outcome: 'sent', messageId: 'private-message' });
    instant = at('18:40:00');
    await collect(b.news, 'dennikn', stories({ ...story('promoted'), revision: '3' }));
    await b.news.planPublications();
    expect(await b.news.claimPublication()).toBeNull();
  });

  it('uniquely reserves and claims daily publication across instances and preserves sent dedup on replacement/re-enable', async () => {
    const a = await readyDaily();
    const b = await open();
    await Promise.all([a.news.planPublications(), b.news.planPublications()]);
    const claims = await Promise.all([a.news.claimPublication(), b.news.claimPublication()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!;
    await a.news.beginSend(claim);
    await b.news.finishSend(claim, { outcome: 'sent', messageId: 'private-discord-message-id' });
    await a.news.configure({
      ...daily,
      destination: { ...destination, channelId: 'new-private-channel' },
    });
    await a.news.disable({ guildId: destination.guildId, feed: 'daily' });
    await b.news.configure(daily);
    await b.news.planPublications();
    expect(await b.news.claimPublication()).toBeNull();
    const records = await a.collections.newsPublications.find().toArray();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'sent' });
    expect(records[0]).not.toHaveProperty('content');
    for (const value of [...Object.values(destination), 'private-discord-message-id'])
      expect(JSON.stringify(records)).not.toContain(value);
    expect(records[0]?.messageKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it('cancels old pre-send revisions and replans only eligible unsent daily work under the new revision', async () => {
    const { news, subscription, collections } = await readyDaily();
    const old = (await news.claimPublication())!;
    const replacement = await news.configure({
      ...daily,
      destination: { ...destination, channelId: 'replacement' },
    });
    expect(await news.beginSend(old)).toBeNull();
    await news.planPublications();
    const current = (await news.claimPublication())!;
    expect(current.publication.configurationRevision).toBe(replacement.revision);
    expect(current.publication.key).toBe(old.publication.key);
    expect(current.publication.nonce).toBe(old.publication.nonce);
    expect(await news.beginSend(current)).toEqual({ ...destination, channelId: 'replacement' });
    await news.disable({ guildId: destination.guildId, feed: 'daily' });
    await news.finishSend(current, { outcome: 'sent', messageId: 'receipt-after-disable' });
    expect(await collections.newsPublications.findOne({ _id: old.publication.key })).toMatchObject({
      status: 'sent',
    });
    expect(await news.getDeliveryCounts(subscription.key)).toEqual({ pending: 0, uncertain: 0 });
  });

  it('serializes a racing disable and beginSend; admitted calls stay sending while earlier disables cancel', async () => {
    const a = await readyDaily();
    const b = await open();
    const claim = (await a.news.claimPublication())!;
    const [admitted] = await Promise.all([
      a.news.beginSend(claim),
      b.news.disable({ guildId: destination.guildId, feed: 'daily' }),
    ]);
    const stored = await a.collections.newsPublications.findOne({ _id: claim.publication.key });
    expect(stored?.status).toBe(admitted ? 'sending' : 'cancelled');
    expect(await b.news.beginSend(claim)).toBeNull();
    await b.news.configure(daily);
    await b.news.planPublications();
    expect(await a.collections.newsPublications.countDocuments()).toBe(1);
  });

  it('reclaims crashed pre-send claims but holds crashed sending as uncertain and rejects stale owners', async () => {
    const { news, subscription, collections } = await readyDaily();
    const first = (await news.claimPublication())!;
    instant = at('18:01:00');
    const second = (await news.claimPublication())!;
    expect(second.lease.owner).not.toBe(first.lease.owner);
    expect(await news.beginSend(first)).toBeNull();
    await news.beginSend(second);
    instant = at('18:02:00');
    expect(await news.claimPublication()).toBeNull();
    await news.finishSend(second, { outcome: 'sent', messageId: 'late-receipt' });
    expect(await news.getDeliveryCounts(subscription.key)).toEqual({ pending: 0, uncertain: 1 });
    expect(
      await collections.newsPublications.findOne({ _id: second.publication.key }),
    ).toMatchObject({ status: 'uncertain', attempts: 1 });
    await news.disable({ guildId: destination.guildId, feed: 'daily' });
    await news.configure(daily);
    await news.planPublications();
    expect(await news.claimPublication()).toBeNull();
  });

  it('atomically persists sending and continuous pacing, with crash rollback and no burst on retry', async () => {
    const { news, collections } = await readyContinuous();
    const claim = (await news.claimPublication())!;
    const update = collections.newsSubscriptions.updateOne.bind(collections.newsSubscriptions);
    vi.spyOn(collections.newsSubscriptions, 'updateOne').mockImplementationOnce(async (...args) => {
      await update(...args);
      throw new Error('injected pacing write failure');
    });
    await expect(news.beginSend(claim)).rejects.toThrow('injected pacing');
    expect(
      await collections.newsPublications.findOne({ _id: claim.publication.key }),
    ).toMatchObject({ status: 'claimed', attempts: 0 });
    expect(await news.beginSend(claim)).toEqual(destination);
    await news.finishSend(claim, { outcome: 'sent', messageId: 'receipt' });
    await news.planPublications();
    expect(await news.claimPublication()).toBeNull();
    instant = at('18:40:00');
    const second = (await news.claimPublication())!;
    expect(second.publication.key).not.toBe(claim.publication.key);
    expect(await news.beginSend(second)).toEqual(destination);
  });

  it('expires daily retries/pending work at 22:00 and never admits it the next morning', async () => {
    const { news, subscription } = await readyDaily();
    instant = at('19:58:00');
    const first = (await news.claimPublication())!;
    await news.beginSend(first);
    await news.finishSend(first, { outcome: 'rejected', retryAt: at('19:59:00') });
    instant = at('19:59:00');
    const retry = (await news.claimPublication())!;
    expect(retry.publication.nonce).toBe(first.publication.nonce);
    await news.beginSend(retry);
    await news.finishSend(retry, { outcome: 'rejected', retryAt: at('20:00:00') });
    instant = at('20:00:00');
    expect(await news.claimPublication()).toBeNull();
    instant = at('06:00:00', '2026-09-15');
    await news.planPublications();
    expect(await news.claimPublication()).toBeNull();
    expect(await news.getDeliveryCounts(subscription.key)).toEqual({ pending: 0, uncertain: 0 });
  });

  it('can record an already-admitted send after cutoff but fences late collection and new send admission', async () => {
    const a = await readyDaily();
    instant = at('19:59:40');
    const claim = (await a.news.claimPublication())!;
    await a.news.beginSend(claim);
    instant = at('20:00:01');
    await a.news.finishSend(claim, { outcome: 'sent', messageId: 'after-cutoff' });
    expect(
      await a.collections.newsPublications.findOne({ _id: claim.publication.key }),
    ).toMatchObject({ status: 'sent' });
    await a.news.configure({ ...daily, destination: { ...destination, guildId: 'too-late' } });
    await a.news.planPublications();
    expect(await a.news.claimPublication()).toBeNull();
    instant = at('19:59:40', '2026-09-15');
    const poll = (await a.news.claimPoll('aktuality'))!;
    instant = at('20:00:01', '2026-09-15');
    expect(
      await a.news.commitPoll(poll, {
        outcome: 'edition',
        edition: edition(at('17:00:00', '2026-09-15')),
        cache: {},
      }),
    ).toBe(true);
    await a.news.planPublications();
    expect(await a.news.claimPublication()).toBeNull();
  });

  it('pauses unavailable/corrupt destinations without affecting another guild or pausing a newer revision', async () => {
    const { news, collections, subscription } = await readyDaily();
    const claim = (await news.claimPublication())!;
    await news.beginSend(claim);
    await news.configure({
      ...daily,
      destination: { ...destination, channelId: 'new-destination' },
    });
    await news.finishSend(claim, { outcome: 'destination-unavailable' });
    expect(
      (await news.getSubscription({ guildId: destination.guildId, feed: 'daily' }))?.pausedReason,
    ).toBeUndefined();
    await news.planPublications();
    const replacement = (await news.claimPublication())!;
    await news.beginSend(replacement);
    await news.finishSend(replacement, { outcome: 'destination-unavailable' });
    expect(
      (await news.getSubscription({ guildId: destination.guildId, feed: 'daily' }))?.pausedReason,
    ).toBe('destination-unavailable');
    await news.configure(daily);
    await news.planPublications();
    const corrupt = (await news.claimPublication())!;
    await collections.newsSubscriptions.updateOne(
      { _id: subscription.key },
      { $unset: { destination: '' } },
    );
    expect(await news.beginSend(corrupt)).toBeNull();
    expect(
      (await news.getSubscription({ guildId: destination.guildId, feed: 'daily' }))?.pausedReason,
    ).toBe('decryption-failed');
    await news.planPublications();
    expect(await news.claimPublication()).toBeNull();
  });

  it('keeps retention separate from admission and TTL deletion cannot resurrect expired content', async () => {
    const { news, collections } = await readyContinuous();
    const indexes = await collections.newsPublications.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { retainedUntil: 1 }, expireAfterSeconds: 0 }),
        expect.objectContaining({ key: { _id: 1 } }),
      ]),
    );
    expect(indexes.some((index) => 'expiresAt' in index.key)).toBe(false);
    const itemIndexes = await collections.newsObservations.indexes();
    expect(itemIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { retainedUntil: 1 }, expireAfterSeconds: 0 }),
      ]),
    );
    instant = at('20:21:00');
    await news.planPublications();
    expect(await news.claimPublication()).toBeNull();
    await collections.newsPublications.deleteMany({}); // Simulate later TTL cleanup early; eligibility still rejects replay.
    await news.planPublications();
    expect(await news.claimPublication()).toBeNull();
    instant = at('18:00:00', '2026-09-22');
    await collections.newsObservations.deleteMany({});
    await collect(news, 'dennikn', stories(story('fresh-a')));
    await news.planPublications();
    expect(await news.claimPublication()).toBeNull();
  });
  it('rolls back crashed poll claims, plans and publication claims, then retries from durable state', async () => {
    const a = await open();
    await a.news.configure(daily);
    const replaceSource = a.collections.newsSources.replaceOne.bind(a.collections.newsSources);
    vi.spyOn(a.collections.newsSources, 'replaceOne').mockImplementationOnce(async (...args) => {
      await replaceSource(...args);
      throw new Error('crash during poll claim');
    });
    await expect(a.news.claimPoll('aktuality')).rejects.toThrow('crash during poll claim');
    expect(await a.collections.newsSources.countDocuments()).toBe(0);
    await collect(a.news, 'aktuality', { outcome: 'edition', edition: edition(), cache: {} });
    const replacePublication = a.collections.newsPublications.replaceOne.bind(
      a.collections.newsPublications,
    );
    vi.spyOn(a.collections.newsPublications, 'replaceOne').mockImplementationOnce(
      async (...args) => {
        await replacePublication(...args);
        throw new Error('crash during planning');
      },
    );
    await expect(a.news.planPublications()).rejects.toThrow('crash during planning');
    expect(await a.collections.newsPublications.countDocuments()).toBe(0);
    await a.news.planPublications();
    vi.spyOn(a.collections.newsPublications, 'replaceOne').mockImplementationOnce(
      async (...args) => {
        await replacePublication(...args);
        throw new Error('crash during publication claim');
      },
    );
    await expect(a.news.claimPublication()).rejects.toThrow('crash during publication claim');
    expect(await a.collections.newsPublications.findOne({})).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
    expect(await a.news.claimPublication()).not.toBeNull();
  });

  it('holds a failed receipt transaction as uncertain after expiry, without exposing destination data', async () => {
    const { news, collections, subscription } = await readyDaily();
    const claim = (await news.claimPublication())!;
    await news.beginSend(claim);
    const update = collections.newsPublications.updateOne.bind(collections.newsPublications);
    vi.spyOn(collections.newsPublications, 'updateOne').mockImplementationOnce(async (...args) => {
      await update(...args);
      throw new Error('crash saving receipt');
    });
    await expect(
      news.finishSend(claim, { outcome: 'sent', messageId: 'accepted-by-discord' }),
    ).rejects.toThrow('crash saving receipt');
    expect(
      await collections.newsPublications.findOne({ _id: claim.publication.key }),
    ).toMatchObject({ status: 'sending' });
    instant = at('18:01:00');
    expect(await news.getDeliveryCounts(subscription.key)).toEqual({ pending: 0, uncertain: 1 });
    expect(await news.claimPublication()).toBeNull();
  });

  it('retains explicit uncertain outcomes and rejects a send when the daily deadline passes after claiming', async () => {
    const { news, collections } = await readyDaily();
    const claim = (await news.claimPublication())!;
    await news.beginSend(claim);
    await news.finishSend(claim, { outcome: 'uncertain' });
    expect(
      await collections.newsPublications.findOne({ _id: claim.publication.key }),
    ).toMatchObject({ status: 'uncertain' });
    await news.configure({ ...daily, destination: { ...destination, guildId: 'deadline-guild' } });
    await news.planPublications();
    instant = at('19:59:50');
    const late = (await news.claimPublication())!;
    instant = at('20:00:00');
    expect(await news.beginSend(late)).toBeNull();
    expect(await collections.newsPublications.findOne({ _id: late.publication.key })).toMatchObject(
      { status: 'expired' },
    );
  });

  it('rejects paused-source polling and honors backoff that forbids the daily fallback', async () => {
    const { news, collections } = await open();
    const subscription = await news.configure(daily);
    await collect(news, 'aktuality', { outcome: 'rate-limited', retryAt: at('20:30:00') });
    instant = at('19:00:00');
    expect(await news.claimPoll('aktuality')).toBeNull();
    instant = at('20:30:00');
    expect(await news.claimPoll('aktuality')).toBeNull();
    instant = at('18:00:00', '2026-09-15');
    await collections.newsSubscriptions.updateOne(
      { _id: subscription.key },
      { $set: { pausedReason: 'destination-unavailable' } },
    );
    expect(await news.claimPoll('aktuality')).toBeNull();
    await news.configure(daily);
    expect(await news.claimPoll('aktuality')).not.toBeNull();
  });
  it('establishes an empty successful baseline, while malformed snapshots leave activation waiting', async () => {
    const { news } = await open();
    await news.configure(continuous);
    await collect(news, 'dennikn', { outcome: 'malformed' });
    expect(
      (await news.getSubscription({ guildId: destination.guildId, feed: 'continuous' }))?.baseline,
    ).toBeNull();
    instant = at('18:20:00');
    await collect(news, 'dennikn', { outcome: 'empty', cache: {} });
    expect(
      (await news.getSubscription({ guildId: destination.guildId, feed: 'continuous' }))?.baseline
        ?.sequence,
    ).toBe(1);
    instant = at('18:40:00');
    await collect(news, 'dennikn', stories(story('first-arrival')));
    await news.planPublications();
    expect((await news.claimPublication())?.publication.content.id).toBe('first-arrival');
  });

  it('orders fresh-snapshot activation and source commits so eligibility matches the committed order', async () => {
    const a = await open();
    const b = await open();
    await a.news.configure(continuous);
    const firstPoll = (await a.news.claimPoll('dennikn'))!;
    instant = at('18:00:01');
    await a.news.commitPoll(firstPoll, stories(story('baseline')));
    instant = at('18:20:00');
    const secondPoll = (await a.news.claimPoll('dennikn'))!;
    const [subscription] = await Promise.all([
      b.news.configure({
        ...continuous,
        destination: { ...destination, guildId: 'fresh-race-guild' },
      }),
      a.news.commitPoll(secondPoll, stories(story('after-baseline'))),
    ]);
    expect([1, 2]).toContain(subscription.baseline?.sequence);
    await a.news.planPublications();
    expect(await b.news.getDeliveryCounts(subscription.key)).toEqual({
      pending: subscription.baseline?.sequence === 1 ? 1 : 0,
      uncertain: 0,
    });
  });

  it('never routes a claimed old publication to a replacement channel in a racing admission', async () => {
    const a = await readyDaily();
    const b = await open();
    const claim = (await a.news.claimPublication())!;
    const [admitted] = await Promise.all([
      a.news.beginSend(claim),
      b.news.configure({
        ...daily,
        destination: { ...destination, channelId: 'replacement-channel' },
      }),
    ]);
    expect(admitted === null || admitted.channelId === destination.channelId).toBe(true);
    const document = await a.collections.newsPublications.findOne({ _id: claim.publication.key });
    expect(document?.status).toBe(admitted ? 'sending' : 'cancelled');
  });

  it('rejects invalid lease durations before any coordination can begin', async () => {
    await expect(open(0)).rejects.toThrow('positive and finite');
    await expect(open(Number.POSITIVE_INFINITY)).rejects.toThrow('positive and finite');
  });
  it('rolls back a source commit whose final database write crosses its lease deadline', async () => {
    const { news, collections } = await open();
    await news.configure(continuous);
    const claim = (await news.claimPoll('dennikn'))!;
    const replace = collections.newsSources.replaceOne.bind(collections.newsSources);
    vi.spyOn(collections.newsSources, 'replaceOne').mockImplementationOnce(async (...args) => {
      const result = await replace(...args);
      instant = at('18:01:00');
      return result;
    });
    expect(await news.commitPoll(claim, stories(story('late-final-write')))).toBe(false);
    expect(await collections.newsObservations.countDocuments()).toBe(0);
    expect((await news.getSource('dennikn')).snapshot).toBeUndefined();
  });

  it('rolls back an admission whose database write crosses 22:00 and expires the unsent record', async () => {
    const { news, collections } = await readyDaily();
    instant = at('19:59:50');
    const claim = (await news.claimPublication())!;
    const update = collections.newsPublications.updateOne.bind(collections.newsPublications);
    vi.spyOn(collections.newsPublications, 'updateOne').mockImplementationOnce(async (...args) => {
      const result = await update(...args);
      instant = at('20:00:00');
      return result;
    });
    expect(await news.beginSend(claim)).toBeNull();
    await news.getDeliveryCounts(claim.publication.subscriptionKey);
    expect(
      await collections.newsPublications.findOne({ _id: claim.publication.key }),
    ).toMatchObject({ status: 'expired', attempts: 0 });
  });

  it('fences receipts that consume their lease during database processing', async () => {
    const { news, collections, subscription } = await readyDaily();
    const claim = (await news.claimPublication())!;
    await news.beginSend(claim);
    const update = collections.newsPublications.updateOne.bind(collections.newsPublications);
    vi.spyOn(collections.newsPublications, 'updateOne').mockImplementationOnce(async (...args) => {
      const result = await update(...args);
      instant = at('18:01:00');
      return result;
    });
    await news.finishSend(claim, { outcome: 'sent', messageId: 'expired-receipt' });
    expect(await news.getDeliveryCounts(subscription.key)).toEqual({ pending: 0, uncertain: 1 });
    expect(
      await collections.newsPublications.findOne({ _id: claim.publication.key }),
    ).not.toHaveProperty('messageKey');
  });
});
