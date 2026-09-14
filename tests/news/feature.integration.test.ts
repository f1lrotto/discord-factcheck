import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCommandHandler } from '../../src/discord-commands.js';
import { createMongoStore } from '../../src/mongo-store.js';
import { getCollections } from '../../src/mongo-schema.js';
import { createNewsDiscordPublisher } from '../../src/news/discord.js';
import type { NewsHttp } from '../../src/news/http.js';
import { createNewsRuntime } from '../../src/news/index.js';
import { createAktualitySource, aktualityListingUrl } from '../../src/news/sources/aktuality.js';
import { createDenniknSource, denniknListingUrl } from '../../src/news/sources/dennikn.js';
import { createIdentifierProtector } from '../../src/security.js';
import type { NewsFeed } from '../../src/news/types.js';

const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const listing = read('publishers/aktuality-listing.html');
const originalEdition = read('publishers/aktuality-edition.html');
const originalPost = JSON.parse(read('dennikn/synthetic-post.json')) as Record<string, unknown>;
const at = (time: string, day = '2026-09-14') => new Date(`${day}T${time}Z`);
const logger = pino({ enabled: false });
const secret = 'feature-integration-only-secret';
const protectIdentifier = createIdentifierProtector(secret);
const permissions =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.EmbedLinks;
const story = (id: number, important = true) => ({
  ...originalPost,
  id,
  isImportant: important,
  url: `https://dennikn.sk/minuta/${id}/`,
});
const envelope = (posts: Record<string, unknown>[]) =>
  `<script>window.__INITIAL_STATE__=${JSON.stringify({ postsApi: { queries: { 'getInfinitePosts({"important":1,"language":"sk"})': { data: { pages: [{ posts }] } } } } }).replaceAll('<', '\\u003c')};</script>`;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

// These journeys use actual command dispatch, source adapters, Mongo transactions and Discord
// publisher/rendering. Only the clock, publisher HTML responses and Discord REST are substituted.
// All moved timestamps, observations, destinations and transport outcomes below are synthetic.
describe('whole news journeys from native command configuration to durable delivery', () => {
  let replicaSet: MongoMemoryReplSet;
  const cleanups: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  afterAll(async () => {
    await replicaSet.stop();
  });

  const harness = async () => {
    const databaseName = `feature-${randomUUID()}`;
    const state = {
      now: at('17:00:00'),
      ready: true,
      posts: [story(90001)] as Record<string, unknown>[],
      daily: 'fresh' as 'fresh' | 'stale' | 'denied',
      editionDay: '2026-09-14',
      earlyEdition: false,
      deniedChannels: new Set<string>(),
      postOutcome: 'sent' as 'sent' | 'rate-limited' | 'uncertain',
      postGate: undefined as ReturnType<typeof deferred> | undefined,
      postEntered: undefined as ReturnType<typeof deferred> | undefined,
    };
    const published: { channel: string; body: ReturnType<typeof JSON.parse>; at: Date }[] = [];
    const channels = new Map([
      ['200', '100'],
      ['201', '100'],
      ['202', '100'],
      ['210', '101'],
      ['211', '101'],
    ]);
    const sourceHttp = vi.fn<NewsHttp>(async ({ url }) => {
      if (url === denniknListingUrl)
        return { outcome: 'ok', url, html: envelope(state.posts), validators: {} };
      if (state.daily === 'denied') return { outcome: 'access-denied' };
      return {
        outcome: 'ok',
        url,
        validators: { etag: 'fixture' },
        html:
          url === aktualityListingUrl
            ? listing
            : state.daily === 'stale'
              ? originalEdition
              : originalEdition
                  .replaceAll('2026-09-11', state.editionDay)
                  .replaceAll('17:13:38', state.earlyEdition ? '16:13:38' : '17:13:38')
                  .replaceAll('19:13:38', state.earlyEdition ? '18:13:38' : '19:13:38'),
      };
    });
    const discordHttp = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      const id = path.split('/')[4]!;
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        published.push({ channel: id, body, at: new Date(state.now) });
        state.postEntered?.resolve();
        await state.postGate?.promise;
        if (state.postOutcome === 'uncertain')
          throw new Error('Synthetic response lost after acceptance');
        if (state.postOutcome === 'rate-limited')
          return new Response('{"retry_after":60}', { status: 429 });
        return new Response(
          JSON.stringify({ id: String(600 + published.length), channel_id: id, nonce: body.nonce }),
        );
      }
      if (path.includes('/channels/')) {
        if (state.deniedChannels.has(id)) return new Response('{}', { status: 403 });
        return new Response(
          JSON.stringify({
            id,
            guild_id: channels.get(id),
            type: ChannelType.GuildText,
            permission_overwrites: [],
          }),
        );
      }
      if (path.endsWith('/roles'))
        return new Response(
          JSON.stringify([
            { id, permissions: String(permissions), mentionable: false },
            { id: '400', permissions: '0', mentionable: true },
            { id: '401', permissions: '0', mentionable: true },
          ]),
        );
      if (path.includes('/members/'))
        return new Response(JSON.stringify({ user: { id: '300' }, roles: [] }));
      throw new Error('Unexpected synthetic Discord route');
    });
    const open = async () => {
      const client = new MongoClient(replicaSet.getUri());
      const store = createMongoStore(
        {
          uri: replicaSet.getUri(),
          databaseName,
          dailyLimitMicrodollars: 1_000_000,
          monthlyLimitMicrodollars: 10_000_000,
          promptsPerMinute: 3,
          transcriptTtlMs: 60_000,
          instanceId: randomUUID(),
          protectIdentifier,
          logger,
          news: { secret, clock: () => state.now },
        },
        { client },
      );
      await store.initialize();
      const collections = getCollections(client.db(databaseName));
      const publisher = createNewsDiscordPublisher({
        client: { isReady: () => state.ready, user: { id: '300' } },
        token: 'synthetic-token',
        clock: () => state.now,
        makeRequest: discordHttp,
      });
      const runtime = createNewsRuntime({
        store: store.news!,
        publisher,
        logger,
        clock: () => state.now,
        sources: [createDenniknSource(sourceHttp), createAktualitySource(sourceHttp)],
      });
      const handler = createCommandHandler({
        store,
        news: { store: store.news!, publisher, enabled: true, clock: () => state.now },
        logger,
        protectIdentifier,
        transcriptTtlDays: 7,
        maximumContextMessages: 50,
      });
      const command = async (
        feed: NewsFeed,
        options: {
          guild?: string;
          channel?: string;
          role?: string;
          action?: string;
          manage?: boolean;
          selectedGuild?: string;
        } = {},
      ) => {
        const guildId = options.guild ?? '100';
        const channelId = options.channel ?? (feed === 'daily' ? '201' : '200');
        const raw = {
          id: randomUUID(),
          commandName: 'jolanda',
          guildId,
          channelId: '999',
          user: { id: '300' },
          deferred: true,
          replied: false,
          isChatInputCommand: () => true,
          memberPermissions: {
            has: (bit: bigint) =>
              bit === PermissionFlagsBits.ManageGuild && options.manage !== false,
          },
          appPermissions: { has: () => false },
          options: {
            getSubcommandGroup: () => feed,
            getSubcommand: () => options.action ?? 'feed',
            getChannel: () => ({
              id: channelId,
              guildId: options.selectedGuild ?? guildId,
              type: ChannelType.GuildText,
              name: 'same-name',
            }),
            getRole: () => (options.role ? { id: options.role, guild: { id: guildId } } : null),
          },
          deferReply: vi.fn(async () => {}),
          reply: vi.fn(async (input: unknown) => input),
          editReply: vi.fn(async (input: { content: string }) => input),
        };
        await handler(raw as unknown as ChatInputCommandInteraction);
        return { ...raw, text: raw.editReply.mock.calls.at(-1)?.[0].content ?? '' };
      };
      let closed = false;
      const close = async () => {
        if (closed) return;
        await runtime.shutdown();
        publisher.close();
        await store.close();
        closed = true;
      };
      cleanups.push(close);
      return { store, collections, publisher, runtime, command, close };
    };
    return {
      state,
      published,
      sourceHttp,
      discordHttp,
      open,
      first: await open(),
      dailyRequests: () =>
        sourceHttp.mock.calls.filter(([input]) => input.source === 'aktuality').length,
    };
  };

  it('persists both configured feeds across restart, isolates a late second guild and shares source requests', async () => {
    const h = await harness();
    await h.first.command('continuous');
    await h.first.command('daily', { role: '400' });
    await h.first.runtime.tick();
    expect(h.published).toHaveLength(0); // First continuous snapshot is only a baseline.
    await h.first.close();
    const restarted = await h.open();
    h.state.now = at('17:20:00');
    h.state.posts.push(story(90002));
    await restarted.runtime.tick();
    expect(h.published.map((post) => post.channel)).toEqual(['200']);
    h.state.now = at('17:21:00');
    await restarted.command('continuous', { guild: '101', channel: '210' });
    await restarted.command('daily', { guild: '101', channel: '211' });
    await restarted.runtime.tick();
    expect(h.sourceHttp).toHaveBeenCalledTimes(2);
    expect(h.published).toHaveLength(1);
    h.state.now = at('17:40:00');
    h.state.posts.push(story(90003));
    await restarted.runtime.tick();
    expect(h.sourceHttp).toHaveBeenCalledTimes(3);
    expect(
      h.published.filter((post) => post.channel === '210').map((post) => post.body.embeds[0].url),
    ).toEqual(['https://dennikn.sk/minuta/90003/']);
    h.state.now = at('18:00:00');
    const competitor = await h.open();
    await Promise.all([restarted.runtime.tick(), competitor.runtime.tick()]);
    expect(h.dailyRequests()).toBe(2); // One listing and one candidate for both guilds.
    expect(h.sourceHttp.mock.calls.filter(([input]) => input.source === 'dennikn')).toHaveLength(4);
    expect(h.published.filter((post) => ['201', '211'].includes(post.channel))).toHaveLength(2);
    const daily = h.published.find((post) => post.channel === '201')!.body;
    expect(daily.content).toBe('<@&400>');
    expect(daily.allowed_mentions).toEqual({
      parse: [],
      roles: ['400'],
      users: [],
      replied_user: false,
    });
    expect(daily.embeds).toHaveLength(1);
    expect(daily.embeds[0]).toMatchObject({
      timestamp: '2026-09-14T17:13:38.000Z',
      url: expect.stringContaining('aktuality.sk/clanok/'),
      title: expect.stringContaining('denný výber'),
    });
    expect(daily.embeds[0].description.split('\n\n')).toHaveLength(8); // Introduction plus seven editorial headings.
    for (const post of h.published.filter((post) => ['200', '210'].includes(post.channel))) {
      expect(post.body.flags).toBe(MessageFlags.SuppressNotifications);
      expect(post.body.content).toBeUndefined();
      expect(post.body.allowed_mentions.parse).toEqual([]);
    }
    h.state.now = at('19:00:00');
    await restarted.runtime.tick();
    expect(h.dailyRequests()).toBe(2);
    expect(await restarted.collections.newsPublications.countDocuments({ status: 'sent' })).toBe(5);
    expect((await restarted.command('daily', { guild: '101', action: 'status' })).text).toContain(
      '<#211>',
    );
    expect(
      (await restarted.command('daily', { guild: '101', action: 'status' })).text,
    ).not.toContain('<#201>');
  });

  it('enforces administration and selected-channel ownership before durable mutation', async () => {
    const h = await harness();
    const denied = await h.first.command('daily', { manage: false });
    expect(denied.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: expect.stringContaining('Manage Server'),
      }),
    );
    expect(h.discordHttp).not.toHaveBeenCalled();
    await h.first.command('daily', { selectedGuild: '101', channel: '211' });
    expect(h.discordHttp).not.toHaveBeenCalled();
    await h.first.command('daily', { channel: '211' }); // REST, not the option's claim, owns guild identity.
    h.state.deniedChannels.add('201');
    expect((await h.first.command('daily')).text).toContain('could not validate');
    expect(await h.first.collections.newsSubscriptions.countDocuments()).toBe(0);
    h.state.deniedChannels.clear();
    const valid = await h.first.command('daily');
    expect(valid.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(valid.text).toContain('<#201>');
    const stored = JSON.stringify(await h.first.collections.newsSubscriptions.find().toArray());
    expect(stored).not.toContain('"channelId"');
    expect(stored).not.toContain('"guildId"');
  });

  it.each(['17:00:00', '18:30:00', '19:30:00', '20:00:00'])(
    'joins only the remaining daily opportunity when first enabled at UTC %s without a cache',
    async (time) => {
      const h = await harness();
      h.state.now = at(time);
      await h.first.command('daily');
      await h.first.runtime.tick();
      const evening = ['18:30:00', '19:30:00'].includes(time);
      expect(h.dailyRequests()).toBe(evening ? 2 : 0);
      expect(h.published).toHaveLength(evening ? 1 : 0);
      if (time === '17:00:00') {
        h.state.now = at('18:00:00');
        await h.first.runtime.tick();
        expect(h.published).toHaveLength(1);
      }
      const slots = (await h.first.store.news!.getSource('aktuality')).daily?.attemptedSlots ?? [];
      expect(slots).toEqual(
        time === '20:00:00'
          ? []
          : [
              JSON.stringify([
                'aktuality',
                '2026-09-14',
                time === '19:30:00' ? 'fallback' : 'primary',
              ]),
            ],
      );
    },
  );

  it.each(['17:00:00', '18:30:00', '19:30:00', '20:00:00'])(
    'uses a current cached edition only inside the send window when enabled at UTC %s',
    async (time) => {
      const h = await harness();
      h.state.earlyEdition = true;
      await h.first.command('daily');
      h.state.ready = false;
      h.state.now = at('18:00:00');
      await h.first.runtime.tick();
      await h.first.command('daily', { action: 'disable' });
      // The pre-20:00 defensive cache case uses a synthetic clock rewind. No ordinary
      // scheduler can have collected today's edition before its own 20:00 primary.
      h.state.now = at(time);
      expect(
        (await h.first.store.news!.getSource('aktuality')).daily?.collectedEdition?.publishedAt,
      ).toEqual(at('16:13:38'));
      h.state.ready = true;
      await h.first.command('daily', { guild: '101', channel: '211' });
      await h.first.runtime.tick();
      expect(h.dailyRequests()).toBe(2);
      expect(h.published).toHaveLength(['18:30:00', '19:30:00'].includes(time) ? 1 : 0);
      if (time === '17:00:00') {
        h.state.now = at('18:00:00');
        await h.first.runtime.tick();
        expect(h.published).toHaveLength(1);
        expect(h.dailyRequests()).toBe(2);
      }
    },
  );

  it.each([true, false])(
    'uses one fallback after stale primary, with fresh fallback=%s',
    async (freshFallback) => {
      const h = await harness();
      await h.first.command('daily');
      h.state.now = at('18:00:00');
      h.state.daily = 'stale';
      await h.first.runtime.tick();
      expect(h.published).toHaveLength(0);
      await h.first.close();
      const restarted = await h.open();
      h.state.now = at('19:00:00');
      if (freshFallback) h.state.daily = 'fresh';
      await restarted.runtime.tick();
      h.state.now = at('19:30:00');
      await restarted.runtime.tick();
      h.state.now = at('20:00:00');
      await restarted.runtime.tick();
      expect(h.dailyRequests()).toBe(4);
      expect(h.published).toHaveLength(freshFallback ? 1 : 0);
      expect(
        (await restarted.store.news!.getSource('aktuality')).daily?.attemptedSlots,
      ).toHaveLength(2);
    },
  );

  it('does not reset a completed missing-primary slot when another guild joins at 20:30', async () => {
    const h = await harness();
    await h.first.command('daily');
    h.state.now = at('18:00:00');
    h.state.daily = 'stale';
    await h.first.runtime.tick();
    h.state.now = at('18:30:00');
    await h.first.command('daily', { guild: '101', channel: '211' });
    await h.first.runtime.tick();
    expect(h.dailyRequests()).toBe(2);
    expect(h.published).toHaveLength(0);
    h.state.now = at('19:00:00');
    h.state.daily = 'fresh';
    await h.first.runtime.tick();
    expect(h.dailyRequests()).toBe(4);
    expect(h.published.map((post) => post.channel).sort()).toEqual(['201', '211']);
  });

  it('expires a Discord outage at 22:00 and never scrapes fallback or sends the edition next morning', async () => {
    const h = await harness();
    await h.first.command('daily');
    h.state.now = at('18:00:00');
    h.state.postOutcome = 'rate-limited';
    await h.first.runtime.tick();
    expect(await h.first.collections.newsPublications.countDocuments({ status: 'pending' })).toBe(
      1,
    );
    await h.first.close();
    const restarted = await h.open();
    h.state.now = at('19:00:00');
    await restarted.runtime.tick();
    expect(h.published).toHaveLength(2); // Both are confirmed rejected POST attempts, not messages.
    expect(new Set(h.published.map((post) => post.body.nonce)).size).toBe(1);
    expect(h.dailyRequests()).toBe(2);
    h.state.now = at('20:00:00');
    h.state.postOutcome = 'sent';
    await restarted.runtime.tick();
    h.state.now = at('06:00:00', '2026-09-15');
    await restarted.runtime.tick();
    expect(h.published).toHaveLength(2);
    expect(h.dailyRequests()).toBe(2);
    expect(await restarted.collections.newsPublications.countDocuments({ status: 'expired' })).toBe(
      1,
    );
  });

  it.each(['sent', 'uncertain'] as const)(
    'keeps a %s daily tombstone across disable, new routing and restart',
    async (outcome) => {
      const h = await harness();
      await h.first.command('daily', { role: '400' });
      h.state.now = at('18:00:00');
      h.state.postOutcome = outcome;
      await h.first.runtime.tick();
      expect(await h.first.collections.newsPublications.countDocuments({ status: outcome })).toBe(
        1,
      );
      await h.first.command('daily', { action: 'disable' });
      await h.first.close();
      const restarted = await h.open();
      h.state.now = at('18:30:00');
      h.state.postOutcome = 'sent';
      await restarted.command('daily', { channel: '202', role: '401' });
      await restarted.runtime.tick();
      h.state.now = at('19:00:00');
      await restarted.runtime.tick();
      expect(h.published).toHaveLength(1);
      expect(h.dailyRequests()).toBe(2);
      const status = await restarted.command('daily', { action: 'status' });
      expect(status.text).toContain(`<#202>`);
      expect(status.text).toContain(`Uncertain deliveries: **${outcome === 'uncertain' ? 1 : 0}**`);
    },
  );

  it('fences a queued revision and re-renders only unsent daily work with the replacement channel and role', async () => {
    const h = await harness();
    await h.first.command('daily', { role: '400' });
    h.state.now = at('18:00:00');
    h.state.ready = false;
    await h.first.runtime.tick();
    const staleClaim = await h.first.store.news!.claimPublication();
    expect(staleClaim).not.toBeNull();
    h.state.ready = true;
    await h.first.command('daily', { channel: '202', role: '401' });
    expect(await h.first.store.news!.beginSend(staleClaim!)).toBeNull();
    await h.first.runtime.tick();
    expect(h.published).toHaveLength(1);
    expect(h.published[0]!.channel).toBe('202');
    expect(h.published[0]!.body.content).toBe('<@&401>');
    expect(h.published[0]!.body.allowed_mentions.roles).toEqual(['401']);
    expect(h.dailyRequests()).toBe(2);
  });

  it('cancels queued work on disable and replans a never-sent edition on explicit re-enable', async () => {
    const h = await harness();
    await h.first.command('daily');
    h.state.now = at('18:00:00');
    h.state.ready = false;
    await h.first.runtime.tick();
    const claim = await h.first.store.news!.claimPublication();
    await h.first.command('daily', { action: 'disable' });
    h.state.ready = true;
    expect(await h.first.store.news!.beginSend(claim!)).toBeNull();
    await h.first.runtime.tick();
    expect(h.published).toHaveLength(0);
    expect(
      await h.first.collections.newsSubscriptions.findOne({ enabled: false }),
    ).not.toHaveProperty('destination');
    h.state.now = at('18:30:00');
    await h.first.command('daily', { channel: '202' });
    await h.first.runtime.tick();
    expect(h.published.map((post) => post.channel)).toEqual(['202']);
    expect(h.dailyRequests()).toBe(2);
  });

  it('preserves acceptance when disable races an already-issued Discord request', async () => {
    const h = await harness();
    await h.first.command('daily');
    h.state.now = at('18:00:00');
    h.state.postGate = deferred();
    h.state.postEntered = deferred();
    const tick = h.first.runtime.tick();
    await h.state.postEntered.promise;
    try {
      await h.first.command('daily', { action: 'disable' });
      expect(h.published).toHaveLength(1);
    } finally {
      h.state.postGate.resolve();
    }
    await tick;
    expect(await h.first.collections.newsPublications.countDocuments({ status: 'sent' })).toBe(1);
    await h.first.command('daily');
    await h.first.runtime.tick();
    expect(h.published).toHaveLength(1);
  });

  it('pauses a permission-lost destination without blocking another guild and resumes only after revalidation', async () => {
    const h = await harness();
    await h.first.command('daily');
    await h.first.command('daily', { guild: '101', channel: '211' });
    h.state.deniedChannels.add('201');
    h.state.now = at('18:00:00');
    await h.first.runtime.tick();
    expect(h.published.map((post) => post.channel)).toEqual(['211']);
    expect((await h.first.command('daily', { action: 'status' })).text).toContain(
      'destination-unavailable',
    );
    const requests = h.discordHttp.mock.calls.length;
    await h.first.runtime.tick();
    expect(h.discordHttp).toHaveBeenCalledTimes(requests);
    h.state.deniedChannels.clear();
    await h.first.command('daily');
    await h.first.runtime.tick();
    expect(h.published.map((post) => post.channel).sort()).toEqual(['201', '211']);
    expect(h.dailyRequests()).toBe(2);
  });

  it('respects publisher denial backoff while continuous news and dedicated status remain usable', async () => {
    const h = await harness();
    await h.first.command('continuous');
    await h.first.command('daily');
    await h.first.runtime.tick();
    h.state.now = at('18:00:00');
    h.state.daily = 'denied';
    h.state.posts.push(story(90002));
    await h.first.runtime.tick();
    expect(h.published.map((post) => post.channel)).toEqual(['200']);
    const budget = vi
      .spyOn(h.first.store, 'getBudgetSummary')
      .mockRejectedValue(new Error('Synthetic accounting outage'));
    expect((await h.first.command('daily', { action: 'status' })).text).toContain(
      'Publisher denied access',
    );
    expect(budget).not.toHaveBeenCalled();
    h.state.now = at('19:00:00');
    await h.first.runtime.tick();
    expect(h.dailyRequests()).toBe(1);
    expect(h.published).toHaveLength(1);
  });

  it('deduplicates corrections and importance promotion and drains the complete real outbox batch before restart', async () => {
    const h = await harness();
    h.state.posts = [story(90001), story(90002, false)];
    await h.first.command('continuous');
    await h.first.runtime.tick();
    h.state.now = at('17:20:00');
    h.state.posts = [story(90001), story(90002), story(90002)];
    await h.first.runtime.tick();
    expect(h.published.map((post) => post.body.embeds[0].url)).toEqual([
      'https://dennikn.sk/minuta/90002/',
    ]);
    h.state.now = at('17:40:00');
    h.state.posts = [
      { ...story(90002), excerpt: '<p><strong>Corrected public headline.</strong></p>' },
      ...Array.from({ length: 25 }, (_, index) => story(90100 + index)),
    ];
    await h.first.runtime.tick();
    expect(h.published).toHaveLength(26);
    await h.first.close();
    const restarted = await h.open();
    for (const minute of [0, 20, 40]) {
      h.state.now = at(`18:${String(minute).padStart(2, '0')}:00`);
      await restarted.runtime.tick();
      await restarted.runtime.tick();
    }
    for (const minute of [0, 20, 40]) {
      h.state.now = at(`19:${String(minute).padStart(2, '0')}:00`);
      await restarted.runtime.tick();
    }
    expect(h.published).toHaveLength(26); // One promotion plus the full 25-story batch.
    expect(new Set(h.published.map((post) => post.body.embeds[0].url)).size).toBe(26);
    expect(h.published.slice(1).every((post) => +post.at === +at('17:40:00'))).toBe(true);
    expect(
      await restarted.collections.newsPublications.countDocuments({
        status: { $in: ['pending', 'claimed', 'sending'] },
      }),
    ).toBe(0);
    expect(
      (await restarted.collections.newsObservations.findOne({ 'story.id': '90002' }))?.story.title,
    ).toBe('Corrected public headline.');
  });

  it.each([
    ['2026-01-15', '19:00:00'],
    ['2026-07-15', '18:00:00'],
    ['2026-03-29', '18:00:00'],
    ['2026-10-25', '19:00:00'],
  ])(
    'persists the correct Bratislava date and primary across restart on %s',
    async (day, utcPrimary) => {
      const h = await harness();
      h.state.editionDay = day;
      h.state.now = new Date(+at(utcPrimary, day) - 1000);
      await h.first.command('daily');
      await h.first.runtime.tick();
      expect(h.dailyRequests()).toBe(0);
      h.state.now = at(utcPrimary, day);
      await h.first.runtime.tick();
      expect(h.published).toHaveLength(1);
      expect((await h.first.store.news!.getSource('aktuality')).daily?.attemptedSlots).toEqual([
        JSON.stringify(['aktuality', day, 'primary']),
      ]);
      await h.first.close();
      const restarted = await h.open();
      h.state.now = new Date(+h.state.now + 60 * 60_000);
      await restarted.runtime.tick();
      expect(h.dailyRequests()).toBe(2);
      expect(h.published).toHaveLength(1);
      const publication = await restarted.collections.newsPublications.findOne({ status: 'sent' });
      expect(publication?._id).toContain(day);
    },
  );
});
