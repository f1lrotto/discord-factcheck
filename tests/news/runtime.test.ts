import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIndexes, getCollections } from '../../src/mongo-schema.js';
import { createNewsDiscordPublisher } from '../../src/news/discord.js';
import type { NewsHttp } from '../../src/news/http.js';
import { createNewsRuntime } from '../../src/news/index.js';
import { createMongoNews } from '../../src/news/mongo.js';
import { createAktualitySource, aktualityListingUrl } from '../../src/news/sources/aktuality.js';
import { createDenniknSource } from '../../src/news/sources/dennikn.js';
import type { NewsPublisher, NewsSource, NewsStore } from '../../src/news/types.js';

const at = (time: string) => new Date(`2026-09-14T${time}Z`);
const destination = { guildId: '100', channelId: '200' };
const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const listing = read('publishers/aktuality-listing.html');
const staleEdition = read('publishers/aktuality-edition.html');
// Timestamp changes below are synthetic; publisher structures and original fixtures are preserved.
const freshEdition = staleEdition.replaceAll('2026-09-11', '2026-09-14');
const post = JSON.parse(read('dennikn/synthetic-post.json')) as Record<string, unknown>;
const snapshot = (ids: number[]) =>
  `<script>window.__INITIAL_STATE__=${JSON.stringify({
    postsApi: {
      queries: {
        'getInfinitePosts({"important":1,"language":"sk"})': {
          data: {
            pages: [
              {
                posts: ids.map((id) => ({ ...post, id, url: `https://dennikn.sk/minuta/${id}/` })),
              },
            ],
          },
        },
      },
    },
  })};</script>`;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const logger = () => ({ info: vi.fn(), error: vi.fn() });
const quietPublisher = (): NewsPublisher => ({
  ready: () => false,
  validateDestination: async () => true,
  publish: vi.fn<NewsPublisher['publish']>(async () => ({ outcome: 'sent', messageId: '600' })),
});
const fixtureDaily = () => {
  const http = vi.fn<NewsHttp>(async ({ url }) => ({
    outcome: 'ok',
    url,
    html: url === aktualityListingUrl ? listing : freshEdition,
    validators: { etag: 'fresh' },
  }));
  return { http, source: createAktualitySource(http) };
};
const fakeStore = () =>
  ({
    configure: vi.fn<NewsStore['configure']>(),
    disable: vi.fn<NewsStore['disable']>(),
    removeGuild: vi.fn<NewsStore['removeGuild']>(),
    getSubscription: vi.fn<NewsStore['getSubscription']>(),
    getDestination: vi.fn<NewsStore['getDestination']>(),
    listEnabled: vi.fn<NewsStore['listEnabled']>().mockResolvedValue([]),
    getSource: vi.fn<NewsStore['getSource']>(),
    claimPoll: vi.fn<NewsStore['claimPoll']>().mockResolvedValue(null),
    commitPoll: vi.fn<NewsStore['commitPoll']>().mockResolvedValue(true),
    planPublications: vi.fn<NewsStore['planPublications']>().mockResolvedValue(),
    claimPublication: vi.fn<NewsStore['claimPublication']>().mockResolvedValue(null),
    beginSend: vi.fn<NewsStore['beginSend']>().mockResolvedValue(null),
    finishSend: vi.fn<NewsStore['finishSend']>().mockResolvedValue(),
    getDeliveryCounts: vi.fn<NewsStore['getDeliveryCounts']>(),
  }) satisfies NewsStore;

describe('news coordinator with real Mongo, source parsers and Discord publisher', () => {
  let replicaSet: MongoMemoryReplSet;
  let databaseName: string;
  let instant: Date;
  const clients: MongoClient[] = [];
  const runtimes: ReturnType<typeof createNewsRuntime>[] = [];
  const publishers: ReturnType<typeof createNewsDiscordPublisher>[] = [];
  beforeAll(async () => {
    replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  });
  beforeEach(() => {
    databaseName = `runtime-${randomUUID()}`;
    instant = at('18:00:00');
  });
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
    publishers.splice(0).forEach((publisher) => publisher.close());
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
    const store = createMongoNews(
      {
        client,
        collections,
        protectIdentifier: (value: string) => value,
        logger: pino({ enabled: false }),
      },
      { secret: 'runtime-test-secret', clock: () => instant, leaseMs },
    );
    await store.initialize();
    return { store, collections };
  };
  const discord = (hook?: typeof fetch) => {
    const client = { isReady: vi.fn(() => true), user: { id: '300' } };
    const makeRequest = vi.fn<typeof fetch>(async (url, init) => {
      if (hook) return hook(url, init);
      const data =
        init?.method === 'POST'
          ? {
              id: '600',
              channel_id: new URL(String(url)).pathname.split('/')[4],
              nonce: JSON.parse(String(init.body)).nonce,
            }
          : String(url).endsWith('/roles')
            ? [
                {
                  id: '100',
                  permissions: String(
                    PermissionFlagsBits.ViewChannel |
                      PermissionFlagsBits.SendMessages |
                      PermissionFlagsBits.EmbedLinks,
                  ),
                  mentionable: false,
                },
              ]
            : String(url).includes('/members/')
              ? { user: { id: '300' }, roles: [] }
              : {
                  id: new URL(String(url)).pathname.split('/')[4],
                  guild_id: '100',
                  type: ChannelType.GuildText,
                  permission_overwrites: [],
                };
      return new Response(JSON.stringify(data));
    });
    const publisher = createNewsDiscordPublisher({
      client,
      token: 'not-a-real-token',
      clock: () => instant,
      makeRequest,
    });
    publishers.push(publisher);
    return {
      publisher,
      makeRequest,
      client,
      posts: () => makeRequest.mock.calls.filter(([, init]) => init?.method === 'POST'),
    };
  };
  const runtime = (
    store: NewsStore,
    options: Partial<Parameters<typeof createNewsRuntime>[0]> = {},
  ) => {
    const result = createNewsRuntime({
      store,
      publisher: quietPublisher(),
      logger: logger(),
      sources: [],
      clock: () => instant,
      ...options,
    });
    runtimes.push(result);
    return result;
  };

  it('performs no source or Discord requests for an idle installation or kill switch', async () => {
    const { store } = await open();
    const daily = fixtureDaily();
    const d = discord();
    await runtime(store, { sources: [daily.source], publisher: d.publisher }).tick();
    await store.configure({ feed: 'daily', destination });
    await runtime(store, {
      sources: [daily.source],
      publisher: d.publisher,
      enabled: false,
    }).tick();
    expect(daily.http).not.toHaveBeenCalled();
    expect(d.makeRequest).not.toHaveBeenCalled();
  });

  it('collects once for two destinations across competing runtime instances and sends one message per subscription', async () => {
    const a = await open();
    const b = await open();
    await a.store.configure({ feed: 'daily', destination });
    await a.store.configure({ feed: 'daily', destination: { guildId: '101', channelId: '201' } });
    // A transport fake covers different guild IDs while exercising the production publisher elsewhere.
    const publish = vi.fn<NewsPublisher['publish']>(async () => ({
      outcome: 'sent',
      messageId: '600',
    }));
    const publisher = { ...quietPublisher(), ready: () => true, publish };
    const daily = fixtureDaily();
    await Promise.all([
      runtime(a.store, { sources: [daily.source], publisher }).tick(),
      runtime(b.store, { sources: [daily.source], publisher }).tick(),
    ]);
    expect(daily.http).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(new Set(publish.mock.calls.map(([input]) => input.destination.channelId))).toEqual(
      new Set(['200', '201']),
    );
    expect(await a.collections.newsPublications.countDocuments({ status: 'sent' })).toBe(2);
    expect((await a.store.getSource('aktuality')).daily?.attemptedSlots).toHaveLength(1);
  });

  it('uses fixture adapters and production rendering/publisher for daily delivery, then suppresses fallback after restart', async () => {
    const { store, collections } = await open();
    const sub = await store.configure({ feed: 'daily', destination });
    const daily = fixtureDaily();
    const d = discord();
    const first = runtime(store, { sources: [daily.source], publisher: d.publisher });
    await first.tick();
    expect(d.posts()).toHaveLength(1);
    const body = JSON.parse(String(d.posts()[0]![1]!.body));
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0].title).toContain('denný výber');
    expect(body.allowed_mentions.parse).toEqual([]);
    expect(await store.getDeliveryCounts(sub.key)).toEqual({ pending: 0, uncertain: 0 });
    expect(await collections.newsPublications.countDocuments({ status: 'sent' })).toBe(1);
    await first.shutdown();
    instant = at('19:00:00');
    const restarted = await open();
    await runtime(restarted.store, { sources: [daily.source], publisher: d.publisher }).tick();
    expect(daily.http).toHaveBeenCalledTimes(2);
    expect(d.posts()).toHaveLength(1);
  });

  it.each([
    ['17:59:00', 0, undefined],
    ['18:30:00', 2, 'primary'],
    ['19:30:00', 2, 'fallback'],
    ['20:00:00', 0, undefined],
  ])(
    'recovers only the correct Slovak daily collection slot at UTC %s',
    async (time, count, kind) => {
      instant = at(time!);
      const { store } = await open();
      await store.configure({ feed: 'daily', destination });
      const daily = fixtureDaily();
      const r = runtime(store, { sources: [daily.source] });
      await r.tick();
      await r.tick();
      expect(daily.http).toHaveBeenCalledTimes(count!);
      const state = await store.getSource('aktuality');
      if (kind)
        expect(state.daily?.attemptedSlots).toEqual([
          JSON.stringify(['aktuality', '2026-09-14', kind]),
        ]);
      else expect(state.daily?.attemptedSlots ?? []).toEqual([]);
    },
  );

  it('preserves a stale candidate and validators across restart for conditional listing fallback', async () => {
    const { store } = await open();
    await store.configure({ feed: 'daily', destination });
    const http = vi.fn<NewsHttp>(async ({ url }) =>
      url === aktualityListingUrl && instant >= at('19:00:00')
        ? { outcome: 'unchanged', validators: { etag: 'listing' } }
        : {
            outcome: 'ok',
            url,
            html:
              url === aktualityListingUrl
                ? listing
                : instant < at('19:00:00')
                  ? staleEdition
                  : freshEdition,
            validators: { etag: url === aktualityListingUrl ? 'listing' : 'candidate' },
          },
    );
    const source = createAktualitySource(http);
    const first = runtime(store, { sources: [source] });
    await first.tick();
    expect((await store.getSource('aktuality')).lastOutcome).toBe('stale');
    await first.shutdown();
    instant = at('19:00:00');
    const d = discord();
    await runtime((await open()).store, { sources: [source], publisher: d.publisher }).tick();
    expect(http).toHaveBeenCalledTimes(4);
    expect(http.mock.calls[2]![0].validators).toEqual({ etag: 'listing' });
    expect(http.mock.calls[3]![0].validators).toEqual({ etag: 'candidate' });
    expect(d.posts()).toHaveLength(1);
    expect((await store.getSource('aktuality')).daily?.attemptedSlots).toHaveLength(2);
  });

  it('preserves continuous activation, cadence, deduplication and pacing after process restart', async () => {
    const { store } = await open();
    await store.configure({ feed: 'continuous', destination });
    let ids = [90001];
    const http = vi.fn<NewsHttp>(async ({ url }) => ({
      outcome: 'ok',
      url,
      html: snapshot(ids),
      validators: { etag: 'continuous' },
    }));
    const source = createDenniknSource(http);
    const d = discord();
    const first = runtime(store, { sources: [source], publisher: d.publisher });
    await first.tick();
    expect(d.posts()).toHaveLength(0);
    ids = [90001, 90002, 90003];
    instant = at('18:20:00');
    await first.tick();
    expect(d.posts()).toHaveLength(1);
    await first.shutdown();
    instant = at('18:21:00');
    const second = runtime((await open()).store, { sources: [source], publisher: d.publisher });
    await second.tick();
    expect(http).toHaveBeenCalledTimes(2);
    expect(d.posts()).toHaveLength(1);
    instant = at('18:40:00');
    await second.tick();
    expect(http).toHaveBeenCalledTimes(3);
    expect(http.mock.calls[2]![0].validators).toEqual({ etag: 'continuous' });
    expect(d.posts()).toHaveLength(2);
    expect(d.posts().map(([, init]) => JSON.parse(String(init!.body)).embeds[0].url)).toEqual([
      'https://dennikn.sk/minuta/90002/',
      'https://dennikn.sk/minuta/90003/',
    ]);
  });

  it('delivers stored daily news while another source stalls, and records timeout without error contents', async () => {
    const { store } = await open();
    await store.configure({ feed: 'daily', destination });
    await store.configure({ feed: 'continuous', destination });
    const daily = fixtureDaily();
    const d = discord();
    const logs = logger();
    const slow: NewsSource = {
      id: 'dennikn',
      collect: vi.fn<NewsSource['collect']>(
        ({ signal }) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve({ outcome: 'cancelled' }), {
              once: true,
            });
          }),
      ),
    };
    const r = runtime(store, {
      sources: [slow, daily.source],
      publisher: d.publisher,
      collectionTimeoutMs: 100,
      logger: logs,
    });
    await r.tick();
    expect(d.posts()).toHaveLength(1);
    expect((await store.getSource('dennikn')).lastOutcome).toBe('timeout');
    expect((await store.getSource('aktuality')).lastOutcome).toBe('edition');
    const serialized = JSON.stringify([logs.info.mock.calls, logs.error.mock.calls]);
    expect(serialized).not.toContain(destination.guildId);
    expect(serialized).not.toContain('Matúš');
    expect(serialized).not.toContain('not-a-real-token');
  });

  it('records unexpected source errors without leaking raw errors and leaves other sources working', async () => {
    const { store } = await open();
    await store.configure({ feed: 'daily', destination });
    await store.configure({ feed: 'continuous', destination });
    const logs = logger();
    const d = discord();
    const failing: NewsSource = {
      id: 'dennikn',
      collect: async () => {
        throw new Error('private channel 200 raw-body');
      },
    };
    await runtime(store, {
      sources: [failing, fixtureDaily().source],
      publisher: d.publisher,
      logger: logs,
    }).tick();
    expect((await store.getSource('dennikn')).lastOutcome).toBe('unavailable');
    expect(d.posts()).toHaveLength(1);
    expect(JSON.stringify(logs.info.mock.calls)).not.toContain('raw-body');
  });

  it('respects remaining lease after Mongo reads and leaves commit allowance', async () => {
    const { store } = await open();
    await store.configure({ feed: 'daily', destination });
    const daily = fixtureDaily();
    const getSource: NewsStore['getSource'] = async (id) => {
      const result = await store.getSource(id);
      instant = new Date(+instant + 45_000);
      return result;
    };
    await runtime({ ...store, getSource }, { sources: [daily.source] }).tick();
    expect(daily.http).not.toHaveBeenCalled();
    expect((await store.getSource('aktuality')).lastOutcome).toBe('timeout');
    expect((await store.getSource('aktuality')).lease).toBeUndefined();
  });

  it('checks readiness before admission and preserves the stored edition for a later ready tick', async () => {
    const { store } = await open();
    await store.configure({ feed: 'daily', destination });
    const begin = vi.spyOn(store, 'beginSend');
    const daily = fixtureDaily();
    const d = discord();
    d.client.isReady.mockReturnValue(false);
    const r = runtime(store, { sources: [daily.source], publisher: d.publisher });
    await r.tick();
    expect(begin).not.toHaveBeenCalled();
    expect(d.makeRequest).not.toHaveBeenCalled();
    instant = at('19:00:00');
    d.client.isReady.mockReturnValue(true);
    await r.tick();
    expect(d.posts()).toHaveLength(1);
    expect(daily.http).toHaveBeenCalledTimes(2);
  });

  it('records unknown publisher throws as uncertain and never blindly retries them', async () => {
    const { store, collections } = await open();
    await store.configure({ feed: 'daily', destination });
    const publish = vi.fn<NewsPublisher['publish']>(async () => {
      throw new Error('request lost after acceptance');
    });
    const r = runtime(store, {
      sources: [fixtureDaily().source],
      publisher: { ...quietPublisher(), ready: () => true, publish },
    });
    await r.tick();
    instant = at('19:00:00');
    await r.tick();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await collections.newsPublications.countDocuments({ status: 'uncertain' })).toBe(1);
  });

  it('leaves failed receipt persistence in sending until durable recovery marks it uncertain', async () => {
    const { store, collections } = await open();
    const sub = await store.configure({ feed: 'daily', destination });
    const d = discord();
    const broken = {
      ...store,
      finishSend: vi
        .fn<NewsStore['finishSend']>()
        .mockRejectedValue(new Error('database disconnected')),
    };
    await runtime(broken, { sources: [fixtureDaily().source], publisher: d.publisher }).tick();
    expect(await collections.newsPublications.countDocuments({ status: 'sending' })).toBe(1);
    instant = at('18:01:00');
    expect(await store.getDeliveryCounts(sub.key)).toEqual({ pending: 0, uncertain: 1 });
    await runtime(store, { publisher: d.publisher }).tick();
    expect(d.posts()).toHaveLength(1);
  });

  it('retries confirmed rejection from the same stored edition and expires at the daily cutoff', async () => {
    const { store, collections } = await open();
    await store.configure({ feed: 'daily', destination });
    const publish = vi.fn<NewsPublisher['publish']>(async () => ({ outcome: 'rejected' }));
    const daily = fixtureDaily();
    const r = runtime(store, {
      sources: [daily.source],
      publisher: { ...quietPublisher(), ready: () => true, publish },
    });
    await r.tick();
    await r.tick();
    expect(publish).toHaveBeenCalledTimes(1);
    instant = at('19:59:30');
    await r.tick();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(await collections.newsPublications.countDocuments({ status: 'expired' })).toBe(1);
    instant = at('20:00:00');
    await r.tick();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(daily.http).toHaveBeenCalledTimes(2);
  });

  it('aborts a production publisher preflight at the daily deadline without any POST', async () => {
    instant = at('19:59:59.900');
    const { store, collections } = await open();
    await store.configure({ feed: 'daily', destination });
    const beginSend: NewsStore['beginSend'] = async (claim) => {
      const value = await store.beginSend(claim);
      instant = at('19:59:59.950');
      return value;
    };
    const d = discord(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true,
          });
        }),
    );
    await runtime(
      { ...store, beginSend },
      { sources: [fixtureDaily().source], publisher: d.publisher },
    ).tick();
    expect(d.makeRequest).toHaveBeenCalledTimes(1);
    expect(d.posts()).toHaveLength(0);
    expect(await collections.newsPublications.countDocuments({ status: 'pending' })).toBe(0);
  });

  it('does not invoke the publisher if admission finishes at the replay deadline or readiness drops', async () => {
    instant = at('19:59:59.900');
    const { store } = await open();
    await store.configure({ feed: 'daily', destination });
    const d = discord();
    const beginSend: NewsStore['beginSend'] = async (claim) => {
      const value = await store.beginSend(claim);
      instant = at('20:00:00');
      return value;
    };
    await runtime(
      { ...store, beginSend },
      { sources: [fixtureDaily().source], publisher: d.publisher },
    ).tick();
    expect(d.makeRequest).not.toHaveBeenCalled();
  });

  it('retains a collection finishing after 22:00 without admitting a late daily send', async () => {
    instant = at('19:59:59');
    const { store, collections } = await open();
    await store.configure({ feed: 'daily', destination });
    const daily = fixtureDaily();
    const source: NewsSource = {
      ...daily.source,
      collect: async (input) => {
        const result = await daily.source.collect(input);
        instant = at('20:00:00');
        return result;
      },
    };
    const d = discord();
    await runtime(store, { sources: [source], publisher: d.publisher }).tick();
    expect((await store.getSource('aktuality')).daily?.collectedEdition).toBeDefined();
    expect(d.makeRequest).not.toHaveBeenCalled();
    expect(await collections.newsPublications.countDocuments()).toBe(0);
  });

  it('does not begin a network send when admission has consumed its remaining lease budget', async () => {
    const { store, collections } = await open();
    await store.configure({ feed: 'daily', destination });
    const beginSend: NewsStore['beginSend'] = async (claim) => {
      const value = await store.beginSend(claim);
      instant = new Date(+instant + 45_000);
      return value;
    };
    const d = discord();
    await runtime(
      { ...store, beginSend },
      { sources: [fixtureDaily().source], publisher: d.publisher },
    ).tick();
    expect(d.makeRequest).not.toHaveBeenCalled();
    expect(await collections.newsPublications.countDocuments({ status: 'pending' })).toBe(1);
  });

  it('bounds work per tick and lets other destinations progress on later ticks', async () => {
    const { store, collections } = await open();
    for (const channel of ['200', '201', '202'])
      await store.configure({
        feed: 'daily',
        destination: { guildId: channel, channelId: channel },
      });
    const publish = vi.fn<NewsPublisher['publish']>(async () => ({
      outcome: 'sent',
      messageId: '600',
    }));
    const r = runtime(store, {
      sources: [fixtureDaily().source],
      maxDeliveriesPerTick: 1,
      publisher: { ...quietPublisher(), ready: () => true, publish },
    });
    await r.tick();
    expect(publish).toHaveBeenCalledTimes(1);
    await r.tick();
    await r.tick();
    expect(await collections.newsPublications.countDocuments({ status: 'sent' })).toBe(3);
  });

  it('pauses inaccessible destinations and avoids repeated public failures and source work', async () => {
    const { store } = await open();
    const sub = await store.configure({ feed: 'daily', destination });
    const publish = vi.fn<NewsPublisher['publish']>(async () => ({
      outcome: 'destination-unavailable',
    }));
    const daily = fixtureDaily();
    const r = runtime(store, {
      sources: [daily.source],
      publisher: { ...quietPublisher(), ready: () => true, publish },
    });
    await r.tick();
    await r.tick();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(
      await store.getSubscription({ guildId: destination.guildId, feed: 'daily' }),
    ).toMatchObject({ key: sub.key, pausedReason: 'destination-unavailable' });
    expect(daily.http).toHaveBeenCalledTimes(2);
  });

  it('shutdown aborts source requests, drains the cancelled outcome, and restarts with a fresh signal', async () => {
    const { store } = await open();
    await store.configure({ feed: 'daily', destination });
    const entered = deferred<AbortSignal>();
    const collect = vi.fn<NewsSource['collect']>(({ signal }) => {
      entered.resolve(signal);
      return new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve({ outcome: 'cancelled' }), { once: true }),
      );
    });
    const r = runtime(store, { sources: [{ id: 'aktuality', collect }] });
    const tick = r.tick();
    const signal = await entered.promise;
    await r.shutdown();
    await tick;
    expect(signal.aborted).toBe(true);
    expect((await store.getSource('aktuality')).lastOutcome).toBe('cancelled');
    instant = at('19:00:00');
    collect.mockImplementation(async ({ signal }) => {
      expect(signal.aborted).toBe(false);
      return { outcome: 'empty', cache: {} };
    });
    await r.start();
    await r.tick();
    await r.shutdown();
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('waits for delayed cooperative source cleanup and its Mongo commit during shutdown', async () => {
    const { store } = await open();
    await store.configure({ feed: 'daily', destination });
    const entered = deferred<AbortSignal>();
    const cleanup = deferred<void>();
    const commitEntered = deferred<void>();
    const commitRelease = deferred<void>();
    const source: NewsSource = {
      id: 'aktuality',
      collect: ({ signal }) => {
        entered.resolve(signal);
        return new Promise((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              void cleanup.promise.then(() => resolve({ outcome: 'cancelled' }));
            },
            { once: true },
          ),
        );
      },
    };
    const commitPoll: NewsStore['commitPoll'] = async (claim, result) => {
      commitEntered.resolve();
      await commitRelease.promise;
      return store.commitPoll(claim, result);
    };
    const r = runtime({ ...store, commitPoll }, { sources: [source] });
    const tick = r.tick();
    await entered.promise;
    let drained = false;
    const shutdown = r.shutdown().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    cleanup.resolve();
    await commitEntered.promise;
    expect(drained).toBe(false);
    commitRelease.resolve();
    await shutdown;
    await tick;
    expect(drained).toBe(true);
    expect((await store.getSource('aktuality')).lastOutcome).toBe('cancelled');
  });

  it('records safe rejection without invoking publish when readiness drops during admission', async () => {
    const { store, collections } = await open();
    await store.configure({ feed: 'daily', destination });
    const d = discord();
    const beginSend: NewsStore['beginSend'] = async (claim) => {
      const value = await store.beginSend(claim);
      d.client.isReady.mockReturnValue(false);
      return value;
    };
    await runtime(
      { ...store, beginSend },
      { sources: [fixtureDaily().source], publisher: d.publisher },
    ).tick();
    expect(d.makeRequest).not.toHaveBeenCalled();
    expect(await collections.newsPublications.countDocuments({ status: 'pending' })).toBe(1);
  });

  it('shutdown during sending aborts transport and persists an uncertain outcome before returning', async () => {
    const { store, collections } = await open();
    await store.configure({ feed: 'daily', destination });
    const entered = deferred<AbortSignal>();
    const cleanup = deferred<void>();
    const publish: NewsPublisher['publish'] = async ({ signal }) => {
      entered.resolve(signal);
      return new Promise((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            void cleanup.promise.then(() => resolve({ outcome: 'uncertain' }));
          },
          { once: true },
        ),
      );
    };
    const r = runtime(store, {
      sources: [fixtureDaily().source],
      publisher: { ...quietPublisher(), ready: () => true, publish },
    });
    const tick = r.tick();
    const signal = await entered.promise;
    let drained = false;
    const shutdown = r.shutdown().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    cleanup.resolve();
    await shutdown;
    await tick;
    expect(signal.aborted).toBe(true);
    expect(await collections.newsPublications.countDocuments({ status: 'uncertain' })).toBe(1);
  });
});

describe('news runtime lifecycle and bounded work', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it('rejects nonfinite, fractional and excessive limits and duplicate sources', () => {
    const input = { store: fakeStore(), publisher: quietPublisher(), logger: logger() };
    for (const tickIntervalMs of [NaN, Infinity, 0, -1, 60_001, 1.5])
      expect(() => createNewsRuntime({ ...input, tickIntervalMs })).toThrow(
        'Invalid news runtime limit',
      );
    const source: NewsSource = {
      id: 'dennikn',
      collect: async () => ({ outcome: 'empty', cache: {} }),
    };
    expect(() => createNewsRuntime({ ...input, sources: [source, source] })).toThrow('unique');
  });

  it('does not overlap ticks and drains in-flight Mongo reads before shutdown returns', async () => {
    const store = fakeStore();
    const read = deferred<Awaited<ReturnType<NewsStore['listEnabled']>>>();
    store.listEnabled.mockReturnValue(read.promise);
    const r = createNewsRuntime({ store, publisher: quietPublisher(), logger: logger() });
    const first = r.tick();
    expect(r.tick()).toBe(first);
    let drained = false;
    const shutdown = r.shutdown().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(store.listEnabled).toHaveBeenCalledTimes(1);
    read.resolve([]);
    await shutdown;
    expect(drained).toBe(true);
    await r.tick();
    expect(store.listEnabled).toHaveBeenCalledTimes(1);
  });

  it('makes repeated starts/stops idempotent, bounds polling, and leaves no timers', async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const r = createNewsRuntime({
      store,
      publisher: quietPublisher(),
      logger: logger(),
      tickIntervalMs: 1000,
    });
    await Promise.all([r.start(), r.start()]);
    await r.tick();
    expect(store.listEnabled).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(store.listEnabled).toHaveBeenCalledTimes(4);
    await Promise.all([r.shutdown(), r.shutdown()]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(store.listEnabled).toHaveBeenCalledTimes(4);
    await r.start();
    await r.tick();
    expect(store.listEnabled).toHaveBeenCalledTimes(5);
    await r.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('serializes a requested restart behind shutdown drainage and does not close its publisher', async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const read = deferred<Awaited<ReturnType<NewsStore['listEnabled']>>>();
    store.listEnabled.mockReturnValueOnce(read.promise);
    const publisher = { ...quietPublisher(), close: vi.fn() };
    const r = createNewsRuntime({ store, publisher, logger: logger() });
    await r.start();
    const shutdown = r.shutdown();
    const restart = r.start();
    read.resolve([]);
    await shutdown;
    await restart;
    await r.tick();
    expect(store.listEnabled).toHaveBeenCalledTimes(2);
    await r.shutdown();
    expect(publisher.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('isolates database failures and logs only a finite stage without exception contents', async () => {
    const store = fakeStore();
    store.listEnabled.mockRejectedValueOnce(new Error('secret-destination response-body'));
    const logs = logger();
    const r = createNewsRuntime({ store, publisher: quietPublisher(), logger: logs });
    await expect(r.tick()).resolves.toBeUndefined();
    await r.tick();
    expect(logs.error).toHaveBeenCalledWith({ event: 'news_runtime_failed', stage: 'tick' });
    expect(JSON.stringify(logs.error.mock.calls)).not.toContain('secret-destination');
    await r.shutdown();
  });
});
