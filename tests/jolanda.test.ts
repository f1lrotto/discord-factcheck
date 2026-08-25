import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createJolanda } from '../src/jolanda.js';
import { discordOperationTimeoutMs, openRouterStreamStartTimeoutMs } from '../src/limits.js';
import { ModelFailure } from '../src/model-failure.js';
import type { GuildSettings } from '../src/models.js';
import { formatUsd } from '../src/money.js';
import type {
  JolandaStore,
  Conversation,
  ModelProgress,
  ModelRunRequest,
  ModelRunResult,
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

const modelOnlyDisplay = (content: string) =>
  `${content}\n\n---\n🧠 **Source basis:** No public web research was used.\n💵 **Response cost:** $0.0010`;

const createStore = (): JolandaStore => ({
  initialize: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  getSettings: vi.fn(
    async (guildId: string) =>
      ({
        guildId,
        model: 'luna',
        reasoning: 'medium',
        contextLimitMessages: 0,
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
  question: 'Vysvetli fotosyntézu',
  loadAmbientContext,
});

const createCore = (
  store: JolandaStore,
  modelRunner: ModelRunner,
  maximumConcurrentTurns = 2,
  logger = pino({ enabled: false }),
  now?: () => Date,
) =>
  createJolanda({
    store,
    modelRunner,
    logger,
    maximumContextMessages: 50,
    maximumPromptCharacters: 32_000,
    maximumConcurrentTurns,
    transcriptTtlMs: 7 * 24 * 60 * 60 * 1_000,
    timeZone: 'Europe/Bratislava',
    protectIdentifier: (value) => `protected:${value}`,
    createId: () => 'conversation',
    ...(now ? { now } : {}),
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

  it.each([
    ['hi', 'Hi! How can I help?'],
    ['Ahoj!', 'Ahoj! Ako môžem pomôcť?'],
    ['thank you', "You're welcome!"],
    ['ďakujem', 'Rado sa stalo!'],
  ])(
    'answers an exact social turn locally without model or context work: %s',
    async (question, answer) => {
      const store = createStore();
      vi.mocked(store.getSettings).mockResolvedValue({
        guildId: 'guild',
        model: 'luna',
        reasoning: 'medium',
        contextLimitMessages: 5,
        updatedAt: new Date(),
      });
      const modelRunner: ModelRunner = { run: vi.fn() };
      const sink = createSink();
      const loadAmbientContext = vi.fn(async () => [{ id: 'private', content: 'private' }]);

      const outcome = await createCore(store, modelRunner).handleTurn(
        {
          ...createRequest(loadAmbientContext),
          question,
          ambientContext: { limit: 'maximum' },
          referencedMessage: {
            id: 'private-reference',
            content: 'private context marker',
            isJolanda: false,
          },
        },
        sink,
      );

      expect(outcome).toEqual({ status: 'completed', conversationId: 'conversation' });
      expect(modelRunner.run).not.toHaveBeenCalled();
      expect(loadAmbientContext).not.toHaveBeenCalled();
      expect(store.authorizeTurn).toHaveBeenCalledWith(
        expect.objectContaining({ reservationMicrodollars: 0 }),
      );
      expect(store.settleRequest).toHaveBeenCalledWith({
        requestId: 'request',
        usage: {
          costMicrodollars: 0,
          promptTokens: 0,
          completionTokens: 0,
          reasoningTokens: 0,
          webSearchRequests: 0,
        },
        status: 'completed',
      });
      expect(sink.finish).toHaveBeenCalledWith(answer, [], expect.any(AbortSignal));
      expect(JSON.stringify(vi.mocked(store.appendTurn).mock.calls)).not.toContain(
        'private context marker',
      );
    },
  );

  it('uses one model interface for a standalone question', async () => {
    const store = createStore();
    const loadAmbientContext = vi.fn(async () => [
      { id: 'private-message', content: 'private context marker' },
    ]);
    const modelRunner: ModelRunner = {
      run: vi.fn(async () => ({ content: 'Bratislava', usage })),
    };

    await createCore(store, modelRunner).handleTurn(
      {
        ...createRequest(loadAmbientContext),
        question: 'What is the capital of Slovakia?',
      },
      createSink(),
    );

    const request = vi.mocked(modelRunner.run).mock.calls[0]?.[0];
    expect(request).not.toHaveProperty('publicResearch');
    expect(loadAmbientContext).not.toHaveBeenCalled();
    expect(JSON.stringify(request?.messages)).not.toContain('private context marker');
  });

  it('passes one trusted clock snapshot through the prompt and model request', async () => {
    const store = createStore();
    const modelRunner: ModelRunner = {
      run: vi.fn(async () => ({ content: 'It is Tuesday.', usage })),
    };

    await createCore(
      store,
      modelRunner,
      2,
      pino({ enabled: false }),
      () => new Date('2026-08-25T12:34:56.000Z'),
    ).handleTurn(createRequest(vi.fn(async () => [])), createSink());

    const request = vi.mocked(modelRunner.run).mock.calls[0]?.[0];
    expect(request?.clock).toEqual({
      instant: '2026-08-25T12:34:56.000Z',
      timeZone: 'Europe/Bratislava',
      localDateTime: '2026-08-25T14:34:56',
      weekday: 'Tuesday',
      utcOffset: '+02:00',
    });
    expect(request?.messages[0]?.content).toContain('Trusted turn clock:');
    expect(request?.messages[0]?.content).toContain('2026-08-25T14:34:56+02:00');
  });

  it('passes a contextual investigation directly to the same model interface', async () => {
    const store = createStore();
    const modelRunner: ModelRunner = {
      run: vi.fn(async () => ({ content: 'Current answer', usage })),
    };
    const request: TurnRequest = {
      ...createRequest(vi.fn(async () => [])),
      question: 'investigate this',
      referencedMessage: {
        id: 'quoted-message',
        content: 'What are the hottest topics in Slovak politics from the past two weeks?',
        isJolanda: false,
      },
    };

    await createCore(store, modelRunner).handleTurn(request, createSink());

    const modelRequest = vi.mocked(modelRunner.run).mock.calls[0]?.[0];
    expect(modelRequest).not.toHaveProperty('publicResearch');
    expect(JSON.stringify(modelRequest?.messages)).toContain('investigate this');
    expect(JSON.stringify(modelRequest?.messages)).toContain('hottest topics in Slovak politics');
  });

  it('does not read ambient channel history when context is zero', async () => {
    const store = createStore();
    vi.mocked(store.getSettings).mockResolvedValue({
      guildId: 'guild',
      model: 'luna',
      reasoning: 'medium',
      contextLimitMessages: 20,
      updatedAt: new Date(),
    });
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
      contextLimitMessages: 1,
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

    await jolanda.handleTurn(
      {
        ...createRequest(loadAmbientContext),
        ambientContext: { limit: 'maximum' },
      },
      createSink(),
    );

    expect(loadAmbientContext).toHaveBeenCalledWith(1);
    expect(modelRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'deepseek-v4-flash', reasoning: 'high' }),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('renders safe ephemeral progress and replaces it with the final answer', async () => {
    const store = createStore();
    const sink = createSink();
    const modelRunner: ModelRunner = {
      run: vi.fn(async (_request, onDelta, onProgress) => {
        await onProgress?.({ type: 'stage', stage: 'answering' });
        await onProgress?.({
          type: 'reasoning_summary',
          delta: 'Comparing the evidence at https://private.example/path',
        });
        await onDelta('Final answer');
        await onProgress?.({ type: 'reasoning_summary', delta: 'late private summary' });
        return { content: 'Final answer', usage };
      }),
    };

    const outcome = await createCore(store, modelRunner).handleTurn(
      createRequest(vi.fn(async () => [])),
      sink,
    );

    expect(outcome).toEqual({ status: 'completed', conversationId: 'conversation' });
    expect(sink.update).toHaveBeenNthCalledWith(
      1,
      '🧠 Working through the question… · 00:00',
      [],
      expect.any(AbortSignal),
    );
    expect(sink.update).toHaveBeenNthCalledWith(
      2,
      '🧠 **Current approach**\nComparing the evidence at [link removed]\n\n⏱ 00:00',
      [],
      expect.any(AbortSignal),
    );
    expect(sink.update).toHaveBeenNthCalledWith(
      3,
      'Final answer\n\n🧠 Working through the question… · 00:00',
      [],
      expect.any(AbortSignal),
    );
    expect(sink.update).toHaveBeenCalledTimes(3);
    expect(sink.finish).toHaveBeenCalledWith(
      modelOnlyDisplay('Final answer'),
      [],
      expect.any(AbortSignal),
    );
    expect(store.appendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        turn: expect.objectContaining({ assistantContent: 'Final answer' }),
      }),
    );
    expect(JSON.stringify(vi.mocked(store.appendTurn).mock.calls)).not.toContain(
      'Comparing the evidence',
    );
    expect(JSON.stringify(vi.mocked(store.appendTurn).mock.calls)).not.toContain(
      'late private summary',
    );
  });

  it('updates elapsed time and distinguishes provider silence from a live stream', async () => {
    vi.useFakeTimers();
    try {
      const store = createStore();
      const sink = createSink();
      let reportProgress: ((progress: ModelProgress) => Promise<void>) | undefined;
      let completeModel: ((result: ModelRunResult) => void) | undefined;
      const modelRunner: ModelRunner = {
        run: vi.fn((_request, _onDelta, onProgress) => {
          reportProgress = onProgress;
          return new Promise<ModelRunResult>((resolve) => {
            completeModel = resolve;
          });
        }),
      };
      const active = createCore(store, modelRunner).handleTurn(
        createRequest(vi.fn(async () => [])),
        sink,
      );
      await vi.waitFor(() => expect(modelRunner.run).toHaveBeenCalledOnce());

      await reportProgress?.({ type: 'stage', stage: 'answering' });
      expect(sink.update).toHaveBeenLastCalledWith(
        '🧠 Working through the question… · 00:00',
        [],
        expect.any(AbortSignal),
      );

      await vi.advanceTimersByTimeAsync(16_000);
      expect(sink.update).toHaveBeenLastCalledWith(
        '🧠 Waiting for OpenRouter… · 00:16 · no activity for 00:16',
        [],
        expect.any(AbortSignal),
      );

      await reportProgress?.({ type: 'activity' });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(sink.update).toHaveBeenLastCalledWith(
        '🧠 Working through the question… · 00:18',
        [],
        expect.any(AbortSignal),
      );

      completeModel?.({ content: 'Answer', usage });
      await active;
      const completedUpdateCount = vi.mocked(sink.update).mock.calls.length;
      await vi.advanceTimersByTimeAsync(4_000);
      expect(sink.update).toHaveBeenCalledTimes(completedUpdateCount);
      expect(sink.finish).toHaveBeenCalledWith(
        modelOnlyDisplay('Answer'),
        [],
        expect.any(AbortSignal),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps progress moving after answer text starts and while the completed model result settles', async () => {
    vi.useFakeTimers();
    try {
      const store = createStore();
      const sink = createSink();
      let emitDelta: ((delta: string) => Promise<void>) | undefined;
      let completeModel: ((result: ModelRunResult) => void) | undefined;
      let completeSettlement: (() => void) | undefined;
      vi.mocked(store.settleRequest).mockImplementation(
        async () =>
          new Promise<void>((resolve) => {
            completeSettlement = resolve;
          }),
      );
      const modelRunner: ModelRunner = {
        run: vi.fn((_request, onDelta) => {
          emitDelta = (delta) => onDelta(delta);
          return new Promise<ModelRunResult>((resolve) => {
            completeModel = resolve;
          });
        }),
      };
      const active = createCore(store, modelRunner).handleTurn(
        createRequest(vi.fn(async () => [])),
        sink,
      );
      await vi.waitFor(() => expect(modelRunner.run).toHaveBeenCalledOnce());

      await vi.advanceTimersByTimeAsync(2_000);
      await emitDelta?.('Answer');
      await vi.advanceTimersByTimeAsync(4_000);
      expect(sink.update).toHaveBeenLastCalledWith(
        'Answer\n\n🧠 Working through the question… · 00:06',
        [],
        expect.any(AbortSignal),
      );

      completeModel?.({ content: 'Answer', usage });
      await vi.waitFor(() => expect(store.settleRequest).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(2_000);
      expect(sink.update).toHaveBeenLastCalledWith(
        'Answer\n\n📦 Finalizing the response… · 00:08',
        [],
        expect.any(AbortSignal),
      );

      completeSettlement?.();
      await active;
      const completedUpdateCount = vi.mocked(sink.update).mock.calls.length;
      await vi.advanceTimersByTimeAsync(4_000);
      expect(sink.update).toHaveBeenCalledTimes(completedUpdateCount);
      expect(sink.finish).toHaveBeenCalledWith(
        modelOnlyDisplay('Answer'),
        [],
        expect.any(AbortSignal),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      name: 'model-only answer',
      result: { content: 'Answer', usage },
      expected: 'No public web research was used',
    },
    {
      name: 'web-grounded answer',
      result: {
        content: 'Answer',
        usage: { ...usage, webSearchRequests: 1 },
        allowedSourceUrls: ['https://example.com/fact', 'https://example.org/reference'],
      },
      expected: '[Source 1](https://example.com/fact)',
    },
    {
      name: 'searched answer without usable citation links',
      result: { content: 'Answer', usage: { ...usage, webSearchRequests: 1 } },
      expected: 'Public web research was used, but OpenRouter returned no usable source links',
    },
    {
      name: 'answer with missing usage metadata',
      result: { content: 'Answer' },
      expected: 'did not report whether public web research was used',
    },
  ] satisfies Array<{ name: string; result: ModelRunResult; expected: string }>)(
    'renders trusted source provenance for a $name',
    async ({ result, expected }) => {
      const store = createStore();
      const sink = createSink();
      const modelRunner: ModelRunner = { run: vi.fn(async () => result) };

      await createCore(store, modelRunner).handleTurn(createRequest(vi.fn(async () => [])), sink);

      const displayed = vi.mocked(sink.finish).mock.calls[0]?.[0];
      expect(displayed).toContain(expected);
      expect(displayed).toContain('💵 **Response cost:**');
      expect(vi.mocked(store.appendTurn).mock.calls[0]?.[0].turn.assistantContent).toBe('Answer');
    },
  );

  it('shows the conservative charged cost when provider usage is missing', async () => {
    const store = createStore();
    const sink = createSink();
    const modelRunner: ModelRunner = { run: vi.fn(async () => ({ content: 'Answer' })) };

    await createCore(store, modelRunner).handleTurn(createRequest(vi.fn(async () => [])), sink);

    const settlement = vi.mocked(store.settleRequest).mock.calls[0]?.[0];
    const displayed = vi.mocked(sink.finish).mock.calls[0]?.[0];
    expect(settlement).toBeDefined();
    expect(displayed).toContain(
      `💵 **Response cost:** ${formatUsd(settlement?.usage.costMicrodollars ?? 0)}`,
    );
    expect(displayed).toContain('conservative charge because provider usage was not reported');
  });

  it('shows a reported zero-cost model response without implying missing usage', async () => {
    const store = createStore();
    const sink = createSink();
    const modelRunner: ModelRunner = {
      run: vi.fn(async () => ({ content: 'Answer', usage: { ...usage, costMicrodollars: 0 } })),
    };

    await createCore(store, modelRunner).handleTurn(createRequest(vi.fn(async () => [])), sink);

    const displayed = vi.mocked(sink.finish).mock.calls[0]?.[0];
    expect(displayed).toContain('💵 **Response cost:** $0.0000');
    expect(displayed).not.toContain('conservative charge');
  });

  it('records source provenance in the canonical turn event without persisting its UI footer', async () => {
    const store = createStore();
    const sink = createSink();
    const lines: string[] = [];
    const logger = pino({ level: 'info' }, { write: (line: string) => lines.push(line) });
    const modelRunner: ModelRunner = {
      run: vi.fn(async () => ({
        content: 'Grounded answer',
        usage: { ...usage, webSearchRequests: 1 },
        allowedSourceUrls: ['https://example.com/fact'],
      })),
    };

    await createCore(store, modelRunner, 2, logger).handleTurn(
      createRequest(vi.fn(async () => [])),
      sink,
    );

    const turnEvent = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event.event === 'jolanda_turn');
    expect(turnEvent).toMatchObject({
      outcome: 'completed',
      sourceBasis: 'web_sources',
      sourceCount: 1,
      webSearchRequests: 1,
    });
    expect(vi.mocked(store.appendTurn).mock.calls[0]?.[0].turn.assistantContent).toBe(
      'Grounded answer',
    );
  });

  it('renders provider annotations once in the trusted footer without rewriting the answer', async () => {
    const store = createStore();
    const sink = createSink();
    const modelRunner: ModelRunner = {
      run: vi.fn(async () => ({
        content: '# Upcoming events are listed.',
        usage: { ...usage, webSearchRequests: 1 },
        allowedSourceUrls: ['https://events.example.com/calendar'],
        sourceCitations: [
          {
            url: 'https://events.example.com/calendar',
            title: 'Official events calendar',
            startIndex: 0,
            endIndex: 14,
          },
        ],
      })),
    };

    await createCore(store, modelRunner).handleTurn(createRequest(vi.fn(async () => [])), sink);

    const sourceLink = '[Source 1: Official events calendar](https://events.example.com/calendar)';
    const displayed = vi.mocked(sink.finish).mock.calls[0]?.[0];
    expect(displayed).toContain('**Upcoming events are listed.**');
    expect(displayed).toContain(sourceLink);
    expect(displayed?.indexOf(sourceLink)).toBeGreaterThan(
      displayed?.indexOf('Upcoming events') ?? -1,
    );
    expect(displayed?.indexOf('💵 **Response cost:**')).toBeGreaterThan(
      displayed?.indexOf(sourceLink) ?? -1,
    );
    expect(displayed?.match(/Official events calendar/gu)).toHaveLength(1);
    expect(vi.mocked(store.appendTurn).mock.calls[0]?.[0].turn.assistantContent).toBe(
      '**Upcoming events are listed.**',
    );
    expect(vi.mocked(store.appendTurn).mock.calls[0]?.[0].turn.assistantContent).not.toContain(
      'Source basis',
    );
  });

  it('rejects per-turn context above the server policy before authorization or history reads', async () => {
    const store = createStore();
    vi.mocked(store.getSettings).mockResolvedValue({
      guildId: 'guild',
      model: 'luna',
      reasoning: 'medium',
      contextLimitMessages: 5,
      updatedAt: new Date(),
    });
    const loadAmbientContext = vi.fn(async () => []);
    const modelRunner: ModelRunner = { run: vi.fn() };
    const request = {
      ...createRequest(loadAmbientContext),
      ambientContext: { limit: 6 } as const,
    };

    await expect(createCore(store, modelRunner).handleTurn(request, createSink())).resolves.toEqual(
      {
        status: 'rejected',
        reason: 'context_limit',
      },
    );
    expect(store.authorizeTurn).not.toHaveBeenCalled();
    expect(loadAmbientContext).not.toHaveBeenCalled();
    expect(modelRunner.run).not.toHaveBeenCalled();
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
      contextLimitMessages: 20,
      updatedAt: new Date(),
    });
    vi.mocked(store.authorizeTurn).mockResolvedValue({ ok: false, reason: 'rate_limited' });
    const loadAmbientContext = vi.fn(async () => []);
    const modelRunner: ModelRunner = { run: vi.fn() };

    const outcome = await createCore(store, modelRunner).handleTurn(
      {
        ...createRequest(loadAmbientContext),
        ambientContext: { limit: 'maximum' },
      },
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
    expect(call).not.toHaveProperty('publicResearch');
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
  ])('routes ordinary requests through the same assistant interface: %s', async (question) => {
    const store = createStore();
    const modelRunner: ModelRunner = {
      run: vi.fn(async () => ({ content: 'Answer', usage })),
    };
    const request = { ...createRequest(vi.fn(async () => [])), question };

    await createCore(store, modelRunner).handleTurn(request, createSink());

    const modelRequest = vi.mocked(modelRunner.run).mock.calls[0]?.[0];
    expect(modelRequest).not.toHaveProperty('publicResearch');
    expect(JSON.stringify(modelRequest?.messages)).toContain(question);
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
  ])('does not classify or reroute request text before inference: %s', async (question) => {
    const store = createStore();
    const modelRunner: ModelRunner = {
      run: vi.fn(async () => ({ content: 'Answer', usage })),
    };
    const request = { ...createRequest(vi.fn(async () => [])), question };

    await createCore(store, modelRunner).handleTurn(request, createSink());

    expect(vi.mocked(modelRunner.run).mock.calls[0]?.[0]).not.toHaveProperty('publicResearch');
  });

  it('releases authorization when context loading fails before inference', async () => {
    const store = createStore();
    vi.mocked(store.getSettings).mockResolvedValue({
      guildId: 'guild',
      model: 'luna',
      reasoning: 'medium',
      contextLimitMessages: 1,
      updatedAt: new Date(),
    });
    const sink = createSink();
    const modelRunner: ModelRunner = { run: vi.fn() };

    const outcome = await createCore(store, modelRunner).handleTurn(
      {
        ...createRequest(vi.fn(async () => Promise.reject(new Error('Discord unavailable')))),
        ambientContext: { limit: 'maximum' },
      },
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
    expect(sink.finish).toHaveBeenCalledWith(modelOnlyDisplay('Done'), [], expect.any(AbortSignal));
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
      expect(sink.update).toHaveBeenLastCalledWith(
        'ABC\n\n🧠 Working through the question… · 00:01',
        [],
        expect.any(AbortSignal),
      );
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

  it('correlates a safe provider failure notice with the structured turn event', async () => {
    const store = createStore();
    const sink = createSink();
    const lines: string[] = [];
    const logger = pino({ level: 'info' }, { write: (line: string) => lines.push(line) });
    const modelRunner: ModelRunner = {
      run: vi.fn(async () =>
        Promise.reject(
          new ModelFailure({
            category: 'rate_limited',
            stage: 'answer',
            status: 429,
            code: 'rate_limit_exceeded',
            generationId: 'gen-safe-123',
            provider: 'Example Provider',
            routingStrategy: 'fallback',
            attempt: 2,
            elapsedMs: 1_234,
            providerQuietMs: 200,
          }),
        ),
      ),
    };

    await createCore(store, modelRunner, 2, logger).handleTurn(
      createRequest(vi.fn(async () => [])),
      sink,
    );

    expect(sink.fail).toHaveBeenCalledWith(
      '',
      [],
      {
        category: 'rate_limited',
        stage: 'answer',
        reference: 'PROTECTEDR',
      },
      expect.any(AbortSignal),
    );
    const turnEvent = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event.event === 'jolanda_turn');
    expect(turnEvent).toMatchObject({
      outcome: 'failed',
      failureReference: 'PROTECTEDR',
      providerFailure: {
        category: 'rate_limited',
        stage: 'answer',
        status: 429,
        code: 'rate_limit_exceeded',
        generationId: 'gen-safe-123',
        provider: 'Example Provider',
        routingStrategy: 'fallback',
        attempt: 2,
      },
    });
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

  it('does not impose an overall deadline after inference has started', async () => {
    vi.useFakeTimers();
    try {
      const store = createStore();
      const sink = createSink();
      let modelSignal: AbortSignal | undefined;
      let completeModel: ((result: ModelRunResult) => void) | undefined;
      const modelRunner: ModelRunner = {
        run: vi.fn(
          (request) =>
            new Promise<ModelRunResult>((resolve) => {
              modelSignal = request.signal;
              completeModel = resolve;
            }),
        ),
      };
      const active = createCore(store, modelRunner).handleTurn(
        createRequest(vi.fn(async () => [])),
        sink,
      );
      await vi.waitFor(() => expect(modelRunner.run).toHaveBeenCalledOnce());

      await vi.advanceTimersByTimeAsync(openRouterStreamStartTimeoutMs * 2);
      expect(modelSignal?.aborted).toBe(false);

      completeModel?.({ content: 'Answer', usage });
      await expect(active).resolves.toEqual({
        status: 'completed',
        conversationId: expect.any(String),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a stuck ambient-history read during shutdown before inference starts', async () => {
    const store = createStore();
    vi.mocked(store.getSettings).mockResolvedValue({
      guildId: 'guild',
      model: 'luna',
      reasoning: 'medium',
      contextLimitMessages: 1,
      updatedAt: new Date(),
    });
    const loadAmbientContext = vi.fn(async () => new Promise<never>(() => undefined));
    const modelRunner: ModelRunner = { run: vi.fn() };
    const core = createCore(store, modelRunner);
    const active = core.handleTurn(
      {
        ...createRequest(loadAmbientContext),
        ambientContext: { limit: 'maximum' },
      },
      createSink(),
    );
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
