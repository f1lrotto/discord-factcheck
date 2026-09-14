import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ChannelType, Collection, Events, PermissionFlagsBits, type Client } from 'discord.js';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as MongoModule from '../../src/mongo-store.js';
import type * as BotModule from '../../src/discord-bot.js';
import type * as RuntimeModule from '../../src/news/index.js';
import type { createMongoStore } from '../../src/mongo-store.js';
import type { createDiscordBot } from '../../src/discord-bot.js';
import type { createNewsRuntime } from '../../src/news/index.js';
import type { NewsHttp } from '../../src/news/http.js';
import { createAktualitySource, aktualityListingUrl } from '../../src/news/sources/aktuality.js';
import { createDenniknSource } from '../../src/news/sources/dennikn.js';

const state = vi.hoisted(() => ({ current: undefined as Harness | undefined }));
vi.mock('../../src/openrouter.js', () => ({
  createOpenRouter: () => ({ run: state.current!.modelRun }),
}));
vi.mock('../../src/mongo-store.js', async (original) => {
  const actual = await original<typeof MongoModule>();
  return {
    ...actual,
    createMongoStore: (...[input]: Parameters<typeof createMongoStore>) => {
      const h = state.current!;
      h.mongoInput = input;
      const store = actual.createMongoStore({
        ...input,
        ...(input.news ? { news: { ...input.news, clock: () => h.now } } : {}),
      });
      h.store = store;
      const initialize = store.initialize;
      store.initialize = async () => {
        await initialize();
        h.events.push('mongo initialized');
      };
      const close = store.close;
      store.close = async () => {
        h.events.push('mongo close');
        await close();
      };
      return store;
    },
  };
});
vi.mock('../../src/discord-bot.js', async (original) => {
  const actual = await original<typeof BotModule>();
  return {
    ...actual,
    createDiscordBot: (input: Parameters<typeof createDiscordBot>[0]) => {
      const h = state.current!;
      h.botInput = input;
      const bot = actual.createDiscordBot({
        ...input,
        client: h.client as unknown as Client,
        newsPublisherOptions: { makeRequest: h.discordHttp, clock: () => h.now },
      });
      h.bot = bot;
      const drain = bot.drain;
      bot.drain = async () => {
        await drain();
        h.events.push('discord drained');
      };
      return bot;
    },
  };
});
vi.mock('../../src/news/index.js', async (original) => {
  const actual = await original<typeof RuntimeModule>();
  return {
    ...actual,
    createNewsRuntime: (input: Parameters<typeof createNewsRuntime>[0]) => {
      const h = state.current!;
      h.runtimeInput = input;
      h.events.push('runtime created');
      const runtime = actual.createNewsRuntime({
        ...input,
        clock: () => h.now,
        sources: [createDenniknSource(h.sourceHttp), createAktualitySource(h.sourceHttp)],
        tickIntervalMs: 20,
      });
      const start = runtime.start;
      runtime.start = vi.fn(async () => {
        h.events.push('news start');
        await start();
      });
      const shutdown = runtime.shutdown;
      runtime.shutdown = vi.fn(async () => {
        await shutdown();
        h.events.push('news drained');
      });
      h.runtime = runtime;
      return runtime;
    },
  };
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const fixtures = new URL('./fixtures/publishers/', import.meta.url);
const makeHarness = (options: { login?: Promise<void>; stallPost?: boolean } = {}) => {
  const events: string[] = [];
  const cleanup = deferred();
  let ready = false;
  const client = Object.assign(new EventEmitter(), {
    user: { id: '300' },
    isReady: () => ready,
    guilds: {
      cache: new Collection([
        ['100', { id: '100', available: true, commands: { fetch: async () => new Collection() } }],
      ]),
    },
    application: { commands: { set: vi.fn(async () => {}) } },
    login: vi.fn(async () => {
      await options.login;
      ready = true;
      client.emit(Events.ClientReady, client);
      return 'test';
    }),
    destroy: vi.fn(() => {
      ready = false;
      events.push('discord destroyed');
    }),
  });
  const posts: Record<string, unknown>[] = [];
  const sourceHttp = vi.fn<NewsHttp>(async ({ url }) => ({
    outcome: 'ok',
    url,
    validators: {},
    html: await readFile(
      new URL(
        url === aktualityListingUrl ? 'aktuality-listing.html' : 'aktuality-edition.html',
        fixtures,
      ),
      'utf8',
    ),
  }));
  const discordHttp = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      if (options.stallPost)
        return new Response(
          new ReadableStream({
            cancel: async () => {
              events.push('body cleanup started');
              await cleanup.promise;
              events.push('body cleanup finished');
            },
          }),
        );
      return Response.json({ id: '600', channel_id: '200', nonce: body.nonce });
    }
    if (path.endsWith('/channels/200'))
      return Response.json({
        id: '200',
        guild_id: '100',
        type: ChannelType.GuildText,
        permission_overwrites: [],
      });
    if (path.endsWith('/roles'))
      return Response.json([
        {
          id: '100',
          mentionable: false,
          permissions: String(
            PermissionFlagsBits.ViewChannel |
              PermissionFlagsBits.SendMessages |
              PermissionFlagsBits.EmbedLinks,
          ),
        },
        { id: '400', permissions: '0', mentionable: true },
      ]);
    if (path.endsWith('/members/300')) return Response.json({ user: { id: '300' }, roles: [] });
    throw new Error('Unexpected Discord fixture request');
  });
  return {
    events,
    cleanup,
    client,
    posts,
    sourceHttp,
    discordHttp,
    modelRun: vi.fn(async () => {
      throw new Error('Unexpected model call');
    }),
    now: new Date('2026-09-11T17:59:59Z'),
    store: undefined as ReturnType<typeof createMongoStore> | undefined,
    mongoInput: undefined as Parameters<typeof createMongoStore>[0] | undefined,
    bot: undefined as ReturnType<typeof createDiscordBot> | undefined,
    botInput: undefined as Parameters<typeof createDiscordBot>[0] | undefined,
    runtime: undefined as ReturnType<typeof createNewsRuntime> | undefined,
    runtimeInput: undefined as Parameters<typeof createNewsRuntime>[0] | undefined,
  };
};
type Harness = ReturnType<typeof makeHarness>;
const command = (h: Harness, action = 'feed', group: string | null = 'daily') => {
  const editReply = vi.fn(async (payload: { content: string }) => payload);
  h.client.emit(Events.InteractionCreate, {
    id: randomUUID(),
    commandName: 'jolanda',
    guildId: '100',
    channelId: '999',
    user: { id: '300' },
    deferred: true,
    replied: false,
    isChatInputCommand: () => true,
    memberPermissions: { has: () => true },
    appPermissions: { has: () => false },
    options: {
      getSubcommandGroup: () => group,
      getSubcommand: () => action,
      getChannel: () => ({ id: '200', guildId: '100', type: ChannelType.GuildText }),
      getRole: () => ({ id: '400', guild: { id: '100' } }),
    },
    deferReply: vi.fn(async () => {}),
    editReply,
    reply: vi.fn(async () => {}),
  });
  return editReply;
};
const waitFor = async (assertion: () => void) =>
  vi.waitFor(assertion, { timeout: 5000, interval: 20 });

// Importing the CLI module must not connect to Mongo, log in, or install signal handlers.
const beforeImport = {
  interrupt: process.listenerCount('SIGINT'),
  terminate: process.listenerCount('SIGTERM'),
};
const { main } = await import('../../src/index.js');

describe('actual application startup wiring', () => {
  let replica: MongoMemoryReplSet;
  let inspector: MongoClient;
  const applications: Awaited<ReturnType<typeof main>>[] = [];
  beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    inspector = await new MongoClient(replica.getUri()).connect();
  });
  afterEach(async () => {
    state.current?.cleanup.resolve();
    for (const app of applications.splice(0)) await app.shutdown('test cleanup');
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    state.current = undefined;
  });
  afterAll(async () => {
    await inspector.close();
    await replica.stop();
  });
  const configure = (
    h: Harness,
    database = `application_${randomUUID().replaceAll('-', '')}`,
    enabled = true,
  ) => {
    state.current = h;
    for (const [name, value] of Object.entries({
      DATA_PROTECTION_SECRET: 'a'.repeat(32),
      DISCORD_TOKEN: 'fixture-token',
      OPENROUTER_API_KEY: 'fixture-key',
      MONGODB_URI: replica.getUri(),
      MONGODB_DB_NAME: database,
      INSTAGRAM_REELS_ENABLED: 'false',
      NEWS_ENABLED: String(enabled),
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
    }))
      vi.stubEnv(name, value);
    return database;
  };
  const start = async () => {
    const app = await main();
    applications.push(app);
    return app;
  };

  it('is import safe and keeps source and built pnpm start entrypoints executable', async () => {
    expect(state.current).toBeUndefined();
    expect(process.listenerCount('SIGINT')).toBe(beforeImport.interrupt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeImport.terminate);
    const cwd = fileURLToPath(new URL('../../', import.meta.url));
    const run = promisify(execFile);
    await run('pnpm', ['build'], { cwd });
    const env = {
      ...process.env,
      DATA_PROTECTION_SECRET: '',
      DISCORD_TOKEN: '',
      OPENROUTER_API_KEY: '',
      MONGODB_URI: '',
    };
    for (const [executable, args] of [
      [process.execPath, ['--import', 'tsx', 'src/index.ts']],
      ['pnpm', ['start']],
    ] as const) {
      await expect(run(executable, [...args], { cwd, env })).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('Jolanda failed to start'),
      });
    }
  });

  it('configures through the real bot, collects the captured daily edition, delivers once, and preserves status across a disabled restart', async () => {
    const h = makeHarness();
    const database = configure(h);
    const app = await start();
    expect(h.events.indexOf('mongo initialized')).toBeLessThan(h.events.indexOf('runtime created'));
    expect(h.mongoInput?.news?.secret).toBe('a'.repeat(32));
    expect(h.botInput?.newsStore).toBe(h.store?.news);
    expect(h.runtimeInput?.store).toBe(h.store?.news);
    expect(h.runtimeInput?.publisher).toBe(h.bot?.newsPublisher);
    await h.runtime!.tick();
    expect(h.sourceHttp).not.toHaveBeenCalled();
    expect(h.posts).toHaveLength(0);
    const configured = command(h);
    await waitFor(() =>
      expect(configured).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('feed enabled') }),
      ),
    );
    h.now = new Date('2026-09-11T18:00:00Z');
    await waitFor(() => expect(h.posts).toHaveLength(1));
    await waitFor(() => expect(h.events).toContain('news start'));
    await h.runtime!.tick();
    expect(h.sourceHttp.mock.calls.map(([input]) => input.url)).toHaveLength(2);
    expect(h.posts[0]).toMatchObject({
      content: '<@&400>',
      allowed_mentions: { parse: [], roles: ['400'] },
      embeds: expect.any(Array),
    });
    expect(JSON.stringify(h.posts[0])).toContain('aktuality.sk');
    expect(
      (await h.store!.news!.getSource('aktuality')).daily?.collectedEdition?.sections,
    ).toHaveLength(7);
    const receipts = await inspector.db(database).collection('news_publications').find().toArray();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      status: 'sent',
      messageKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(receipts[0]).not.toHaveProperty('content');
    expect(h.modelRun).not.toHaveBeenCalled();
    await app.shutdown('restart');
    expect(h.events.indexOf('news drained')).toBeLessThan(h.events.indexOf('discord drained'));
    expect(h.events.indexOf('discord drained')).toBeLessThan(h.events.indexOf('discord destroyed'));
    expect(h.events.indexOf('discord destroyed')).toBeLessThan(h.events.indexOf('mongo close'));
    const restarted = makeHarness();
    configure(restarted, database, false);
    await start();
    expect(restarted.runtimeInput?.enabled).toBe(false);
    expect(restarted.botInput?.newsEnabled).toBe(false);
    const status = command(restarted, 'status');
    await waitFor(() => expect(status).toHaveBeenCalled());
    const text = status.mock.calls[0]![0].content;
    expect(text).toContain('<#200>');
    expect(text).toContain('disabled');
    expect(text).toContain('Pending deliveries: **0**');
    expect(text).toContain('Stored edition:');
    const privacy = command(restarted, 'privacy', null);
    await waitFor(() => expect(privacy).toHaveBeenCalled());
    expect(privacy.mock.calls[0]![0].content).toContain('OpenRouter');
    await restarted.runtime!.tick();
    expect(restarted.sourceHttp).not.toHaveBeenCalled();
    expect(restarted.posts).toHaveLength(0);
    expect(restarted.modelRun).not.toHaveBeenCalled();
  });

  it('does not start news when login resolves after a signal has drained the application', async () => {
    const gate = deferred();
    const h = makeHarness({ login: gate.promise });
    configure(h);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const starting = start();
    await waitFor(() => expect(h.client.login).toHaveBeenCalled());
    process.emit('SIGTERM');
    await waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    gate.resolve();
    await starting;
    expect(h.runtime!.start).not.toHaveBeenCalled();
    expect(h.sourceHttp).not.toHaveBeenCalled();
    expect(h.events.indexOf('news drained')).toBeLessThan(h.events.indexOf('mongo close'));
    expect(process.listenerCount('SIGINT')).toBe(beforeImport.interrupt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeImport.terminate);
  });

  it('drains news and removes signal listeners on login failure', async () => {
    const h = makeHarness();
    h.client.login.mockRejectedValueOnce(new Error('fixture login failure'));
    configure(h);
    await expect(main()).rejects.toThrow('fixture login failure');
    expect(h.runtime!.start).not.toHaveBeenCalled();
    expect(h.events.indexOf('news drained')).toBeLessThan(h.events.indexOf('discord destroyed'));
    expect(h.events).toContain('mongo close');
    expect(process.listenerCount('SIGINT')).toBe(beforeImport.interrupt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeImport.terminate);
  });

  it('holds shared dependencies open until native publisher cancellation cleanup drains', async () => {
    const h = makeHarness({ stallPost: true });
    const database = configure(h);
    await start();
    const configured = command(h);
    await waitFor(() => expect(configured).toHaveBeenCalled());
    h.now = new Date('2026-09-11T18:00:00Z');
    await waitFor(() => expect(h.posts).toHaveLength(1));
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    process.emit('SIGTERM');
    await waitFor(() => expect(h.events).toContain('body cleanup started'));
    expect(h.events).not.toContain('discord destroyed');
    expect(h.events).not.toContain('mongo close');
    expect(exit).not.toHaveBeenCalled();
    h.cleanup.resolve();
    await waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(h.events.indexOf('body cleanup finished')).toBeLessThan(
      h.events.indexOf('news drained'),
    );
    expect(h.events.indexOf('news drained')).toBeLessThan(h.events.indexOf('mongo close'));
    expect(await inspector.db(database).collection('news_publications').findOne()).toMatchObject({
      status: 'uncertain',
    });
  });
});
