import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getCollections, createIndexes } from '../src/mongo-schema.js';
import { createMongoReminders } from '../src/mongo-reminders.js';
import { createMongoBriefing } from '../src/briefing/mongo.js';
import { createMongoNews } from '../src/news/mongo.js';
import type { NewsEdition } from '../src/news/types.js';
import { reminderLimits } from '../src/reminders.js';
import type { MongoContext } from '../src/mongo-context.js';

const secret = 'test-scheduled-secret-long-enough-for-encryption';
const destination = { guildId: 'guild', channelId: 'channel', userId: 'user' };
const city = {
  name: 'Bratislava',
  lat: 48.15,
  lon: 17.11,
  countryCode: 'SK',
  timeZone: 'Europe/Bratislava',
};

describe('durable scheduled storage across replicas', () => {
  let repl: MongoMemoryReplSet, client: MongoClient, context: MongoContext;
  let now = new Date();
  beforeAll(async () => {
    repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    client = await new MongoClient(repl.getUri()).connect();
  });
  beforeEach(async () => {
    context = {
      client,
      collections: getCollections(client.db(randomUUID())),
      logger: pino({ enabled: false }),
      protectIdentifier: (value) => `protected-${value}`,
    };
    await createIndexes(context.collections);
    now = new Date('2026-09-15T04:00:00Z');
  });
  afterAll(async () => {
    await client.close();
    await repl.stop();
  });
  const reminders = () => createMongoReminders(context, { secret, now: () => now });
  const create = (store = reminders(), route = destination) =>
    store.create({ destination: route, text: 'Invoice', dueAt: new Date(+now + 60_000), now });

  it('enforces 20 pending reminders under concurrent writes and keeps identifiers encrypted', async () => {
    const store = reminders();
    const results = await Promise.all(Array.from({ length: 24 }, () => create(store)));
    expect(results.filter((result) => result !== 'limit_reached')).toHaveLength(20);
    expect(await store.listForMember({ guildId: 'guild', userId: 'user', now })).toHaveLength(20);
    expect(await store.listForMember({ guildId: 'other', userId: 'user', now })).toEqual([]);
    const documents = await context.collections.reminders.find().toArray();
    expect(JSON.stringify(documents)).not.toMatch(/"(guild|channel|user)"/);
    const id = documents[0]!.publicId;
    expect(await store.cancel({ guildId: 'other', userId: 'user', id })).toBe(false);
    expect(await store.cancel({ guildId: 'guild', userId: 'user', id })).toBe(true);
    expect(await create(store)).not.toBe('limit_reached');
  });
  it('recovers claimed but unsent work and fences the old worker', async () => {
    const first = reminders(),
      second = reminders();
    await create(first);
    expect(await first.claimDue(now)).toBeNull();
    now = new Date(+now + 60_000);
    const claims = await Promise.all([first.claimDue(now), second.claimDue(now)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const stale = claims.find(Boolean)!;
    now = new Date(+now + reminderLimits.leaseMs + 1);
    const recovered = (await second.claimDue(now))!;
    expect(recovered.nonce).toBe(stale.nonce);
    expect(await first.beginSend(stale)).toBeNull();
    expect(await second.beginSend(recovered)).toEqual(destination);
    await first.finishSend(stale, { outcome: 'sent', messageId: 'old' });
    expect((await context.collections.reminders.findOne({ _id: recovered.key }))?.status).toBe(
      'sending',
    );
    await second.finishSend(recovered, { outcome: 'sent', messageId: 'new' });
    expect(await first.claimDue(now)).toBeNull();
    expect(
      (await context.collections.reminders.findOne({ _id: recovered.key }))?.destination,
    ).toBeUndefined();
  });
  it('never retries a crash after the send boundary, and refuses cancellation at that boundary', async () => {
    const store = reminders();
    const reminder = await create(store);
    if (reminder === 'limit_reached') throw new Error('limit');
    now = new Date(+now + 60_000);
    const claim = (await store.claimDue(now))!;
    await store.beginSend(claim);
    expect(await store.cancel({ guildId: 'guild', userId: 'user', id: reminder.id })).toBe(false);
    now = new Date(+now + reminderLimits.leaseMs + 1);
    expect(await reminders().claimDue(now)).toBeNull();
    expect((await context.collections.reminders.findOne({ _id: claim.key }))?.status).toBe(
      'uncertain',
    );
  });
  it.each(['rejected', 'uncertain', 'destination-unavailable'] as const)(
    'handles %s explicitly',
    async (outcome) => {
      const store = reminders();
      await create(store);
      now = new Date(+now + 60_000);
      const claim = (await store.claimDue(now))!;
      await store.beginSend(claim);
      await store.finishSend(claim, { outcome });
      expect(await store.claimDue(now)).toBeNull();
      now = new Date(+now + 61_000);
      expect(Boolean(await store.claimDue(now))).toBe(outcome === 'rejected');
    },
  );
  it('keeps agenda texts in the original channel and handles corrupt destinations', async () => {
    const store = reminders();
    await create(store);
    await create(store, { ...destination, channelId: 'private' });
    expect(
      await store.dueInWindow({
        guildId: 'guild',
        channelId: 'channel',
        from: now,
        to: new Date(+now + 86_400_000),
      }),
    ).toHaveLength(1);
    now = new Date(+now + 60_000);
    const claim = (await store.claimDue(now))!;
    const wrong = createMongoReminders(context, { secret: 'wrong-secret', now: () => now });
    await expect(wrong.beginSend(claim)).rejects.toThrow('authentication failed');
    expect(() => createMongoReminders(context, { secret: ' ' })).toThrow();
  });

  it('manually delivers a briefing outside its slot, with durable recovery and a cooldown', async () => {
    now = new Date('2026-09-15T12:00:00Z');
    const store = createMongoBriefing(context, secret);
    expect(await store.requestRun('guild', 'request', now)).toBe('unconfigured');
    await store.configure(destination);
    expect(await store.requestRun('guild', 'request', now)).toBe('queued');
    expect(await store.requestRun('guild', 'request', now)).toBe('queued');
    expect(await store.requestRun('guild', 'second', now)).toBe('busy');
    const sub = (await store.get('guild'))!;
    const claim = (await store.claim(sub, now))!;
    expect(claim.manualRun).toBeDefined();
    const restarted = createMongoBriefing(context, secret);
    expect(await restarted.claim(sub, now)).toBeNull();
    now = new Date(+now + 121_000);
    const recovered = (await restarted.claim(sub, now))!;
    expect(recovered.key).toBe(claim.key);
    expect(await store.beginSend(claim, now)).toBeNull();
    expect(await restarted.beginSend(recovered, now)).not.toBeNull();
    await restarted.finishSend(recovered, { outcome: 'sent', messageId: 'm' }, now);
    expect(await store.claim(sub, now)).toBeNull();
    now = new Date('2026-09-16T04:00:00Z');
    const scheduled = (await store.claim((await store.get('guild'))!, now))!;
    expect(scheduled.manualRun).toBeUndefined();
    expect(scheduled.key).not.toBe(claim.key);
  });
  it('expires manual briefing sends conservatively and fences cancelled requests', async () => {
    now = new Date('2026-09-15T12:00:00Z');
    const store = createMongoBriefing(context, secret);
    await store.configure(destination);
    await store.requestRun('guild', 'first', now);
    const sub = (await store.get('guild'))!;
    const claim = (await store.claim(sub, now))!;
    await store.beginSend(claim, now);
    now = new Date(+now + 11 * 60_000);
    expect(await store.claim(sub, now)).toBeNull();
    expect((await context.collections.briefingDeliveries.findOne({ _id: claim.key }))?.status).toBe(
      'uncertain',
    );
    expect(await store.requestRun('guild', 'second', now)).toBe('queued');
    const second = (await store.claim((await store.get('guild'))!, now))!;
    await store.disable('guild');
    expect(await store.beginSend(second, now)).toBeNull();
  });
  it('queues manual news outside evening hours and preserves its receipt across restart', async () => {
    now = new Date('2026-09-16T08:00:00Z');
    const store = createMongoNews(context, { secret, clock: () => now });
    await store.initialize();
    const edition: NewsEdition = {
      kind: 'edition',
      source: 'aktuality',
      id: 'late',
      title: 'Denný výber',
      url: 'https://www.aktuality.sk/clanok/late/denny-vyber/',
      publishedAt: new Date('2026-09-15T19:30:00Z'),
      revision: '1',
      sections: [{ title: 'News' }],
    };
    const request = { guildId: 'guild', requestId: 'command', revision: 1, edition };
    expect(await store.queueManualEdition(request)).toBe('unconfigured');
    const sub = await store.configure({ feed: 'daily', destination });
    request.revision = sub.revision;
    expect(await store.claimPoll('aktuality')).toBeNull();
    const poll = (await store.claimPoll('aktuality', { manual: true }))!;
    expect(poll).not.toBeNull();
    expect(await store.claimPoll('aktuality', { manual: true })).toBeNull();
    await store.commitPoll(poll, { outcome: 'edition', edition, cache: {} });
    const queued = await Promise.all([
      store.queueManualEdition(request),
      store.queueManualEdition(request),
    ]);
    expect(queued).toEqual(['queued', 'queued']);
    expect(await store.queueManualEdition({ ...request, requestId: 'second' })).toBe('busy');
    const restarted = createMongoNews(context, { secret, clock: () => now });
    const claim = (await restarted.claimPublication())!;
    expect(claim.publication.manual).toBe(true);
    expect(await restarted.beginSend(claim)).toMatchObject({ channelId: 'channel' });
    await restarted.finishSend(claim, { outcome: 'rejected' });
    now = new Date(+now + 61_000);
    const retry = (await store.claimPublication())!;
    expect(retry.publication.nonce).toBe(claim.publication.nonce);
    await store.beginSend(retry);
    await store.finishSend(retry, { outcome: 'sent', messageId: 'message' });
    expect(await restarted.claimPublication()).toBeNull();
    expect(await store.queueManualEdition(request)).toBe('queued');
    expect(await restarted.claimPublication()).toBeNull();
    now = new Date(+now + 10 * 60_000);
    expect(await store.queueManualEdition({ ...request, requestId: 'third' })).toBe('queued');
    const fenced = (await store.claimPublication())!;
    await store.configure({
      feed: 'daily',
      destination: { guildId: 'guild', channelId: 'elsewhere' },
    });
    expect(await store.beginSend(fenced)).toBeNull();
    const fail = (await store.claimPoll('aktuality', { manual: true }))!;
    await store.commitPoll(fail, { outcome: 'rate-limited', retryAt: new Date(+now + 3600000) });
    expect(await store.claimPoll('aktuality', { manual: true })).toBeNull();
  });
  it('configures, limits, removes cities and disables encrypted briefing routing', async () => {
    const store = createMongoBriefing(context, secret);
    expect(await store.get('guild')).toBeNull();
    expect(await store.subscriptions()).toEqual([]);
    await store.setHour('guild', 8);
    expect(await store.addCity('guild', city, 1)).toBe('added');
    expect(await store.addCity('guild', city, 1)).toBe('duplicate');
    expect(await store.addCity('guild', { ...city, name: 'Other', lat: 49 }, 1)).toBe('limit');
    const sub = await store.configure(destination);
    expect(store.destination(sub)).toEqual({ guildId: 'guild', channelId: 'channel' });
    expect(sub.hour).toBe(8);
    expect(await store.subscriptions()).toHaveLength(1);
    expect(await store.removeCity('guild', 'bratislava')).toBe(true);
    expect(await store.removeCity('guild', 'missing')).toBe(false);
    await store.disable('guild');
    expect(await store.subscriptions()).toEqual([]);
    expect(store.destination((await store.get('guild'))!)).toBeNull();
    await expect(store.setHour('guild', 22)).rejects.toThrow();
    await expect(store.addCity('guild', city, 9)).rejects.toThrow();
  });
  it('claims exactly one daily briefing across replicas and consumes it after send', async () => {
    const store = createMongoBriefing(context, secret),
      other = createMongoBriefing(context, secret);
    const sub = await store.configure(destination);
    expect(sub.hour).toBe(6);
    expect(await store.claim(sub, new Date(+now - 1))).toBeNull();
    const claims = await Promise.all([store.claim(sub, now), other.claim(sub, now)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!;
    expect(await other.beginSend({ ...claim, owner: 'stale' }, now)).toBeNull();
    expect(await store.beginSend(claim, now)).toEqual({ guildId: 'guild', channelId: 'channel' });
    await store.finishSend(claim, { outcome: 'sent', messageId: 'message' }, now);
    expect(await other.claim(sub, new Date(+now + 3_600_000))).toBeNull();
    expect((await store.get('guild'))?.lastDeliveredAt).toEqual(now);
  });
  it('recovers only unsent briefing claims and stops at the daily deadline', async () => {
    const store = createMongoBriefing(context, secret),
      sub = await store.configure(destination);
    const stale = (await store.claim(sub, now))!;
    now = new Date(+now + 121_000);
    const claim = (await store.claim(sub, now))!;
    expect(await store.beginSend(stale, now)).toBeNull();
    await store.beginSend(claim, now);
    now = new Date(+now + 121_000);
    expect(await store.claim(sub, now)).toBeNull();
    expect((await context.collections.briefingDeliveries.findOne({ _id: claim.key }))?.status).toBe(
      'uncertain',
    );
    expect(await store.claim(sub, new Date('2026-09-15T06:00:00Z'))).toBeNull();
  });
  it('waits for the fallback after a confirmed rejection and fences configuration changes', async () => {
    const store = createMongoBriefing(context, secret);
    const sub = await store.configure(destination);
    const first = (await store.claim(sub, now))!;
    await store.beginSend(first, now);
    await store.finishSend(first, { outcome: 'rejected' }, now);
    expect(await store.claim(sub, new Date(+now + 60_000))).toBeNull();
    now = new Date(+now + 3_600_000);
    const fallback = (await store.claim(sub, now))!;
    await store.configure({ guildId: 'guild', channelId: 'new' });
    expect(await store.beginSend(fallback, now)).toBeNull();
    await store.disable('guild');
    expect(await store.beginSend(fallback, now)).toBeNull();
  });
  it.each(['uncertain', 'destination-unavailable'] as const)(
    'parks briefing %s',
    async (outcome) => {
      const store = createMongoBriefing(context, secret),
        sub = await store.configure(destination);
      const claim = (await store.claim(sub, now))!;
      await store.beginSend(claim, now);
      await store.finishSend(claim, { outcome }, now);
      expect(await store.claim(sub, new Date(+now + 3_600_000))).toBeNull();
    },
  );
});
