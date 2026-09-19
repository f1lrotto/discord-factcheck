import { randomUUID } from 'node:crypto';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createReleaseStore } from '../src/releases/store.js';

const secret = 'release-store-test-secret';
const firstRelease = '2026-09-18T12:00:00Z';
const secondRelease = '2026-09-19T12:00:00Z';
const route = { guildId: 'private-guild-a', channelId: 'private-channel-a' };

describe('release store', () => {
  let server: MongoMemoryServer;
  let client: MongoClient;
  let database: Db;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    client = await new MongoClient(server.getUri()).connect();
  });
  beforeEach(() => {
    database = client.db(`releases-${randomUUID()}`);
  });
  afterAll(async () => {
    await client.close();
    await server.stop();
  });

  it('encrypts tenant routing and handles concurrent first configuration', async () => {
    const stores = [createReleaseStore(database, secret), createReleaseStore(database, secret)];
    const configured = await Promise.all([
      stores[0]!.configure(route),
      stores[1]!.configure({ ...route, channelId: 'private-channel-b' }),
    ]);
    const saved = await stores[0]!.get(route.guildId);
    const latest = configured.find(({ revision }) => revision === 2)!;
    expect(saved?.revision).toBe(2);
    expect(configured.map(({ revision }) => revision).sort()).toEqual([1, 2]);
    expect(stores[0]!.destination(saved!)).toEqual(stores[0]!.destination(latest));
    expect(await stores[0]!.get('private-guild-b')).toBeNull();

    const documents = await database.collection('release_subscriptions').find().toArray();
    expect(documents).toHaveLength(1);
    expect(documents[0]?.destination).toMatchObject({ version: 1 });
    expect(JSON.stringify(documents)).not.toMatch(/private-(guild|channel)/);
    expect(() => createReleaseStore(database, 'wrong-secret').destination(saved!)).toThrow(
      'authentication failed',
    );
  });

  it('atomically claims once and suppresses restart duplicates and rollbacks', async () => {
    const store = createReleaseStore(database, secret);
    const subscription = await store.configure(route);
    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        createReleaseStore(database, secret).beginSend(subscription, firstRelease),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await createReleaseStore(database, secret).beginSend(subscription, firstRelease)).toBe(
      false,
    );

    await store.finishSend(subscription, firstRelease, 'sent');
    expect(await store.beginSend(subscription, '2026-09-17T12:00:00Z')).toBe(false);
    expect(await store.beginSend(subscription, secondRelease)).toBe(true);
    await store.finishSend(subscription, secondRelease, 'uncertain');
    expect(await store.beginSend(subscription, secondRelease)).toBe(false);
  });

  it('retries confirmed rejection while fencing disable and reconfiguration', async () => {
    const store = createReleaseStore(database, secret);
    const original = await store.configure(route);
    expect(await store.beginSend(original, firstRelease)).toBe(true);
    await store.finishSend(original, firstRelease, 'rejected');
    expect(await createReleaseStore(database, secret).beginSend(original, firstRelease)).toBe(true);
    await store.finishSend(original, firstRelease, 'rejected');

    await store.disable(route.guildId);
    expect(await store.beginSend(original, secondRelease)).toBe(false);
    const disabled = (await store.get(route.guildId))!;
    expect(disabled).toMatchObject({
      enabled: false,
      lastReleaseId: firstRelease,
      lastOutcome: 'rejected',
    });
    expect(store.destination(disabled)).toBeNull();

    const reconfigured = await store.configure({ ...route, channelId: 'private-channel-c' });
    expect(await store.beginSend(original, secondRelease)).toBe(false);
    expect(await store.beginSend(reconfigured, secondRelease)).toBe(true);
    const changedAgain = await store.configure({ ...route, channelId: 'private-channel-d' });
    await store.finishSend(reconfigured, secondRelease, 'sent');
    const settled = (await store.get(route.guildId))!;
    expect(settled).toMatchObject({
      revision: changedAgain.revision,
      enabled: true,
      lastReleaseId: secondRelease,
      lastOutcome: 'sent',
    });
    expect(store.destination(settled)).toEqual({ ...route, channelId: 'private-channel-d' });
  });
});
