import { EventEmitter } from 'node:events';
import {
  Collection,
  Events,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  type Client,
  type Message,
} from 'discord.js';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { createDiscordReels } from '../src/discord-reels.js';
import { createDiscordBot } from '../src/discord-bot.js';
import { createCommand } from '../src/discord-commands.js';
import type { Jolanda } from '../src/jolanda.js';
import { messageLinkLookupsPerMinute } from '../src/limits.js';
import type { GuildSettings } from '../src/models.js';
import type { JolandaStore } from '../src/types.js';

const settings: GuildSettings = {
  guildId: 'guild',
  model: 'luna',
  reasoning: 'medium',
  contextLimitMessages: 0,
  locale: 'en' as const,
  updatedAt: new Date(),
};

const createStore = (): JolandaStore => ({
  initialize: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  getSettings: vi.fn(async () => settings),
  updateSettings: vi.fn(async (guildId, patch) => {
    void guildId;
    return { ...settings, ...patch };
  }),
  getUsageSummary: vi.fn(async () => ({
    trendDays: 14,
    memberWindowDays: 7,
    trend: [],
    members: [],
    totalCostMicrodollars: 0,
  })),
  getBudgetSummary: vi.fn(async () => ({
    dailyUsedMicrodollars: 0,
    dailyReservedMicrodollars: 0,
    monthlyUsedMicrodollars: 0,
    monthlyReservedMicrodollars: 0,
  })),
  findConversationByMessage: vi.fn(async () => null),
  tryLockConversation: vi.fn(async () => true),
  releaseConversation: vi.fn(async () => undefined),
  authorizeTurn: vi.fn(async () => ({ ok: true as const })),
  settleRequest: vi.fn(async () => undefined),
  failRequest: vi.fn(async () => undefined),
  appendTurn: vi.fn(async () => undefined),
});

const createClient = () => {
  const emitter = new EventEmitter();
  const login = vi.fn(async () => 'token');
  const destroy = vi.fn();
  const guilds = { cache: new Collection<string, unknown>() };
  const commands = {
    set: vi.fn(async (...arguments_: unknown[]) => {
      void arguments_;
      return undefined;
    }),
  };
  Object.assign(emitter, {
    user: { id: 'bot' },
    application: { commands },
    guilds,
    login,
    destroy,
  });
  return { emitter, client: emitter as unknown as Client, login, destroy, commands, guilds };
};

const createMessage = (overrides: Record<string, unknown> = {}) => {
  const edited: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  const botMessage = (id: string) => ({
    id,
    edit: vi.fn(async (options: Record<string, unknown>) => {
      edited.push(options);
      return undefined;
    }),
    delete: vi.fn(async () => {
      deleted.push(id);
      return undefined;
    }),
  });
  const reply = vi.fn(async (options: Record<string, unknown>) => {
    void options;
    return botMessage('bot-message');
  });
  const send = vi.fn(async (options: Record<string, unknown>) => {
    sent.push(options);
    return botMessage(`bot-chunk-${sent.length}`);
  });
  const historyFetch = vi.fn();
  const message = {
    id: 'source-message',
    content: '<@bot> Ahoj',
    guildId: 'guild',
    channelId: 'channel',
    author: { id: 'user', bot: false },
    member: null,
    inGuild: () => true,
    mentions: {
      users: { has: (id: string) => id === 'bot' },
      repliedUser: undefined,
    },
    reference: null,
    fetchReference: vi.fn(),
    reply,
    channel: {
      isSendable: () => true,
      send,
      messages: { fetch: historyFetch },
    },
    ...overrides,
  };
  return {
    message: message as unknown as Message,
    reply,
    send,
    sent,
    edited,
    deleted,
    historyFetch,
  };
};

const createBot = (input: {
  reels?: ReturnType<typeof createDiscordReels>;
  jolanda: Jolanda;
  store?: JolandaStore;
  client?: ReturnType<typeof createClient>;
  adapterOperationTimeoutMs?: number;
  maximumAdapterHandlers?: number;
}) => {
  const client = input.client ?? createClient();
  const store = input.store ?? createStore();
  const bot = createDiscordBot({
    ...(input.reels ? { reels: input.reels } : {}),
    client: client.client,
    token: 'discord-token',
    maximumContextMessages: 50,
    promptsPerMinute: 3,
    transcriptTtlDays: 7,
    protectIdentifier: (value) => `protected:${value}`,
    jolanda: input.jolanda,
    store,
    logger: pino({ enabled: false }),
    ...(input.adapterOperationTimeoutMs !== undefined
      ? { adapterOperationTimeoutMs: input.adapterOperationTimeoutMs }
      : {}),
    ...(input.maximumAdapterHandlers !== undefined
      ? { maximumAdapterHandlers: input.maximumAdapterHandlers }
      : {}),
  });
  return { bot, client, store };
};

const createInteraction = (input: {
  subcommand: string;
  canManage?: boolean;
  stringValue?: string;
  strings?: Record<string, string>;
  integerValue?: number;
  guildId?: string | null;
}) => {
  const state = { deferred: false, replied: false };
  const reply = vi.fn(async (options: Record<string, unknown>) => {
    void options;
    state.replied = true;
    return undefined;
  });
  const editReply = vi.fn(async (options: Record<string, unknown>) => {
    void options;
    return { id: 'interaction-reply' };
  });
  const deferReply = vi.fn(async () => {
    state.deferred = true;
  });
  return {
    reply,
    editReply,
    deferReply,
    interaction: {
      id: `interaction-${input.subcommand}`,
      commandName: 'jolanda',
      guildId: input.guildId === undefined ? 'guild' : input.guildId,
      user: { id: 'user' },
      get replied() {
        return state.replied;
      },
      get deferred() {
        return state.deferred;
      },
      isChatInputCommand: () => true,
      memberPermissions: { has: () => input.canManage ?? false },
      options: {
        getSubcommand: () => input.subcommand,
        getString: (name: string) => input.strings?.[name] ?? input.stringValue ?? null,
        getInteger: () => input.integerValue,
      },
      deferReply,
      editReply,
      reply,
      followUp: vi.fn(),
    },
  };
};

describe('Discord adapter', () => {
  it('offers friendly model choices for one answer without requiring a selection', () => {
    const definition = createCommand(50).toJSON();
    const ask = definition.options?.find((option) => option.name === 'ask');
    const json = JSON.stringify(ask);
    expect(json).toContain('GPT-5.6 Luna');
    expect(json).toContain('GLM 5.3 Flash');
    expect(json).toContain('[no ZDR]');
    expect(ask).toMatchObject({
      options: [
        { name: 'question', required: true },
        { name: 'model', choices: expect.any(Array) },
      ],
    });
    expect(JSON.parse(json).options[1].required).not.toBe(true);
  });

  it.each([undefined, 'luna:medium'])(
    'lets ordinary members ask with model %s and stream a public reply',
    async (model) => {
      const source = createMessage();
      const response = await source.message.reply('placeholder');
      const interaction = createInteraction({
        subcommand: 'ask',
        strings: { question: 'Explain photosynthesis', ...(model ? { model } : {}) },
      });
      Object.assign(interaction.interaction, {
        channelId: 'channel',
        channel: source.message.channel,
      });
      interaction.editReply.mockImplementation(async () => response);
      const handleTurn = vi.fn<Jolanda['handleTurn']>(async (_request, sink) => {
        await sink.prepare();
        const ids = await sink.finish('Photosynthesis converts light into chemical energy.');
        expect(ids).toEqual(['bot-message', 'bot-chunk-1']);
        return { status: 'completed', conversationId: 'conversation' };
      });
      const { client, store, bot } = createBot({ jolanda: { handleTurn, shutdown: vi.fn() } });
      client.emitter.emit(Events.InteractionCreate, interaction.interaction);
      await bot.drain();
      expect(interaction.deferReply).toHaveBeenCalledWith();
      expect(handleTurn).toHaveBeenCalledOnce();
      const request = handleTurn.mock.calls[0]?.[0];
      expect(request).toMatchObject({
        question: 'Explain photosynthesis',
        guildId: 'guild',
        channelId: 'channel',
        userId: 'user',
      });
      expect(request?.modelProfile).toBe(model);
      expect(await request?.loadAmbientContext(10)).toEqual([]);
      expect(source.edited.at(-1)?.content).toBe('**Question:**\n> Explain photosynthesis');
      expect(source.sent.at(-1)?.content).toBe(
        'Photosynthesis converts light into chemical energy.',
      );
      expect(store.updateSettings).not.toHaveBeenCalled();
    },
  );

  it('edits the deferred ask reply when the core rejects a request', async () => {
    const interaction = createInteraction({
      subcommand: 'ask',
      strings: { question: 'Explain photosynthesis' },
    });
    Object.assign(interaction.interaction, { channelId: 'channel', channel: null });
    const { client, bot } = createBot({
      jolanda: {
        handleTurn: vi.fn(async () => ({
          status: 'rejected' as const,
          reason: 'daily_budget' as const,
        })),
        shutdown: vi.fn(),
      },
    });
    client.emitter.emit(Events.InteractionCreate, interaction.interaction);
    await bot.drain();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('daily spending limit'),
        allowedMentions: { parse: [], repliedUser: false },
      }),
    );
  });

  it('passes only attachments from the tagged message and its explicit reply to the core', async () => {
    const photo = {
      url: 'https://cdn.discordapp.com/attachments/1/2/dog.png?hm=secret',
      size: 1000,
      name: 'dog.png',
      contentType: 'image/png',
    };
    const handleTurn = vi
      .fn<Jolanda['handleTurn']>()
      .mockResolvedValue({ status: 'completed', conversationId: 'conversation' });
    const { client } = createBot({ jolanda: { handleTurn, shutdown: vi.fn() } });
    const original = createMessage({
      content: '',
      author: { id: 'original-author', bot: false },
      attachments: new Collection([['original', photo]]),
    });
    const current = createMessage({
      content: '<@bot> Compare these photos',
      attachments: new Collection([
        ['current', { ...photo, url: photo.url.replace('dog', 'cat') }],
        ['pdf', { ...photo, name: 'document.pdf', contentType: 'application/pdf' }],
      ]),
      reference: { messageId: 'original' },
      fetchReference: vi.fn().mockResolvedValue(original.message),
    });
    client.emitter.emit(Events.MessageCreate, current.message);
    await vi.waitFor(() => expect(handleTurn).toHaveBeenCalledOnce());
    expect(handleTurn.mock.calls[0]?.[0]).toMatchObject({
      question: 'Compare these photos',
      images: [
        { url: photo.url.replace('dog', 'cat'), size: 1000, source: 'latest_message' },
        { url: photo.url, size: 1000, source: 'replied_message' },
      ],
    });
    expect(current.historyFetch).not.toHaveBeenCalled();
  });

  it('admits an image-only mention and displays actionable image errors', async () => {
    const handleTurn = vi
      .fn<Jolanda['handleTurn']>()
      .mockResolvedValue({ status: 'rejected', reason: 'image_unavailable' });
    const { client } = createBot({ jolanda: { handleTurn, shutdown: vi.fn() } });
    const current = createMessage({
      content: '<@bot>',
      attachments: new Collection([
        [
          'photo',
          {
            url: 'https://cdn.discordapp.com/attachments/1/2/photo.png',
            size: 1000,
            name: 'photo.png',
            contentType: 'image/png',
          },
        ],
      ]),
    });
    client.emitter.emit(Events.MessageCreate, current.message);
    await vi.waitFor(() => expect(current.reply).toHaveBeenCalledOnce());
    expect(handleTurn.mock.calls[0]?.[0]).toMatchObject({
      question: '',
      images: expect.any(Array),
    });
    expect(current.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('upload it again'),
        allowedMentions: { parse: [], repliedUser: false },
      }),
    );
  });

  it('routes a mention, strips it, and renders a bounded mention-safe response', async () => {
    const handleTurn = vi.fn<Jolanda['handleTurn']>(async (request, sink) => {
      await sink.prepare();
      const output = `${'answer '.repeat(4_000)} http://user:pass@localhost/private`;
      await sink.update(output);
      await sink.finish(output);
      return { status: 'completed' as const, conversationId: 'conversation' };
    });
    const jolanda = { handleTurn, shutdown: vi.fn(async () => undefined) } as Jolanda;
    const { client } = createBot({ jolanda });
    const source = createMessage();

    client.emitter.emit(Events.MessageCreate, source.message);
    await vi.waitFor(() => expect(handleTurn).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(source.edited.length).toBeGreaterThan(0));

    expect(handleTurn.mock.calls[0]?.[0].question).toBe('Ahoj');
    expect(source.sent.length).toBeLessThanOrEqual(5);
    expect([...source.edited, ...source.sent]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          allowedMentions: { parse: [], repliedUser: false },
          flags: MessageFlags.SuppressEmbeds,
        }),
      ]),
    );
    expect(JSON.stringify([...source.edited, ...source.sent])).not.toContain('user:pass');
  });

  it('routes messages from every server with the originating guild ID', async () => {
    const handleTurn = vi.fn<Jolanda['handleTurn']>(async () => ({
      status: 'completed',
      conversationId: 'conversation',
    }));
    const jolanda = { handleTurn, shutdown: vi.fn(async () => undefined) } as Jolanda;
    const { client } = createBot({ jolanda });
    const source = createMessage({ guildId: 'another-guild' });

    client.emitter.emit(Events.MessageCreate, source.message);
    await vi.waitFor(() => expect(handleTurn).toHaveBeenCalledOnce());

    expect(handleTurn.mock.calls[0]?.[0].guildId).toBe('another-guild');
  });

  it.each([
    ['+context', { limit: 'maximum' }],
    ['+context=10', { limit: 10 }],
  ])(
    'passes the %s modifier through the turn interface without changing the question',
    async (modifier, ambientContext) => {
      const handleTurn = vi.fn<Jolanda['handleTurn']>(async (request) => {
        expect(request.question).toBe('Fact-check this');
        expect(request.ambientContext).toEqual(ambientContext);
        return { status: 'completed', conversationId: 'conversation' };
      });
      const jolanda = { handleTurn, shutdown: vi.fn(async () => undefined) } as Jolanda;
      const { client } = createBot({ jolanda });
      const source = createMessage({ content: `<@bot> ${modifier} Fact-check this` });

      client.emitter.emit(Events.MessageCreate, source.message);
      await vi.waitFor(() => expect(handleTurn).toHaveBeenCalledOnce());
    },
  );

  it('rejects a malformed context modifier before starting a turn', async () => {
    const jolanda = {
      handleTurn: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    } as Jolanda;
    const { client } = createBot({ jolanda });
    const source = createMessage({ content: '<@bot> +context=many Fact-check this' });

    client.emitter.emit(Events.MessageCreate, source.message);
    await vi.waitFor(() => expect(source.reply).toHaveBeenCalledOnce());

    expect(jolanda.handleTurn).not.toHaveBeenCalled();
    expect(String(source.reply.mock.calls[0]?.[0].content)).toContain('+context=N');
  });

  it('offers Reel links independently while AI is admitted or saturated', async () => {
    let finish: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handleTurn = vi.fn<Jolanda['handleTurn']>(async () => {
      await pending;
      return { status: 'completed', conversationId: 'conversation' };
    });
    const reels = { offer: vi.fn(), shutdown: vi.fn(async () => undefined) };
    const { client, bot } = createBot({
      jolanda: { handleTurn, shutdown: vi.fn(async () => undefined) } as Jolanda,
      reels,
      maximumAdapterHandlers: 1,
    });
    const source = createMessage({
      content: '<@bot> Explain this source https://www.instagram.com/reel/sample/',
    });
    client.emitter.emit(Events.MessageCreate, source.message);
    await vi.waitFor(() => expect(handleTurn).toHaveBeenCalledOnce());
    client.emitter.emit(Events.MessageCreate, source.message);
    expect(reels.offer).toHaveBeenCalledTimes(2);
    finish();
    await bot.drain();
    expect(handleTurn).toHaveBeenCalledOnce();
  });

  it('refreshes legacy guild slash commands in place without creating overrides in other guilds', async () => {
    const client = createClient();
    const edit = vi.fn(async () => undefined);
    const contextEdit = vi.fn();
    const fetchLegacy = vi.fn(
      async () =>
        new Collection([
          ['legacy-id', { id: 'legacy-id', name: 'jolanda', type: 1, edit }],
          ['context-id', { name: 'jolanda', type: 3, edit: contextEdit }],
        ]),
    );
    const fetchEmpty = vi.fn(async () => new Collection());
    client.guilds.cache.set('legacy-guild', {
      id: 'legacy-guild',
      commands: { fetch: fetchLegacy, edit },
    });
    client.guilds.cache.set('new-guild', { id: 'new-guild', commands: { fetch: fetchEmpty } });
    const { bot } = createBot({
      client,
      jolanda: { handleTurn: vi.fn(), shutdown: vi.fn() } as unknown as Jolanda,
    });
    client.emitter.emit(Events.ClientReady, client.client);
    await bot.drain();
    expect(edit).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledWith(
      'legacy-id',
      expect.objectContaining({
        name: 'jolanda',
        options: expect.arrayContaining([expect.objectContaining({ name: 'reels' })]),
      }),
    );
    expect(contextEdit).not.toHaveBeenCalled();
    expect(fetchEmpty).toHaveBeenCalledOnce();
  });

  it('continues guild command synchronization after an inaccessible guild', async () => {
    const client = createClient();
    const edit = vi.fn(async () => undefined);
    client.guilds.cache.set('inaccessible', {
      id: 'inaccessible',
      commands: {
        edit,
        fetch: vi.fn(async () => {
          throw new Error('unavailable');
        }),
      },
    });
    client.guilds.cache.set('legacy', {
      id: 'legacy',
      commands: {
        edit,
        fetch: vi.fn(
          async () => new Collection([['id', { id: 'legacy-id', name: 'jolanda', type: 1, edit }]]),
        ),
      },
    });
    const { bot } = createBot({
      client,
      jolanda: { handleTurn: vi.fn(), shutdown: vi.fn() } as unknown as Jolanda,
    });
    client.emitter.emit(Events.ClientReady, client.client);
    await bot.drain();
    expect(edit).toHaveBeenCalledOnce();
  });

  it('routes a reply to Jolanda without requiring another mention', async () => {
    const handleTurn = vi.fn<Jolanda['handleTurn']>(async () => ({
      status: 'completed' as const,
      conversationId: 'conversation',
    }));
    const jolanda = { handleTurn, shutdown: vi.fn(async () => undefined) } as Jolanda;
    const store = createStore();
    vi.mocked(store.findConversationByMessage).mockResolvedValue({
      id: 'conversation',
      ownerKey: 'owner',
      replyCount: 1,
      turns: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { client } = createBot({ jolanda, store });
    const source = createMessage({
      content: 'pokračuj',
      mentions: {
        users: { has: () => false },
        repliedUser: { id: 'bot' },
      },
      reference: { messageId: 'bot-message' },
      fetchReference: vi.fn(async () => ({
        id: 'bot-message',
        author: { id: 'bot' },
        content: 'previous answer',
        inGuild: () => true,
      })),
    });

    client.emitter.emit(Events.MessageCreate, source.message);
    await vi.waitFor(() => expect(handleTurn).toHaveBeenCalledOnce());

    expect(handleTurn.mock.calls[0]?.[0]).toMatchObject({
      question: 'pokračuj',
      referencedMessage: { id: 'bot-message', isJolanda: true },
    });
  });

  it.each([false, true])(
    'requires a content mention to start AI from a media reply (explicit=%s)',
    async (explicit) => {
      const handleTurn = vi.fn<Jolanda['handleTurn']>(async () => ({
        status: 'completed',
        conversationId: 'new',
      }));
      const jolanda = { handleTurn, shutdown: vi.fn(async () => undefined) } as Jolanda;
      const { client, bot, store } = createBot({ jolanda });
      const source = createMessage({
        content: explicit ? '<@bot> What does this source claim?' : 'nice clip',
        reference: { messageId: 'media-message' },
        mentions: { users: { has: () => true }, repliedUser: { id: 'bot' } },
        fetchReference: vi.fn(async () => ({
          author: { id: 'bot' },
          content: 'Instagram Reel · <https://www.instagram.com/reel/sample/>',
          inGuild: () => true,
        })),
      });
      client.emitter.emit(Events.MessageCreate, source.message);
      await bot.drain();
      expect(store.findConversationByMessage).toHaveBeenCalledWith({
        messageId: 'media-message',
        guildId: 'guild',
        channelId: 'channel',
      });
      expect(handleTurn).toHaveBeenCalledTimes(explicit ? 1 : 0);
      if (explicit)
        expect(handleTurn.mock.calls[0]?.[0].referencedMessage).toMatchObject({
          isJolanda: false,
          content: expect.stringContaining('Instagram Reel'),
        });
      expect(source.reply).not.toHaveBeenCalled();
    },
  );

  it('continues a database-linked conversation when Discord omits replied-user metadata', async () => {
    const handleTurn = vi.fn<Jolanda['handleTurn']>(async () => ({
      status: 'completed' as const,
      conversationId: 'conversation',
    }));
    const jolanda = { handleTurn, shutdown: vi.fn(async () => undefined) } as Jolanda;
    const store = createStore();
    vi.mocked(store.findConversationByMessage).mockResolvedValue({
      id: 'conversation',
      ownerKey: 'owner',
      replyCount: 1,
      turns: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { client } = createBot({ jolanda, store });
    const source = createMessage({
      content: 'continue from storage',
      mentions: { users: { has: () => false }, repliedUser: undefined },
      reference: { messageId: 'stored-bot-message' },
      fetchReference: vi.fn(async () => ({
        id: 'stored-bot-message',
        author: { id: 'unknown' },
        content: '',
        inGuild: () => true,
      })),
    });

    client.emitter.emit(Events.MessageCreate, source.message);
    await vi.waitFor(() => expect(handleTurn).toHaveBeenCalledOnce());

    expect(store.findConversationByMessage).toHaveBeenCalledWith({
      messageId: 'stored-bot-message',
      guildId: 'guild',
      channelId: 'channel',
    });
    expect(handleTurn.mock.calls[0]?.[0].referencedMessage).toEqual({
      id: 'stored-bot-message',
      content: '',
      isJolanda: true,
    });
  });

  it('enforces the per-user database-linked reply lookup gate', async () => {
    const handleTurn = vi.fn<Jolanda['handleTurn']>();
    const jolanda = { handleTurn, shutdown: vi.fn(async () => undefined) } as Jolanda;
    const store = createStore();
    const { client } = createBot({ jolanda, store });

    for (let index = 0; index <= messageLinkLookupsPerMinute; index += 1) {
      const source = createMessage({
        id: `source-${index}`,
        content: 'unrelated reply',
        mentions: { users: { has: () => false }, repliedUser: undefined },
        reference: { messageId: `unknown-${index}` },
      });
      client.emitter.emit(Events.MessageCreate, source.message);
    }

    await vi.waitFor(() =>
      expect(store.findConversationByMessage).toHaveBeenCalledTimes(messageLinkLookupsPerMinute),
    );
    expect(handleTurn).not.toHaveBeenCalled();
  });

  it('loads only requested human ambient history through the turn interface', async () => {
    const handleTurn = vi.fn<Jolanda['handleTurn']>(async (request) => {
      const context = await request.loadAmbientContext(2);
      expect(context).toEqual([
        { id: 'human-one', content: 'first' },
        { id: 'human-two', content: 'second' },
      ]);
      return { status: 'completed', conversationId: 'conversation' };
    });
    const jolanda = { handleTurn, shutdown: vi.fn(async () => undefined) } as Jolanda;
    const { client } = createBot({ jolanda });
    const source = createMessage();
    const history = new Collection<string, Record<string, unknown>>();
    history.set('human-two', {
      id: 'human-two',
      author: { bot: false },
      content: 'second',
      createdTimestamp: 2,
    });
    history.set('bot', {
      id: 'bot-history',
      author: { bot: true },
      content: 'ignored',
      createdTimestamp: 3,
    });
    history.set('human-one', {
      id: 'human-one',
      author: { bot: false },
      content: 'first',
      createdTimestamp: 1,
    });
    source.historyFetch.mockResolvedValue(history);

    client.emitter.emit(Events.MessageCreate, source.message);
    await vi.waitFor(() => expect(handleTurn).toHaveBeenCalledOnce());

    expect(source.historyFetch).toHaveBeenCalledWith({ before: 'source-message', limit: 4 });
  });

  it('minimizes Discord identifiers in questions, explicit replies, and ambient context', async () => {
    const handleTurn = vi.fn<Jolanda['handleTurn']>(async (request) => {
      expect(request.question).toBe('Ask @participant about [Discord identifier]');
      expect(request.referencedMessage?.content).toBe('#channel :party: [Discord message]');
      await expect(request.loadAmbientContext(1)).resolves.toEqual([
        { id: 'ambient', content: '@role said [Discord identifier]' },
      ]);
      return { status: 'completed', conversationId: 'conversation' };
    });
    const jolanda = { handleTurn, shutdown: vi.fn(async () => undefined) } as Jolanda;
    const { client } = createBot({ jolanda });
    const source = createMessage({
      content: '<@bot> Ask <@123456789012345678> about 223456789012345678',
      reference: { messageId: 'participant-message' },
      fetchReference: vi.fn(async () => ({
        id: 'participant-message',
        author: { id: 'participant' },
        content:
          '<#323456789012345678> <:party:423456789012345678> https://discord.com/channels/523456789012345678/623456789012345678/723456789012345678',
        inGuild: () => true,
      })),
    });
    const history = new Collection<string, Record<string, unknown>>();
    history.set('ambient', {
      id: 'ambient',
      author: { bot: false },
      content: '<@&823456789012345678> said 923456789012345678',
      createdTimestamp: 1,
    });
    source.historyFetch.mockResolvedValue(history);

    client.emitter.emit(Events.MessageCreate, source.message);
    await vi.waitFor(() => expect(handleTurn).toHaveBeenCalledOnce());
  });

  it('serves privacy information to ordinary members', async () => {
    const jolanda = {
      handleTurn: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    } as Jolanda;
    const { client } = createBot({ jolanda });
    const privacy = createInteraction({ subcommand: 'privacy', canManage: false });

    client.emitter.emit(Events.InteractionCreate, privacy.interaction);
    await vi.waitFor(() => expect(privacy.editReply).toHaveBeenCalledOnce());

    expect(privacy.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(privacy.reply).not.toHaveBeenCalled();
    expect(String(privacy.editReply.mock.calls[0]?.[0].content)).toContain('OpenRouter');
    expect(String(privacy.editReply.mock.calls[0]?.[0].content)).toContain('7 days');
    expect(String(privacy.editReply.mock.calls[0]?.[0].content)).toContain('plaintext');
    expect(String(privacy.editReply.mock.calls[0]?.[0].content)).toContain(
      'Zero Data Retention is **not available**',
    );
  });

  it('enforces Manage Server permission for configuration', async () => {
    const jolanda = {
      handleTurn: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    } as Jolanda;
    const store = createStore();
    const { client } = createBot({ jolanda, store });
    const reply = vi.fn(async (options: Record<string, unknown>) => {
      void options;
      return undefined;
    });
    const interaction = {
      id: 'interaction',
      commandName: 'jolanda',
      guildId: 'guild',
      user: { id: 'user' },
      replied: false,
      deferred: false,
      isChatInputCommand: () => true,
      memberPermissions: {
        has: (permission: bigint) => permission === PermissionFlagsBits.ManageGuild && false,
      },
      options: { getSubcommand: () => 'context-limit' },
      reply,
      deferReply: vi.fn(),
      editReply: reply,
      followUp: vi.fn(),
    };

    client.emitter.emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());

    expect(store.updateSettings).not.toHaveBeenCalled();
    expect(String(reply.mock.calls[0]?.[0].content)).toContain('Manage Server');
  });

  it('updates settings for the server where the command was used', async () => {
    const jolanda = {
      handleTurn: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    } as Jolanda;
    const store = createStore();
    const { client } = createBot({ jolanda, store });
    const interaction = createInteraction({
      subcommand: 'context-limit',
      canManage: true,
      integerValue: 12,
      guildId: 'another-guild',
    });

    client.emitter.emit(Events.InteractionCreate, interaction.interaction);
    await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalledOnce());

    expect(store.updateSettings).toHaveBeenCalledWith('another-guild', {
      contextLimitMessages: 12,
    });
  });

  it('handles settings, atomic model profiles, and context-limit admin commands', async () => {
    const jolanda = {
      handleTurn: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    } as Jolanda;
    const store = createStore();
    const { client } = createBot({ jolanda, store });

    const settingsInteraction = createInteraction({ subcommand: 'settings', canManage: true });
    client.emitter.emit(Events.InteractionCreate, settingsInteraction.interaction);
    await vi.waitFor(() => expect(settingsInteraction.editReply).toHaveBeenCalledOnce());
    expect(settingsInteraction.interaction.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    expect(settingsInteraction.interaction.deferReply.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(store.getSettings).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(String(settingsInteraction.editReply.mock.calls[0]?.[0].content)).toContain(
      'Daily committed spend',
    );
    expect(String(settingsInteraction.editReply.mock.calls[0]?.[0].content)).toContain(
      'Zero Data Retention: **unavailable**',
    );

    const modelInteraction = createInteraction({
      subcommand: 'model',
      canManage: true,
      stringValue: 'deepseek-v4-flash:low',
    });
    client.emitter.emit(Events.InteractionCreate, modelInteraction.interaction);
    await vi.waitFor(() => expect(modelInteraction.editReply).toHaveBeenCalledOnce());
    expect(store.updateSettings).toHaveBeenCalledWith('guild', {
      model: 'deepseek-v4-flash',
      reasoning: 'low',
    });

    const contextInteraction = createInteraction({
      subcommand: 'context-limit',
      canManage: true,
      integerValue: 20,
    });
    client.emitter.emit(Events.InteractionCreate, contextInteraction.interaction);
    await vi.waitFor(() => expect(contextInteraction.editReply).toHaveBeenCalledOnce());
    expect(store.updateSettings).toHaveBeenCalledWith('guild', { contextLimitMessages: 20 });
  });

  it('allows a model without ZDR and warns in the confirmation', async () => {
    const jolanda = {
      handleTurn: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    } as Jolanda;
    const store = createStore();
    const { client } = createBot({ jolanda, store });
    const interaction = createInteraction({
      subcommand: 'model',
      canManage: true,
      stringValue: 'luna:medium',
    });

    client.emitter.emit(Events.InteractionCreate, interaction.interaction);
    await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalledOnce());

    expect(store.updateSettings).toHaveBeenCalledWith('guild', {
      model: 'luna',
      reasoning: 'medium',
    });
    expect(String(interaction.editReply.mock.calls[0]?.[0].content)).toContain('not available');
  });

  it('contains command and command-registration failures', async () => {
    const jolanda = {
      handleTurn: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    } as Jolanda;
    const client = createClient();
    client.commands.set.mockRejectedValueOnce(new Error('registration failed'));
    createBot({ jolanda, client });
    const invalid = createInteraction({
      subcommand: 'model',
      canManage: true,
      stringValue: 'unknown-model',
    });

    client.emitter.emit(Events.InteractionCreate, invalid.interaction);
    await vi.waitFor(() => expect(invalid.editReply).toHaveBeenCalledOnce());
    expect(invalid.reply).not.toHaveBeenCalled();
    expect(String(invalid.editReply.mock.calls[0]?.[0].content)).toContain('could not save');

    client.emitter.emit(Events.ClientReady, client.client);
    await vi.waitFor(() => expect(client.commands.set).toHaveBeenCalledOnce());
  });

  it('sends a safe rejection and ignores duplicate outcomes', async () => {
    const handleTurn = vi
      .fn<Jolanda['handleTurn']>()
      .mockResolvedValueOnce({ status: 'rejected', reason: 'daily_budget' })
      .mockResolvedValueOnce({ status: 'rejected', reason: 'duplicate' });
    const jolanda = { handleTurn, shutdown: vi.fn(async () => undefined) } as Jolanda;
    const { client } = createBot({ jolanda });
    const rejected = createMessage();
    const duplicate = createMessage({ id: 'duplicate-message' });

    client.emitter.emit(Events.MessageCreate, rejected.message);
    await vi.waitFor(() => expect(rejected.reply).toHaveBeenCalledOnce());
    expect(rejected.reply.mock.calls[0]?.[0]).toMatchObject({
      flags: MessageFlags.SuppressEmbeds,
      allowedMentions: { parse: [], repliedUser: false },
    });
    expect(String(rejected.reply.mock.calls[0]?.[0].content)).toContain('daily spending');

    client.emitter.emit(Events.MessageCreate, duplicate.message);
    await vi.waitFor(() => expect(handleTurn).toHaveBeenCalledTimes(2));
    expect(duplicate.reply).not.toHaveBeenCalled();
  });

  it('ignores unrelated messages and contains handler failures', async () => {
    const handleTurn = vi.fn<Jolanda['handleTurn']>(async () =>
      Promise.reject(new Error('core unavailable')),
    );
    const jolanda = { handleTurn, shutdown: vi.fn(async () => undefined) } as Jolanda;
    const { client } = createBot({ jolanda });
    const unrelated = createMessage({
      content: 'hello everyone',
      mentions: { users: { has: () => false }, repliedUser: undefined },
    });
    const failing = createMessage({ id: 'failing' });

    client.emitter.emit(Events.MessageCreate, unrelated.message);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(handleTurn).not.toHaveBeenCalled();

    client.emitter.emit(Events.MessageCreate, failing.message);
    await vi.waitFor(() => expect(failing.reply).toHaveBeenCalledOnce());
    expect(String(failing.reply.mock.calls[0]?.[0].content)).toContain('momentálne nedostupná');
  });

  it('silently ignores an unrelated human reply when link storage is unavailable', async () => {
    const jolanda = {
      handleTurn: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    } as Jolanda;
    const store = createStore();
    vi.mocked(store.findConversationByMessage).mockRejectedValue(new Error('Mongo unavailable'));
    const { client } = createBot({ jolanda, store });
    const source = createMessage({
      content: 'human reply',
      mentions: { users: { has: () => false }, repliedUser: { id: 'human' } },
      reference: { messageId: 'human-message' },
    });

    client.emitter.emit(Events.MessageCreate, source.message);
    await vi.waitFor(() => expect(store.findConversationByMessage).toHaveBeenCalledOnce());

    expect(jolanda.handleTurn).not.toHaveBeenCalled();
    expect(source.reply).not.toHaveBeenCalled();
  });

  it('silently bounds repeated targeted traffic before Discord or core amplification', async () => {
    const handleTurn = vi.fn<Jolanda['handleTurn']>(async () => ({
      status: 'rejected' as const,
      reason: 'empty_question' as const,
    }));
    const jolanda = { handleTurn, shutdown: vi.fn(async () => undefined) } as Jolanda;
    const { client } = createBot({ jolanda });
    const sources = Array.from({ length: 8 }, (_, index) =>
      createMessage({ id: `repeated-${index}`, content: '<@bot>' }),
    );

    for (const source of sources) client.emitter.emit(Events.MessageCreate, source.message);
    await vi.waitFor(() => expect(handleTurn).toHaveBeenCalledTimes(4));

    expect(sources.slice(4).every((source) => !source.reply.mock.calls.length)).toBe(true);
  });

  it('caps distinct-user handlers while reply fetches are stalled', async () => {
    const releaseReferences: Array<() => void> = [];
    const handleTurn = vi.fn<Jolanda['handleTurn']>(async () => ({
      status: 'completed' as const,
      conversationId: 'conversation',
    }));
    const jolanda = { handleTurn, shutdown: vi.fn(async () => undefined) } as Jolanda;
    const { bot, client } = createBot({ jolanda, maximumAdapterHandlers: 2 });
    const sources = Array.from({ length: 3 }, (_, index) =>
      createMessage({
        id: `stalled-${index}`,
        author: { id: `user-${index}`, bot: false },
        reference: { messageId: `reference-${index}` },
        fetchReference: vi.fn(
          async () =>
            new Promise<Record<string, unknown>>((resolve) => {
              releaseReferences.push(() =>
                resolve({
                  id: `reference-${index}`,
                  author: { id: 'human' },
                  content: 'quoted',
                  inGuild: () => true,
                }),
              );
            }),
        ),
      }),
    );

    for (const source of sources) client.emitter.emit(Events.MessageCreate, source.message);
    await vi.waitFor(() => expect(releaseReferences).toHaveLength(2));
    expect(sources[2]?.message.fetchReference).not.toHaveBeenCalled();

    for (const release of releaseReferences.splice(0)) release();
    await vi.waitFor(() => expect(handleTurn).toHaveBeenCalledTimes(2));
    client.emitter.emit(Events.MessageCreate, sources[2]?.message);
    await vi.waitFor(() => expect(releaseReferences).toHaveLength(1));
    releaseReferences[0]?.();
    await vi.waitFor(() => expect(handleTurn).toHaveBeenCalledTimes(3));
    await bot.drain();
  });

  it('retains admission and drain tracking after a reference-fetch deadline', async () => {
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const handleTurn = vi.fn<Jolanda['handleTurn']>(async () => ({
      status: 'completed' as const,
      conversationId: 'conversation',
    }));
    const jolanda = { handleTurn, shutdown: vi.fn(async () => undefined) } as Jolanda;
    const { bot, client } = createBot({
      jolanda,
      adapterOperationTimeoutMs: 5,
      maximumAdapterHandlers: 1,
    });
    const first = createMessage({
      id: 'first-stalled-source',
      author: { id: 'first-user', bot: false },
      reference: { messageId: 'stalled-reference' },
      fetchReference: vi.fn(
        async () =>
          new Promise<Record<string, unknown>>((resolve) => {
            releaseFirst = () =>
              resolve({
                id: 'stalled-reference',
                author: { id: 'human' },
                content: 'late reference',
                inGuild: () => true,
              });
          }),
      ),
    });
    const second = createMessage({
      id: 'second-stalled-source',
      author: { id: 'second-user', bot: false },
      reference: { messageId: 'second-reference' },
      fetchReference: vi.fn(
        async () =>
          new Promise<Record<string, unknown>>((resolve) => {
            releaseSecond = () =>
              resolve({
                id: 'second-reference',
                author: { id: 'human' },
                content: 'second reference',
                inGuild: () => true,
              });
          }),
      ),
    });

    client.emitter.emit(Events.MessageCreate, first.message);
    await vi.waitFor(() => expect(handleTurn).toHaveBeenCalledOnce());
    let drained = false;
    const draining = bot.drain().then(() => {
      drained = true;
    });
    client.emitter.emit(Events.MessageCreate, second.message);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(first.message.fetchReference).toHaveBeenCalledOnce();
    expect(second.message.fetchReference).not.toHaveBeenCalled();
    expect(drained).toBe(false);

    releaseFirst?.();
    await draining;
    client.emitter.emit(Events.MessageCreate, second.message);
    await vi.waitFor(() => expect(second.message.fetchReference).toHaveBeenCalledOnce());
    releaseSecond?.();
    await vi.waitFor(() => expect(handleTurn).toHaveBeenCalledTimes(2));
    await bot.drain();
  });

  it('deletes surplus chunks when a sanitized streaming rendering becomes shorter', async () => {
    const handleTurn = vi.fn<Jolanda['handleTurn']>(async (_request, sink) => {
      await sink.prepare();
      await sink.update('x'.repeat(2_500));
      await sink.finish('short');
      return { status: 'completed' as const, conversationId: 'conversation' };
    });
    const jolanda = { handleTurn, shutdown: vi.fn(async () => undefined) } as Jolanda;
    const { client } = createBot({ jolanda });
    const source = createMessage();

    client.emitter.emit(Events.MessageCreate, source.message);
    await vi.waitFor(() => expect(source.deleted).toEqual(['bot-chunk-1']));

    expect(source.edited.at(-1)?.content).toBe('short');
  });

  it('wires login, global guild-only command registration, and destruction through the adapter interface', async () => {
    const jolanda = {
      handleTurn: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    } as Jolanda;
    const client = createClient();
    const { bot } = createBot({ jolanda, client });

    await bot.start();
    client.emitter.emit(Events.ClientReady, client.client);
    await vi.waitFor(() => expect(client.commands.set).toHaveBeenCalledOnce());
    bot.destroy();

    expect(client.login).toHaveBeenCalledWith('discord-token');
    expect(client.commands.set.mock.calls[0]).toHaveLength(1);
    const commands = client.commands.set.mock.calls[0]?.[0] as Array<{
      contexts: number[];
      options: Array<{ name: string; options?: Array<{ choices?: Array<{ value: string }> }> }>;
    }>;
    expect(commands[0]?.contexts).toEqual([InteractionContextType.Guild]);
    const subcommands = commands[0]?.options ?? [];
    expect(subcommands.some(({ name }) => name === 'reasoning')).toBe(false);
    expect(
      subcommands
        .find(({ name }) => name === 'model')
        ?.options?.[0]?.choices?.map(({ value }) => value),
    ).toEqual([
      'luna:none',
      'luna:low',
      'luna:medium',
      'luna:high',
      'luna:xhigh',
      'luna:max',
      'deepseek-v4-flash:low',
      'deepseek-v4-flash:high',
      'deepseek-v4-flash:max',
      'glm-5.3-flash:low',
      'glm-5.3-flash:high',
      'glm-5.3-flash:max',
    ]);
    expect(client.destroy).toHaveBeenCalledOnce();
  });

  it('stops admission and drains an already-running adapter handler', async () => {
    let finishTurn: ((value: { status: 'completed'; conversationId: string }) => void) | undefined;
    const handleTurn = vi.fn<Jolanda['handleTurn']>(
      async () =>
        new Promise((resolve) => {
          finishTurn = resolve;
        }),
    );
    const jolanda = { handleTurn, shutdown: vi.fn(async () => undefined) } as Jolanda;
    const { bot, client } = createBot({ jolanda });
    const running = createMessage({ id: 'running' });
    const rejected = createMessage({ id: 'after-stop' });

    client.emitter.emit(Events.MessageCreate, running.message);
    await vi.waitFor(() => expect(handleTurn).toHaveBeenCalledOnce());
    bot.stopAccepting();
    client.emitter.emit(Events.MessageCreate, rejected.message);
    let drained = false;
    const drain = bot.drain().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(drained).toBe(false);
    expect(handleTurn).toHaveBeenCalledOnce();
    finishTurn?.({ status: 'completed', conversationId: 'conversation' });
    await drain;
    expect(drained).toBe(true);
  });
});
