import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  ApplicationCommandOptionType,
  ChannelType,
  Collection,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Client,
} from 'discord.js';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCommand, createCommandHandler } from '../../src/discord-commands.js';
import { createDiscordBot } from '../../src/discord-bot.js';
import { createMongoStore } from '../../src/mongo-store.js';
import { NewsDecryptionError } from '../../src/news/cipher.js';
import { createNewsDiscordPublisher } from '../../src/news/discord.js';
import type {
  NewsDestination,
  NewsFeed,
  NewsPublisher,
  NewsSourceState,
  NewsStore,
  NewsSubscription,
} from '../../src/news/types.js';
import type { Jolanda } from '../../src/jolanda.js';
import type { JolandaStore } from '../../src/types.js';

const guildId = '100';
const channelId = '200';
const roleId = '400';
const selected = { id: channelId, guildId, name: 'news', type: ChannelType.GuildText };
const at = (time: string, date = '2026-09-14') => new Date(`${date}T${time}Z`);
const logger = pino({ enabled: false });
const legacyStore = () =>
  ({
    getSettings: vi.fn(async () => ({
      guildId,
      model: 'luna',
      reasoning: 'medium',
      contextLimitMessages: 0,
      locale: 'en',
    })),
    getBudgetSummary: vi.fn(async () => ({
      dailyUsedMicrodollars: 0,
      dailyReservedMicrodollars: 0,
      monthlyUsedMicrodollars: 0,
      monthlyReservedMicrodollars: 0,
    })),
    updateSettings: vi.fn(),
  }) as unknown as JolandaStore;
const interaction = (
  options: {
    group?: string | null;
    action?: string;
    manage?: boolean;
    channel?: object;
    role?: object | null;
    guildId?: string | null;
  } = {},
) => {
  const editReply = vi.fn(
    async (payload: { content: string; allowedMentions?: unknown }) => payload,
  );
  const deferReply = vi.fn(async () => {});
  const reply = vi.fn(async () => {});
  const raw = {
    id: '123',
    commandName: 'jolanda',
    guildId: options.guildId === undefined ? guildId : options.guildId,
    channelId: '999',
    user: { id: '300' },
    deferred: true,
    replied: false,
    memberPermissions: {
      has: (permission: bigint) =>
        permission === PermissionFlagsBits.ManageGuild && (options.manage ?? true),
    },
    appPermissions: { has: vi.fn(() => false) },
    isChatInputCommand: () => true,
    options: {
      getSubcommandGroup: () => (options.group === undefined ? 'continuous' : options.group),
      getSubcommand: () => options.action ?? 'feed',
      getChannel: vi.fn(() => options.channel ?? selected),
      getRole: vi.fn(() => options.role ?? null),
      getInteger: vi.fn(),
      getString: vi.fn(),
    },
    editReply,
    deferReply,
    reply,
  };
  return {
    raw,
    value: raw as unknown as ChatInputCommandInteraction,
    text: () => editReply.mock.calls.at(-1)?.[0].content ?? '',
  };
};
const fixture = (
  options: { enabled?: boolean; now?: Date; news?: NewsStore; legacy?: JolandaStore } = {},
) => {
  const subscriptions = new Map<string, NewsSubscription>();
  const destinations = new Map<string, NewsDestination>();
  const sources: Record<string, NewsSourceState> = {
    dennikn: { source: 'dennikn', nextAttemptAt: new Date(0), failures: 0, cache: {} },
    aktuality: { source: 'aktuality', nextAttemptAt: new Date(0), failures: 0, cache: {} },
  };
  const key = (guild: string, feed: NewsFeed) => `${guild}:${feed}`;
  const store = {
    configure: vi.fn<NewsStore['configure']>(async ({ feed, destination }) => {
      const id = key(destination.guildId, feed);
      const subscription: NewsSubscription = {
        key: id,
        feed,
        revision: (subscriptions.get(id)?.revision ?? 0) + 1,
        enabled: true,
        activatedAt: options.now ?? at('17:00:00'),
        baseline: null,
        nextDeliveryAt: new Date(0),
      };
      subscriptions.set(id, subscription);
      destinations.set(id, destination);
      return subscription;
    }),
    getSubscription: vi.fn<NewsStore['getSubscription']>(
      async ({ guildId, feed }) => subscriptions.get(key(guildId, feed)) ?? null,
    ),
    getDestination: vi.fn<NewsStore['getDestination']>(async ({ subscriptionKey, revision }) =>
      subscriptions.get(subscriptionKey)?.enabled &&
      subscriptions.get(subscriptionKey)?.revision === revision
        ? (destinations.get(subscriptionKey) ?? null)
        : null,
    ),
    getSource: vi.fn<NewsStore['getSource']>(async (source) => sources[source]!),
    getDeliveryCounts: vi.fn<NewsStore['getDeliveryCounts']>(async () => ({
      pending: 0,
      uncertain: 0,
    })),
    disable: vi.fn<NewsStore['disable']>(async ({ guildId, feed }) => {
      const subscription = subscriptions.get(key(guildId, feed));
      if (subscription) subscription.enabled = false;
      destinations.delete(key(guildId, feed));
    }),
    removeGuild: vi.fn<NewsStore['removeGuild']>(async (guild) => {
      for (const feed of ['continuous', 'daily'] as const) {
        const subscription = subscriptions.get(key(guild, feed));
        if (subscription) subscription.enabled = false;
        destinations.delete(key(guild, feed));
      }
    }),
    listEnabled: vi.fn<NewsStore['listEnabled']>(async () =>
      [...subscriptions.values()].filter((subscription) => subscription.enabled),
    ),
  };
  const publisher = {
    validateDestination: vi.fn<NewsPublisher['validateDestination']>(async () => true),
  };
  const legacy = options.legacy ?? legacyStore();
  const news = options.news ?? (store as unknown as NewsStore);
  const handler = createCommandHandler({
    store: legacy,
    news: {
      store: news,
      publisher,
      enabled: options.enabled ?? true,
      clock: () => options.now ?? at('17:00:00'),
    },
    logger,
    protectIdentifier: (value) => `hash-${value}`,
    transcriptTtlDays: 7,
    maximumContextMessages: 50,
  });
  return { handler, store, news, publisher, legacy, subscriptions, destinations, sources };
};

describe('news command definitions and authorization', () => {
  it('registers native text/announcement selectors, optional daily role and independent status/disable groups', () => {
    const command = createCommand(50).toJSON();
    expect(command.name).toBe('jolanda');
    expect(command.default_member_permissions).toBeUndefined(); // Privacy remains public.
    for (const feed of ['continuous', 'daily']) {
      const group = command.options!.find((option) => option.name === feed)!;
      expect(group.type).toBe(ApplicationCommandOptionType.SubcommandGroup);
      if (group.type !== ApplicationCommandOptionType.SubcommandGroup)
        throw new Error('Missing group');
      expect(group.options!.map((option) => option.name)).toEqual([
        'feed',
        'disable',
        'status',
        ...(feed === 'daily' ? ['run'] : []),
      ]);
      expect(group.options![0]!.options![0]).toMatchObject({
        name: 'channel',
        type: ApplicationCommandOptionType.Channel,
        required: true,
        channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
      });
      expect(group.options![0]!.options?.some((option) => option.name === 'notify-role')).toBe(
        feed === 'daily',
      );
      if (feed === 'daily')
        expect(group.options![0]!.options![1]).toMatchObject({
          type: ApplicationCommandOptionType.Role,
          required: false,
        });
    }
    expect(command.options!.map((option) => option.name)).toEqual(
      expect.arrayContaining(['privacy', 'settings', 'reels', 'model', 'context-limit']),
    );
  });
  it.each(['feed', 'disable', 'status', 'run'])(
    'requires Manage Server for %s while using the guild language',
    async (action) => {
      const f = fixture();
      const i = interaction({ action, manage: false });
      await f.handler(i.value);
      expect(i.raw.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Manage Server') }),
      );
      expect(f.store.configure).not.toHaveBeenCalled();
      expect(f.store.getSource).not.toHaveBeenCalled();
      expect(i.raw.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    },
  );
  it('configures selected channel B from invocation A even when invocation permissions deny access', async () => {
    const f = fixture();
    const i = interaction();
    await f.handler(i.value);
    expect(f.publisher.validateDestination).toHaveBeenCalledWith({ guildId, channelId });
    expect(f.store.configure).toHaveBeenCalledWith({
      feed: 'continuous',
      destination: { guildId, channelId },
    });
    expect(f.publisher.validateDestination.mock.invocationCallOrder[0]).toBeLessThan(
      f.store.configure.mock.invocationCallOrder[0]!,
    );
    expect(i.raw.appPermissions.has).not.toHaveBeenCalled();
    expect(i.text()).toContain('<#200>');
    expect(i.text()).toContain('silent');
    expect(i.raw.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(i.raw.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ allowedMentions: { parse: [], repliedUser: false } }),
    );
  });
  it.each(['missing Embed Links', 'missing Send Messages', 'role removed', 'role unmentionable'])(
    'never persists a destination rejected for %s',
    async () => {
      const f = fixture();
      f.publisher.validateDestination.mockResolvedValue(false);
      const i = interaction({ group: 'daily', role: { id: roleId } });
      await f.handler(i.value);
      expect(f.store.configure).not.toHaveBeenCalled();
      expect(i.text()).toContain('could not validate');
    },
  );
  it.each([
    { channel: { ...selected, guildId: '999' } },
    { channel: { ...selected, type: ChannelType.PublicThread } },
    { channel: { ...selected, type: ChannelType.DM } },
    { channel: { ...selected, type: ChannelType.GuildForum } },
    { group: 'daily', role: { id: guildId } },
    { group: 'daily', role: { id: roleId, guild: { id: '999' } } },
  ])('rejects foreign/unsupported options before validation: %j', async (options) => {
    const f = fixture();
    const i = interaction(options);
    await f.handler(i.value);
    expect(f.publisher.validateDestination).not.toHaveBeenCalled();
    expect(f.store.configure).not.toHaveBeenCalled();
  });
  it('preserves explicit role ID and native channel identity despite duplicate names', async () => {
    const f = fixture();
    const a = interaction({
      group: 'daily',
      role: { id: roleId, guild: { id: guildId } },
      channel: { ...selected, type: ChannelType.GuildAnnouncement },
    });
    await f.handler(a.value);
    const b = interaction({ group: 'daily', channel: { ...selected, id: '201', name: 'news' } });
    await f.handler(b.value);
    expect(f.store.configure.mock.calls[0]![0].destination).toEqual({
      guildId,
      channelId,
      notifyRoleId: roleId,
    });
    expect(f.store.configure.mock.calls[1]![0].destination).toEqual({ guildId, channelId: '201' });
    expect(a.text()).toContain('<@&400>');
    expect(b.text()).not.toContain('<@&');
  });
  it('preserves ordinary privacy access and prevents unknown groups/actions falling into legacy writes', async () => {
    const f = fixture();
    const privacy = interaction({ group: null, action: 'privacy', manage: false });
    await f.handler(privacy.value);
    expect(privacy.text()).toContain('Jolanda privacy');
    expect(privacy.text()).toContain('News uses no AI or model calls');
    expect(privacy.text()).toContain('routing identifiers are encrypted separately');
    expect(privacy.text()).toContain('copies already posted remain in Discord');
    for (const options of [
      { group: 'unknown', action: 'context-limit' },
      { group: 'daily', action: 'privacy' },
      { group: null, action: 'unknown' },
      { group: 'continuous', action: 'model' },
    ]) {
      const i = interaction(options);
      await f.handler(i.value);
      expect(i.text()).toContain('Unknown');
      expect(i.raw.options.getInteger).not.toHaveBeenCalled();
    }
    expect(f.legacy.updateSettings).not.toHaveBeenCalled();
    expect(f.store.configure).not.toHaveBeenCalled();
  });
  it('ignores DMs and reports an absent news module without legacy fallback', async () => {
    const f = fixture();
    const dm = interaction({ guildId: null });
    await f.handler(dm.value);
    expect(dm.raw.deferReply).not.toHaveBeenCalled();
    const bare = createCommandHandler({
      store: f.legacy,
      logger,
      protectIdentifier: (value) => value,
      transcriptTtlDays: 7,
      maximumContextMessages: 50,
    });
    const i = interaction();
    await bare(i.value);
    expect(i.text()).toContain('unavailable');
  });
});

describe('news status and independent configuration', () => {
  it('configures while the deployment switch is off and reports the switch clearly', async () => {
    const f = fixture({ enabled: false });
    const i = interaction();
    await f.handler(i.value);
    expect(i.text()).toContain('deployment switch is off');
    const status = interaction({ action: 'status' });
    await f.handler(status.value);
    expect(status.text()).toContain('Deployment switch: **disabled**');
    expect(status.text()).toContain('not scheduled');
  });
  it('disables one feed independently, removes routing and keeps the other destination', async () => {
    const f = fixture();
    await f.handler(interaction().value);
    await f.handler(interaction({ group: 'daily' }).value);
    await f.handler(interaction({ action: 'disable' }).value);
    expect(f.destinations.has('100:continuous')).toBe(false);
    expect(f.destinations.has('100:daily')).toBe(true);
    const status = interaction({ action: 'status' });
    await f.handler(status.value);
    expect(status.text()).toContain('Configuration: **disabled**');
    expect(status.text()).toContain('Destination: none');
  });
  it('shows source outcome, destination, pending/uncertain and pause independently of AI budget availability', async () => {
    const f = fixture();
    await f.handler(interaction().value);
    vi.mocked(f.legacy.getBudgetSummary).mockRejectedValue(new Error('AI accounting unavailable'));
    f.sources.dennikn = {
      ...f.sources.dennikn!,
      lastOutcome: 'unavailable',
      lastSuccessAt: at('16:00:00'),
      backoffUntil: at('18:00:00'),
    };
    f.store.getDeliveryCounts.mockResolvedValue({ pending: 2, uncertain: 1 });
    const i = interaction({ action: 'status' });
    await f.handler(i.value);
    expect(i.text()).toContain('Publisher unavailable');
    expect(i.text()).toContain('2026-09-14 18:00:00');
    expect(i.text()).toContain('<#200>');
    expect(i.text()).toContain('Pending deliveries: **2**');
    expect(i.text()).toContain('Uncertain deliveries: **1**');
    expect(i.text()).toContain('held to avoid duplicate');
    expect(i.text()).toContain('Source backoff');
    expect(f.legacy.getBudgetSummary).not.toHaveBeenCalled();
    // Status resolves its language from guild settings, so prove it degrades instead of
    // failing when that store is unavailable.
    vi.mocked(f.legacy.getSettings).mockRejectedValueOnce(new Error('settings outage'));
    const degraded = interaction({ group: 'continuous', action: 'status' });
    await f.handler(degraded.value);
    expect(degraded.text()).toContain('Denník N');
  });
  it('distinguishes unconfigured, missing edition, source outage, and a stored edition from delivery', async () => {
    const f = fixture({ now: at('18:30:00') });
    const i = interaction({ group: 'daily', action: 'status' });
    await f.handler(i.value);
    expect(i.text()).toContain('not configured');
    expect(i.text()).toContain('Not collected yet');
    expect(i.text()).toContain('Stored edition: none');
    await f.handler(interaction({ group: 'daily' }).value);
    f.sources.aktuality!.lastOutcome = 'empty';
    await f.handler(i.value);
    expect(i.text()).toContain('No items or edition found');
    f.sources.aktuality!.lastOutcome = 'malformed';
    await f.handler(i.value);
    expect(i.text()).toContain('Source parser failed');
    f.sources.aktuality!.daily = {
      attemptedSlots: [],
      collectedEdition: {
        kind: 'edition',
        source: 'aktuality',
        id: '1',
        revision: '1',
        title: 'Private unrendered title',
        url: 'https://www.aktuality.sk/clanok/a/',
        publishedAt: at('17:00:00'),
        sections: [],
      },
    };
    await f.handler(i.value);
    expect(i.text()).toContain('Stored edition: current day');
    expect(i.text()).toContain('not a delivery receipt');
    expect(i.text()).toContain('2026-09-15 20:00:00');
    expect(i.text()).not.toContain('Private unrendered title');
  });
  it.each([
    ['2026-01-15T17:00:00Z', '2026-01-15 20:00:00', '+01:00'],
    ['2026-07-15T17:00:00Z', '2026-07-15 20:00:00', '+02:00'],
    ['2026-03-29T17:00:00Z', '2026-03-29 20:00:00', '+02:00'],
    ['2026-10-25T18:00:00Z', '2026-10-25 20:00:00', '+01:00'],
  ])('reports daily next collection in Bratislava for %s', async (now, local, offset) => {
    const f = fixture({ now: new Date(now) });
    await f.handler(interaction({ group: 'daily' }).value);
    const i = interaction({ group: 'daily', action: 'status' });
    await f.handler(i.value);
    expect(i.text()).toContain(`${local} (UTC${offset}`);
  });
  it('reports conditional fallback after a consumed primary slot, then tomorrow after the deadline', async () => {
    const f = fixture({ now: at('18:30:00') });
    await f.handler(interaction({ group: 'daily' }).value);
    f.sources.aktuality!.daily = {
      attemptedSlots: [JSON.stringify(['aktuality', '2026-09-14', 'primary'])],
    };
    const i = interaction({ group: 'daily', action: 'status' });
    await f.handler(i.value);
    expect(i.text()).toContain('2026-09-14 21:00:00');
    f.sources.aktuality!.backoffUntil = at('20:00:00');
    await f.handler(i.value);
    expect(i.text()).toContain('2026-09-15 20:00:00');
  });
  it('surfaces decryption/paused or revision-changed destinations without leaking old routing', async () => {
    const f = fixture();
    await f.handler(interaction().value);
    f.store.getDestination.mockRejectedValueOnce(new NewsDecryptionError());
    const i = interaction({ action: 'status' });
    await f.handler(i.value);
    expect(i.text()).toContain('unavailable; configure');
    expect(i.text()).toContain('not scheduled');
    expect(i.text()).not.toContain('<#');
    f.subscriptions.get('100:continuous')!.pausedReason = 'decryption-failed';
    f.store.getDestination.mockResolvedValue(null);
    await f.handler(i.value);
    expect(i.text()).toContain('decryption failed');
  });
  it('adds a concise news summary to existing settings', async () => {
    const f = fixture();
    await f.handler(interaction().value);
    const i = interaction({ group: null, action: 'settings' });
    await f.handler(i.value);
    expect(i.text()).toContain('continuous: enabled · daily: off');
    expect(i.text()).toContain('Daily committed spend');
  });
  it('serializes guild removal after in-flight configuration so routing cannot be resurrected', async () => {
    const f = fixture();
    let release!: () => void;
    f.publisher.validateDestination.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(true);
        }),
    );
    const configure = f.handler(interaction().value);
    await vi.waitFor(() => expect(f.publisher.validateDestination).toHaveBeenCalledOnce());
    const removal = f.handler.removeNewsGuild(guildId);
    release();
    await Promise.all([configure, removal]);
    expect(f.store.removeGuild).toHaveBeenCalledWith(guildId);
    expect(f.destinations.size).toBe(0);
    expect(f.store.configure.mock.invocationCallOrder[0]).toBeLessThan(
      f.store.removeGuild.mock.invocationCallOrder[0]!,
    );
  });
});

const discordTransport = (
  options: { permissions?: bigint; rolePresent?: boolean; mentionable?: boolean } = {},
) =>
  vi.fn<typeof fetch>(async (url) => {
    let payload: unknown;
    if (String(url).endsWith('/channels/200'))
      payload = {
        id: channelId,
        guild_id: guildId,
        type: ChannelType.GuildText,
        permission_overwrites: [],
      };
    else if (String(url).endsWith('/roles'))
      payload = [
        {
          id: guildId,
          permissions: String(
            options.permissions ??
              PermissionFlagsBits.ViewChannel |
                PermissionFlagsBits.SendMessages |
                PermissionFlagsBits.EmbedLinks,
          ),
          mentionable: false,
        },
        ...(options.rolePresent === false
          ? []
          : [{ id: roleId, permissions: '0', mentionable: options.mentionable ?? true }]),
      ];
    else if (String(url).endsWith('/members/300')) payload = { user: { id: '300' }, roles: [] };
    else throw new Error('Unexpected fake network route');
    return new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json' },
    });
  });
const botFixture = (newsStore: NewsStore, makeRequest = discordTransport()) => {
  const emitter = new EventEmitter();
  const cache = new Collection<string, unknown>();
  const commands = { set: vi.fn(async () => []) };
  const rawClient = Object.assign(emitter, {
    user: { id: '300' },
    isReady: vi.fn(() => true),
    guilds: { cache },
    application: { commands },
    login: vi.fn(async () => 'token'),
    destroy: vi.fn(),
  });
  const bot = createDiscordBot({
    client: rawClient as unknown as Client,
    token: 'fake-token',
    newsStore,
    newsPublisherOptions: { makeRequest, clock: () => at('17:00:00') },
    maximumContextMessages: 50,
    promptsPerMinute: 3,
    transcriptTtlDays: 7,
    protectIdentifier: (value) => `hash-${value}`,
    jolanda: { handleTurn: vi.fn(), shutdown: vi.fn() } as unknown as Jolanda,
    store: legacyStore(),
    logger,
  });
  return { bot, client: rawClient, makeRequest };
};

describe('news Discord bot lifecycle integration', () => {
  it('constructs publisher with the existing client/token, dispatches commands and closes it on destroy', async () => {
    const f = fixture();
    const b = botFixture(f.news);
    const i = interaction();
    b.client.emit(Events.InteractionCreate, i.value);
    await vi.waitFor(() => expect(f.store.configure).toHaveBeenCalledOnce());
    expect(b.bot.newsPublisher?.ready()).toBe(true);
    expect(b.makeRequest).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/200',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bot fake-token' }),
      }),
    );
    expect(b.makeRequest.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    b.bot.stopAccepting();
    await b.bot.drain();
    await b.bot.destroy();
    expect(b.bot.newsPublisher?.ready()).toBe(false);
    expect(b.client.destroy).toHaveBeenCalledOnce();
  });
  it.each([
    { permissions: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages },
    { permissions: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.EmbedLinks },
    { rolePresent: false },
    { mentionable: false },
  ])(
    'uses real publisher destination/role checks before command persistence: case %#',
    async (options) => {
      const f = fixture();
      const b = botFixture(f.news, discordTransport(options));
      const i = interaction({ group: 'daily', role: { id: roleId } });
      b.client.emit(Events.InteractionCreate, i.value);
      await vi.waitFor(() => expect(i.raw.editReply).toHaveBeenCalledOnce());
      expect(f.store.configure).not.toHaveBeenCalled();
      expect(i.text()).toContain('could not validate');
      b.bot.stopAccepting();
      await b.bot.drain();
      await b.bot.destroy();
    },
  );
  it('tracks guild removal cleanup and retains temporarily unavailable memberships', async () => {
    const f = fixture();
    await f.handler(interaction().value);
    const b = botFixture(f.news);
    b.client.emit(Events.GuildUnavailable, { id: guildId, available: false });
    expect(f.store.removeGuild).not.toHaveBeenCalled();
    // A real removal can follow an outage while the cached Guild still has available=false.
    b.client.emit(Events.GuildDelete, { id: guildId, available: false });
    await b.bot.drain();
    expect(f.store.removeGuild).toHaveBeenCalledWith(guildId);
    expect(f.destinations.size).toBe(0);
    b.bot.stopAccepting();
    b.client.emit(Events.GuildDelete, { id: '999', available: true });
    await b.bot.drain();
    expect(f.store.removeGuild).toHaveBeenCalledTimes(1);
    await b.bot.destroy();
  });
  it('reconciles offline removals from READY cache even when command registration fails', async () => {
    const f = fixture();
    await f.store.configure({ feed: 'continuous', destination: { guildId: '111', channelId } });
    await f.store.configure({ feed: 'daily', destination: { guildId: '222', channelId } });
    const b = botFixture(f.news);
    b.client.guilds.cache.set('222', { id: '222', available: false });
    b.client.application.commands.set.mockRejectedValueOnce(new Error('registration failure'));
    b.client.emit(Events.ClientReady, b.client);
    await b.bot.drain();
    expect(f.store.removeGuild).toHaveBeenCalledExactlyOnceWith('111');
    expect(f.destinations.has('222:daily')).toBe(true);
    await b.bot.destroy();
  });
  it('contains cleanup/store failures and skips reconciliation after shutdown', async () => {
    const f = fixture();
    const b = botFixture(f.news);
    f.store.removeGuild.mockRejectedValueOnce(new Error('private destination failure'));
    b.client.emit(Events.GuildDelete, { id: guildId, available: true });
    await b.bot.drain();
    f.store.listEnabled.mockRejectedValueOnce(new Error('offline store'));
    b.client.emit(Events.ClientReady, b.client);
    await b.bot.drain();
    b.bot.stopAccepting();
    b.client.emit(Events.ClientReady, b.client);
    expect(f.store.listEnabled).toHaveBeenCalledTimes(1);
    await b.bot.destroy();
  });
  it('continues reconciliation past an undecryptable subscription without erasing cached guilds', async () => {
    const f = fixture();
    await f.store.configure({ feed: 'continuous', destination: { guildId: '111', channelId } });
    await f.store.configure({ feed: 'daily', destination: { guildId: '222', channelId } });
    f.store.getDestination.mockRejectedValueOnce(new NewsDecryptionError());
    await f.handler.reconcileNewsGuilds(() => false);
    expect(f.store.removeGuild).toHaveBeenCalledExactlyOnceWith('222');
    expect(f.subscriptions.get('111:continuous')?.enabled).toBe(true);
    await f.handler.reconcileNewsGuilds(
      () => false,
      () => false,
    );
    expect(f.store.removeGuild).toHaveBeenCalledTimes(1);
  });
});

describe('news command persistence through Mongo restart', () => {
  let replicaSet: MongoMemoryReplSet;
  beforeAll(async () => {
    replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  });
  afterAll(async () => {
    await replicaSet.stop();
  });
  it('configures two feeds, restarts, reports status despite AI accounting failure, then independently disables', async () => {
    const databaseName = `news-commands-${randomUUID()}`;
    const open = async () => {
      const store = createMongoStore({
        uri: replicaSet.getUri(),
        databaseName,
        dailyLimitMicrodollars: 1_000_000,
        monthlyLimitMicrodollars: 10_000_000,
        promptsPerMinute: 3,
        transcriptTtlMs: 60_000,
        instanceId: randomUUID(),
        protectIdentifier: (value) => `hash-${value}`,
        logger,
        news: { secret: 'command-test-secret', clock: () => at('17:00:00') },
      });
      await store.initialize();
      return store;
    };
    let store = await open();
    await store.updateSettings(guildId, { locale: 'en' });
    const publisher = createNewsDiscordPublisher({
      client: { isReady: () => true, user: { id: '300' } },
      token: 'fake-token',
      makeRequest: discordTransport(),
    });
    const handler = () =>
      createCommandHandler({
        store,
        news: { store: store.news!, publisher, enabled: true, clock: () => at('17:00:00') },
        logger,
        protectIdentifier: (value) => `hash-${value}`,
        transcriptTtlDays: 7,
        maximumContextMessages: 50,
      });
    try {
      await handler()(interaction().value);
      await handler()(interaction({ group: 'daily', role: { id: roleId } }).value);
      await store.close();
      store = await open();
      vi.spyOn(store, 'getBudgetSummary').mockRejectedValue(new Error('unrelated AI outage'));
      const daily = interaction({ group: 'daily', action: 'status' });
      await handler()(daily.value);
      expect(daily.text()).toContain('Configuration: **enabled**');
      expect(daily.text()).toContain('<#200>');
      expect(daily.text()).toContain('<@&400>');
      expect(daily.text()).toContain('2026-09-14 20:00:00');
      expect(daily.text()).toContain('Stored edition: none');
      expect(store.getBudgetSummary).not.toHaveBeenCalled();
      await handler()(interaction({ action: 'disable' }).value);
      const continuous = interaction({ action: 'status' });
      await handler()(continuous.value);
      expect(continuous.text()).toContain('Configuration: **disabled**');
      expect((await store.news!.getSubscription({ guildId, feed: 'daily' }))?.enabled).toBe(true);
    } finally {
      publisher.close();
      await store.close();
    }
  });
});
