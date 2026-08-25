import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createJolanda } from '../src/jolanda.js';
import { discordOperationTimeoutMs } from '../src/limits.js';
import type { GuildSettings } from '../src/models.js';
import type {
  JolandaStore,
  Conversation,
  ModelRunRequest,
  ModelRunner,
  ResponseSink,
  TurnRequest,
  TurnOutcome,
} from '../src/types.js';

const usage = {
  costMicrodollars: 1_000,
  promptTokens: 100,
  completionTokens: 20,
  reasoningTokens: 10,
  webSearchRequests: 0,
};

const createStore = (): JolandaStore => ({
  initialize: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  getSettings: vi.fn(
    async (guildId: string) =>
      ({
        guildId,
        model: 'luna',
        reasoning: 'medium',
        contextMessages: 0,
        updatedAt: new Date(),
      }) satisfies GuildSettings,
  ),
  updateSettings: vi.fn(),
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

const createSink = (): ResponseSink => ({
  prepare: vi.fn(async () => undefined),
  update: vi.fn(async () => undefined),
  finish: vi.fn(async () => ['bot-message']),
  fail: vi.fn(async () => undefined),
});

const createRequest = (loadAmbientContext: TurnRequest['loadAmbientContext']): TurnRequest => ({
  id: 'request',
  guildId: 'guild',
  channelId: 'channel',
  userId: 'user',
  question: 'Ahoj',
  loadAmbientContext,
});

const createCore = (store: JolandaStore, modelRunner: ModelRunner, maximumConcurrentTurns = 2) =>
  createJolanda({
    store,
    modelRunner,
    logger: pino({ enabled: false }),
    maximumContextMessages: 50,
    maximumPromptCharacters: 32_000,
    maximumConcurrentTurns,
    transcriptTtlMs: 7 * 24 * 60 * 60 * 1_000,
    protectIdentifier: (value) => `protected:${value}`,
    createId: () => 'conversation',
  });

describe('Jolanda core', () => {
  it('rejects empty questions without touching persistence', async () => {
    const store = createStore();
    const request = { ...createRequest(vi.fn(async () => [])), question: '   ' };

    await expect(
      createCore(store, { run: vi.fn() }).handleTurn(request, createSink()),
    ).resolves.toEqual({ status: 'rejected', reason: 'empty_question' });
    expect(store.getSettings).not.toHaveBeenCalled();
  });

  it('does not read ambient channel history when context is zero', async () => {
    const store = createStore();
    const loadAmbientContext = vi.fn(async () => [
      {
        id: 'private-message',
        content: 'private',
      },
    ]);
    const modelRunner: ModelRunner = {
      run: vi.fn(async (_request, onDelta) => {
        await onDelta('Ahoj!');
        return { content: 'Ahoj!', usage };
      }),
    };
    const jolanda = createCore(store, modelRunner);

    const outcome = await jolanda.handleTurn(createRequest(loadAmbientContext), createSink());

    expect(outcome).toEqual({ status: 'completed', conversationId: 'conversation' });
    expect(loadAmbientContext).not.toHaveBeenCalled();
    expect(store.appendTurn).toHaveBeenCalledOnce();
  });

  it('uses the latest server-scoped settings on an interaction', async () => {
    const store = createStore();
    vi.mocked(store.getSettings).mockResolvedValue({
      guildId: 'guild',
      model: 'deepseek-v4-flash',
      reasoning: 'high',
      contextMessages: 1,
      updatedAt: new Date(),
    });
    const loadAmbientContext = vi.fn(async () => [
      {
        id: 'context-message',
        content: 'Relevant context',
      },
    ]);
    const modelRunner: ModelRunner = {
      run: vi.fn(async (_request, onDelta) => {
        await onDelta('Answer');
        return { content: 'Answer', usage };
      }),
    };
    const jolanda = createCore(store, modelRunner);

    await jolanda.handleTurn(createRequest(loadAmbientContext), createSink());

    expect(loadAmbientContext).toHaveBeenCalledWith(1);
    expect(modelRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'deepseek-v4-flash', reasoning: 'high' }),
      expect.any(Function),
    );
  });

  it('rejects an eleventh bot reply before authorizing inference', async () => {
    const store = createStore();
    vi.mocked(store.findConversationByMessage).mockResolvedValue({
      id: 'conversation',
      ownerKey: 'protected:user',
      replyCount: 10,
      turns: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const modelRunner: ModelRunner = { run: vi.fn() };
    const jolanda = createCore(store, modelRunner);
    const request: TurnRequest = {
      ...createRequest(vi.fn(async () => [])),
      referencedMessage: {
        id: 'bot-message',
        content: 'Previous answer',
        isJolanda: true,
      },
    };

    const outcome = await jolanda.handleTurn(request, createSink());

    expect(outcome).toEqual({ status: 'rejected', reason: 'conversation_limit' });
    expect(store.authorizeTurn).not.toHaveBeenCalled();
    expect(modelRunner.run).not.toHaveBeenCalled();
  });

  it('authorizes before reading ambient history', async () => {
    const store = createStore();
    vi.mocked(store.getSettings).mockResolvedValue({
      guildId: 'guild',
      model: 'luna',
      reasoning: 'medium',
      contextMessages: 20,
      updatedAt: new Date(),
    });
    vi.mocked(store.authorizeTurn).mockResolvedValue({ ok: false, reason: 'rate_limited' });
    const loadAmbientContext = vi.fn(async () => []);
    const modelRunner: ModelRunner = { run: vi.fn() };

    const outcome = await createCore(store, modelRunner).handleTurn(
      createRequest(loadAmbientContext),
      createSink(),
    );

    expect(outcome).toEqual({ status: 'rejected', reason: 'rate_limited' });
    expect(loadAmbientContext).not.toHaveBeenCalled();
    expect(modelRunner.run).not.toHaveBeenCalled();
  });

  it('owner-binds continued conversations', async () => {
    const store = createStore();
    vi.mocked(store.findConversationByMessage).mockResolvedValue({
      id: 'conversation',
      ownerKey: 'protected:someone-else',
      replyCount: 1,
      turns: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const request: TurnRequest = {
      ...createRequest(vi.fn(async () => [])),
      referencedMessage: { id: 'bot-message', content: 'answer', isJolanda: true },
    };

    const outcome = await createCore(store, { run: vi.fn() }).handleTurn(request, createSink());

    expect(outcome).toEqual({ status: 'rejected', reason: 'conversation_owner' });
    expect(store.authorizeTurn).not.toHaveBeenCalled();
  });

  it.each([
    [null, true, 'expired_conversation'],
    [
      {
        id: 'conversation',
        ownerKey: 'protected:user',
        replyCount: 1,
        turns: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
      false,
      'conversation_busy',
    ],
  ] satisfies Array<
    [
      Conversation | null,
      boolean,
      Exclude<TurnOutcome, { status: 'completed' } | { status: 'failed' }>['reason'],
    ]
  >)('rejects unavailable conversation state: %s', async (conversation, lock, reason) => {
    const store = createStore();
    vi.mocked(store.findConversationByMessage).mockResolvedValue(conversation);
    vi.mocked(store.tryLockConversation).mockResolvedValue(lock);
    const request: TurnRequest = {
      ...createRequest(vi.fn(async () => [])),
      referencedMessage: { id: 'bot-message', content: 'answer', isJolanda: true },
    };

    await expect(
      createCore(store, { run: vi.fn() }).handleTurn(request, createSink()),
    ).resolves.toEqual({ status: 'rejected', reason });
  });

  it('includes explicit reply content at context zero without Discord metadata', async () => {
    const store = createStore();
    const modelRunner: ModelRunner = {
      run: vi.fn(async () => ({ content: 'Answer', usage })),
    };
    const request: TurnRequest = {
      ...createRequest(vi.fn(async () => [])),
      referencedMessage: {
        id: '123456789012345678',
        content: 'quoted private text',
        isJolanda: false,
      },
    };

    await createCore(store, modelRunner).handleTurn(request, createSink());
    const call = vi.mocked(modelRunner.run).mock.calls[0]?.[0];

    expect(JSON.stringify(call?.messages)).toContain('quoted private text');
    expect(JSON.stringify(call?.messages)).not.toContain('123456789012345678');
    expect(call?.publicQuestion).toBe('Ahoj');
  });

  it.each([
    'Search for pros/cons of TypeScript',
    'Vyhľadaj výhody/nevýhody TypeScriptu',
    'Find the latest score Madrid 3:2',
    'Research producer/consumer patterns',
    'Summarize [OpenAI](https://openai.com/research)',
    'What is HTTP:3?',
    'Research HTTP/3',
    'Read [guide](documentation/start)',
    'What is [HTTP:3](#docs)?',
    'Explain HTTP:3 and open the current RFC',
    'Open docs then explain HTTP/3',
    'Search wave/particle duality',
  ])('keeps safe comparison and score prose eligible for public research: %s', async (question) => {
    const store = createStore();
    const modelRunner: ModelRunner = {
      run: vi.fn(async () => ({ content: 'Answer', usage })),
    };
    const request = { ...createRequest(vi.fn(async () => [])), question };

    await createCore(store, modelRunner).handleTurn(request, createSink());

    expect(vi.mocked(modelRunner.run).mock.calls[0]?.[0].publicQuestion).toBe(question);
  });

  it.each([
    'curl 10:10',
    'GET input/output',
    'Pripoj sa k qa/foo',
    'Search [127].0.0.1',
    'Search qa/admin now',
    'qa/foo. Look it up',
    'Open HTTP:10',
    'Open HTTP:3',
    'What is qa/foo?',
    'Search qa/admin architecture',
    '1qa:8080',
    'žaba:8080',
    'Search — qa/foo',
    'qa/foo. Please look it up',
    'qa/foo. Search for it',
    'What is [host](127.0.0.1 "title")?',
    'Search [safe](//localhost/admin)',
    'Search [127.0.0.1](#details)',
    'Open [::1]:**80**/admin',
    'Connect! alpha/beta',
    'alpha/beta. Could you please look it up?',
    'Research preprod/api architecture',
    'Search sandbox/dashboard lifecycle',
    'Open login/config',
    'Search [safe](./localhost/admin)',
    'Search [[[[[localhost](#a)](#b)](#c)](#d)](#e)',
    'Open «::1»:80/admin',
    'Open [**::1**]:[80]',
    'Could you search? alpha/beta',
    'Lookup! alpha/beta',
    'alpha/beta. Connect to it',
    'The target is alpha/beta',
    'printer/docs',
    'Visit HTTP:3 protocol',
    'Search foo/bar now',
    'Search [safe](/docs/localhost/admin)',
    'Open «::1»:«80»/admin',
    'What is HTTP:3? Open it',
    'Open input/output architecture',
    'Research alpha/beta architecture. Open it',
  ])('keeps strong private-target intent out of the research request: %s', async (question) => {
    const store = createStore();
    const modelRunner: ModelRunner = {
      run: vi.fn(async () => ({ content: 'Answer', usage })),
    };
    const request = { ...createRequest(vi.fn(async () => [])), question };

    await createCore(store, modelRunner).handleTurn(request, createSink());

    expect(vi.mocked(modelRunner.run).mock.calls[0]?.[0]).not.toHaveProperty('publicQuestion');
  });

  it('releases authorization when context loading fails before inference', async () => {
    const store = createStore();
    vi.mocked(store.getSettings).mockResolvedValue({
      guildId: 'guild',
      model: 'luna',
      reasoning: 'medium',
      contextMessages: 1,
      updatedAt: new Date(),
    });
    const sink = createSink();
    const modelRunner: ModelRunner = { run: vi.fn() };

    const outcome = await createCore(store, modelRunner).handleTurn(
      createRequest(vi.fn(async () => Promise.reject(new Error('Discord unavailable')))),
      sink,
    );

    expect(outcome).toEqual({ status: 'failed' });
    expect(store.failRequest).toHaveBeenCalledWith('request', 'before_inference');
    expect(store.settleRequest).not.toHaveBeenCalled();
    expect(sink.fail).toHaveBeenCalledOnce();
  });

  it('throttles accumulated streaming sanitization before the response sink', async () => {
    const store = createStore();
    const sink = createSink();
    const modelRunner: ModelRunner = {
      run: vi.fn(async (_request, onDelta) => {
        for (let index = 0; index < 2_000; index += 1) await onDelta('[');
        return { content: 'Done', usage };
      }),
    };

    await createCore(store, modelRunner).handleTurn(createRequest(vi.fn(async () => [])), sink);

    expect(sink.update).toHaveBeenCalledOnce();
    expect(sink.finish).toHaveBeenCalledWith('Done', [], expect.any(AbortSignal));
  });

  it('resumes streaming updates at the throttle boundary', async () => {
    vi.useFakeTimers();
    try {
      const store = createStore();
      const sink = createSink();
      const modelRunner: ModelRunner = {
        run: vi.fn(async (_request, onDelta) => {
          await onDelta('A');
          await vi.advanceTimersByTimeAsync(999);
          await onDelta('B');
          await vi.advanceTimersByTimeAsync(1);
          await onDelta('C');
          return { content: 'ABC', usage };
        }),
      };

      await createCore(store, modelRunner).handleTurn(createRequest(vi.fn(async () => [])), sink);

      expect(sink.update).toHaveBeenCalledTimes(2);
      expect(sink.update).toHaveBeenLastCalledWith('ABC', [], expect.any(AbortSignal));
    } finally {
      vi.useRealTimers();
    }
  });

  it('charges the full envelope when inference usage is unavailable', async () => {
    const store = createStore();
    const modelRunner: ModelRunner = {
      run: vi.fn(async () => ({ content: 'Answer without usage' })),
    };

    const outcome = await createCore(store, modelRunner).handleTurn(
      createRequest(vi.fn(async () => [])),
      createSink(),
    );

    expect(outcome.status).toBe('completed');
    expect(store.settleRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request',
        status: 'usage_missing',
        usage: expect.objectContaining({ costMicrodollars: expect.any(Number) }),
      }),
    );
    const settlement = vi.mocked(store.settleRequest).mock.calls[0]?.[0];
    expect(settlement?.usage.costMicrodollars).toBeGreaterThan(100_000);
  });

  it('settles conservatively and notifies Discord when inference fails', async () => {
    const store = createStore();
    const sink = createSink();
    const modelRunner: ModelRunner = {
      run: vi.fn(async () => Promise.reject(new Error('provider unavailable'))),
    };

    const outcome = await createCore(store, modelRunner).handleTurn(
      createRequest(vi.fn(async () => [])),
      sink,
    );

    expect(outcome).toEqual({ status: 'failed' });
    expect(store.settleRequest).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'usage_missing' }),
    );
    expect(sink.fail).toHaveBeenCalledOnce();
  });

  it('delivers a completed answer even if conversation persistence fails', async () => {
    const store = createStore();
    vi.mocked(store.appendTurn).mockRejectedValue(new Error('Mongo write failed'));
    const modelRunner: ModelRunner = {
      run: vi.fn(async () => ({ content: 'Delivered', usage })),
    };

    const outcome = await createCore(store, modelRunner).handleTurn(
      createRequest(vi.fn(async () => [])),
      createSink(),
    );

    expect(outcome).toEqual({ status: 'completed', conversationId: 'conversation' });
  });

  it('bounds process-wide inference concurrency before a second authorization', async () => {
    const store = createStore();
    let resolveFirst: ((value: { content: string; usage: typeof usage }) => void) | undefined;
    const modelRunner: ModelRunner = {
      run: vi.fn(
        async () =>
          new Promise<{ content: string; usage: typeof usage }>((resolve) => {
            resolveFirst = resolve;
          }),
      ),
    };
    const core = createCore(store, modelRunner, 1);
    const first = core.handleTurn(createRequest(vi.fn(async () => [])), createSink());
    await vi.waitFor(() => expect(modelRunner.run).toHaveBeenCalledOnce());

    const second = await core.handleTurn(
      { ...createRequest(vi.fn(async () => [])), id: 'second' },
      createSink(),
    );

    expect(second).toEqual({ status: 'rejected', reason: 'server_busy' });
    expect(store.authorizeTurn).toHaveBeenCalledOnce();
    resolveFirst?.({ content: 'Done', usage });
    await first;
  });

  it('aborts and settles active inference before shutdown completes', async () => {
    const store = createStore();
    const modelRunner: ModelRunner = {
      run: vi.fn(
        async (request: ModelRunRequest) =>
          new Promise<never>((_, reject) => {
            if (request.signal?.aborted) reject(request.signal.reason);
            request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
              once: true,
            });
          }),
      ),
    };
    const sink = createSink();
    const core = createCore(store, modelRunner);
    const active = core.handleTurn(createRequest(vi.fn(async () => [])), sink);
    await vi.waitFor(() => expect(modelRunner.run).toHaveBeenCalledOnce());

    await core.shutdown();

    await expect(active).resolves.toEqual({ status: 'failed' });
    expect(store.settleRequest).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'usage_missing' }),
    );
    expect(sink.fail).not.toHaveBeenCalled();
    await expect(
      core.handleTurn(
        { ...createRequest(vi.fn(async () => [])), id: 'after-shutdown' },
        createSink(),
      ),
    ).resolves.toEqual({ status: 'rejected', reason: 'shutting_down' });
  });

  it('aborts a stuck ambient-history read during shutdown before inference starts', async () => {
    const store = createStore();
    vi.mocked(store.getSettings).mockResolvedValue({
      guildId: 'guild',
      model: 'luna',
      reasoning: 'medium',
      contextMessages: 1,
      updatedAt: new Date(),
    });
    const loadAmbientContext = vi.fn(async () => new Promise<never>(() => undefined));
    const modelRunner: ModelRunner = { run: vi.fn() };
    const core = createCore(store, modelRunner);
    const active = core.handleTurn(createRequest(loadAmbientContext), createSink());
    await vi.waitFor(() => expect(loadAmbientContext).toHaveBeenCalledOnce());

    await core.shutdown();

    await expect(active).resolves.toEqual({ status: 'failed' });
    expect(modelRunner.run).not.toHaveBeenCalled();
    expect(store.failRequest).toHaveBeenCalledWith('request', 'before_inference');
  });

  it('keeps a timed-out side-effecting sink operation tracked through shutdown', async () => {
    vi.useFakeTimers();
    try {
      const store = createStore();
      const modelRunner: ModelRunner = {
        run: vi.fn(async () => ({ content: 'answer', usage })),
      };
      let finish: ((messageIds: string[]) => void) | undefined;
      const sink = createSink();
      vi.mocked(sink.finish).mockImplementation(
        async () =>
          new Promise<string[]>((resolve) => {
            finish = resolve;
          }),
      );
      const core = createCore(store, modelRunner);
      const active = core.handleTurn(createRequest(vi.fn(async () => [])), sink);
      await vi.waitFor(() => expect(sink.finish).toHaveBeenCalledOnce());

      await vi.advanceTimersByTimeAsync(discordOperationTimeoutMs);
      await expect(active).resolves.toEqual({ status: 'failed' });
      expect(sink.fail).toHaveBeenCalledOnce();

      let shutdownFinished = false;
      const shutdown = core.shutdown().then(() => {
        shutdownFinished = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(shutdownFinished).toBe(false);

      finish?.(['bot-message']);
      await shutdown;
      expect(shutdownFinished).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps shutdown failed when conservative settlement cannot be persisted', async () => {
    const store = createStore();
    vi.mocked(store.settleRequest).mockRejectedValue(new Error('Mongo unavailable'));
    const modelRunner: ModelRunner = {
      run: vi.fn(
        async (request: ModelRunRequest) =>
          new Promise<never>((_, reject) => {
            request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
              once: true,
            });
          }),
      ),
    };
    const core = createCore(store, modelRunner);
    const active = core.handleTurn(createRequest(vi.fn(async () => [])), createSink());
    await vi.waitFor(() => expect(modelRunner.run).toHaveBeenCalledOnce());

    await expect(core.shutdown()).rejects.toThrow('unsettled requests');

    await expect(active).resolves.toEqual({ status: 'failed' });
    expect(store.settleRequest).toHaveBeenCalledTimes(4);
  });
});
