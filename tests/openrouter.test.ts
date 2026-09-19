import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  maximumResponseCharacters,
  maximumReasoningSummaryCharacters,
  maximumProviderErrorBytes,
  maximumSseFrameCharacters,
  maximumSseReadBytes,
  openRouterStreamStartTimeoutMs,
  openRouterMaximumAttempts,
} from '../src/limits.js';
import { ModelFailure } from '../src/model-failure.js';
import {
  createOpenRouter as createOpenRouterAdapter,
  extractSseFrames,
} from '../src/openrouter.js';
import { createClockSnapshot } from '../src/clock.js';
import type { ModelProgress, ModelRunner, ModelRunRequest } from '../src/types.js';

const clock = createClockSnapshot(new Date('2026-08-25T12:00:00.000Z'), 'Europe/Bratislava');

const createTestOpenRouter = (...input: Parameters<typeof createOpenRouterAdapter>) => {
  const runner = createOpenRouterAdapter({ waitForRetry: async () => undefined, ...input[0] });
  const run = (
    request: Omit<ModelRunRequest, 'clock'>,
    onDelta: Parameters<ModelRunner['run']>[1],
    onProgress?: Parameters<ModelRunner['run']>[2],
  ) =>
    onProgress
      ? runner.run({ locale: 'en', ...request, clock }, onDelta, onProgress)
      : runner.run({ locale: 'en', ...request, clock }, onDelta);
  return { run };
};

const sse = (input: {
  content: string;
  cost: number;
  promptTokens?: number;
  completionTokens?: number;
  webSearchRequests?: number;
  citationUrls?: string[];
  citationAnnotations?: unknown[];
  reasoningDetails?: unknown[];
  finishReason?: string;
}) =>
  [
    `data: ${JSON.stringify({
      id: 'generation',
      choices: [
        {
          ...(input.finishReason ? { finish_reason: input.finishReason } : {}),
          delta: {
            content: input.content,
            ...(input.reasoningDetails ? { reasoning_details: input.reasoningDetails } : {}),
            ...(input.citationUrls || input.citationAnnotations
              ? {
                  annotations:
                    input.citationAnnotations ??
                    input.citationUrls?.map((url) => ({
                      type: 'url_citation',
                      url_citation: { url, title: 'Source' },
                    })),
                }
              : {}),
          },
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: 'generation',
      choices: [],
      usage: {
        cost: input.cost,
        prompt_tokens: input.promptTokens ?? 10,
        completion_tokens: input.completionTokens ?? 5,
        completion_tokens_details: { reasoning_tokens: 2 },
        server_tool_use: { web_search_requests: input.webSearchRequests ?? 0 },
      },
    })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');

const functionToolSse = (input: {
  id: string;
  name: string;
  argumentFragments: string[];
  cost?: number;
}) =>
  [
    ...input.argumentFragments.map(
      (arguments_, index) =>
        `data: ${JSON.stringify({
          id: 'generation',
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    ...(index === 0 ? { id: input.id, type: 'function' } : {}),
                    function: {
                      ...(index === 0 ? { name: input.name } : {}),
                      arguments: arguments_,
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
    ),
    `data: ${JSON.stringify({
      id: 'generation',
      choices: [],
      usage: {
        cost: input.cost ?? 0.001,
        prompt_tokens: 10,
        completion_tokens: 5,
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');

const response = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/event-stream', ...headers },
  });

const bodyAt = (fetchMock: ReturnType<typeof vi.fn>, index: number) => {
  const request = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  if (!request) throw new Error(`OpenRouter request ${index} was not captured`);
  return JSON.parse(String(request.body)) as Record<string, unknown>;
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('extractSseFrames', () => {
  it('handles complete frames and preserves an incomplete tail', () => {
    const result = extractSseFrames('data: one\r\n\r\ndata: two\n\ndata: partial');

    expect(result.frames).toEqual(['data: one', 'data: two']);
    expect(result.remainder).toBe('data: partial');
  });
});

describe('OpenRouter adapter', () => {
  it('lets every model generation decide whether to use the complete toolbox', async () => {
    const fetchMock = vi.fn(async () =>
      response(sse({ content: 'Bratislava is the capital of Slovakia.', cost: 0.001 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });
    const deltas: string[] = [];
    const progress: ModelProgress[] = [];

    const result = await openRouter.run(
      {
        model: 'luna',
        reasoning: 'medium',
        messages: [
          { role: 'system', content: 'You are Jolanda.' },
          { role: 'user', content: 'What is the capital of Slovakia?' },
        ],
      },
      async (delta) => {
        deltas.push(delta);
      },
      async (event) => {
        progress.push(event);
      },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(bodyAt(fetchMock, 0)).toMatchObject({
      tool_choice: 'auto',
      max_tool_calls: 5,
    });
    expect(
      ((bodyAt(fetchMock, 0).tools ?? []) as Array<{ type: string }>).map(({ type }) => type),
    ).toEqual([
      'openrouter:datetime',
      'function',
      'function',
      'openrouter:web_search',
      'openrouter:web_fetch',
    ]);
    expect(JSON.stringify(bodyAt(fetchMock, 0))).not.toContain('NO_RESEARCH');
    expect(JSON.stringify(bodyAt(fetchMock, 0))).toContain(
      'direct read-only calculator, datetime, time-zone, public web-search, and public web-fetch tools',
    );
    expect(deltas).toEqual(['Bratislava is the capital of Slovakia.']);
    expect(progress.filter(({ type }) => type === 'stage')).toEqual([
      { type: 'stage', stage: 'answering' },
    ]);
    expect(result).toMatchObject({
      content: 'Bratislava is the capital of Slovakia.',
      diagnostics: { route: 'assistant' },
      usage: { webSearchRequests: 0 },
    });
  });

  it('retains bounded structured citation titles and ranges for inline rendering', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(
          sse({
            content: 'Upcoming events are listed.',
            cost: 0.001,
            webSearchRequests: 1,
            citationAnnotations: [
              {
                type: 'url_citation',
                url_citation: {
                  url: 'https://events.example.com/calendar?tracking=private',
                  title: 'Official events calendar',
                  content: 'Untrusted excerpt is deliberately not retained',
                  start_index: 0,
                  end_index: 14,
                },
              },
            ],
          }),
        ),
      ),
    );
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });

    const result = await openRouter.run(
      {
        model: 'luna',
        reasoning: 'medium',
        messages: [{ role: 'user', content: 'What events are next month?' }],
      },
      async () => undefined,
    );

    expect(result).toMatchObject({
      allowedSourceUrls: ['https://events.example.com/calendar'],
      sourceCitations: [
        {
          url: 'https://events.example.com/calendar',
          title: 'Official events calendar',
          startIndex: 0,
          endIndex: 14,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('Untrusted excerpt');
    expect(JSON.stringify(result)).not.toContain('tracking=private');
  });

  it('streams only bounded provider-generated reasoning summaries', async () => {
    const oversizedSummary = 's'.repeat(maximumReasoningSummaryCharacters + 100);
    const stream = [
      `data: ${JSON.stringify({
        id: 'generation',
        choices: [
          {
            delta: {
              reasoning: 'legacy raw reasoning',
              reasoning_details: [
                {
                  type: 'reasoning.text',
                  text: 'raw private chain of thought',
                  format: 'unknown',
                  id: null,
                },
                {
                  type: 'reasoning.encrypted',
                  data: 'encrypted-private-data',
                  format: 'openai-responses-v1',
                  id: 'encrypted',
                },
                {
                  type: 'reasoning.summary',
                  summary: oversizedSummary,
                  format: 'openai-responses-v1',
                  id: 'summary',
                },
              ],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: 'generation',
        choices: [
          {
            delta: {
              reasoning_details: [{ type: 'reasoning.summary', summary: 'ignored overflow' }],
              content: 'Answer',
            },
          },
        ],
      })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(stream)),
    );
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });
    const progress: ModelProgress[] = [];

    const result = await openRouter.run(
      {
        model: 'luna',
        reasoning: 'medium',
        messages: [{ role: 'user', content: 'Ahoj' }],
      },
      async () => undefined,
      async (event) => {
        progress.push(event);
      },
    );

    const summaries = progress.flatMap((event) =>
      event.type === 'reasoning_summary' ? [event.delta] : [],
    );
    expect(result.content).toBe('Answer');
    expect(progress[0]).toEqual({ type: 'stage', stage: 'answering' });
    expect(progress.filter(({ type }) => type === 'activity').length).toBeGreaterThanOrEqual(2);
    expect(summaries.join('')).toBe(oversizedSummary.slice(0, maximumReasoningSummaryCharacters));
    expect(JSON.stringify(progress)).not.toContain('raw private chain');
    expect(JSON.stringify(progress)).not.toContain('encrypted-private-data');
    expect(JSON.stringify(progress)).not.toContain('legacy raw reasoning');
  });

  it('routes GLM 5.3 Flash through its ZDR-compatible OpenRouter model', async () => {
    const fetchMock = vi.fn(async () => response(sse({ content: 'Safe', cost: 0.001 })));
    vi.stubGlobal('fetch', fetchMock);
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });

    await openRouter.run(
      {
        model: 'glm-5.3-flash',
        reasoning: 'max',
        messages: [{ role: 'user', content: 'Ahoj' }],
      },
      async () => undefined,
    );

    expect(bodyAt(fetchMock, 0)).toMatchObject({
      model: 'z-ai/glm-5.3-flash',
      reasoning: { effort: 'max', exclude: false },
      max_tokens: 81_920,
      provider: {
        data_collection: 'deny',
        zdr: true,
      },
    });
  });

  it('offers the same complete toolbox even when request text looks private', async () => {
    const fetchMock = vi.fn(async () => response(sse({ content: 'Safe', cost: 0.001 })));
    vi.stubGlobal('fetch', fetchMock);
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });

    await openRouter.run(
      {
        model: 'luna',
        reasoning: 'medium',
        messages: [{ role: 'user', content: 'My API key is private' }],
      },
      async () => undefined,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      ((bodyAt(fetchMock, 0).tools ?? []) as Array<{ type: string }>).map(({ type }) => type),
    ).toEqual([
      'openrouter:datetime',
      'function',
      'function',
      'openrouter:web_search',
      'openrouter:web_fetch',
    ]);
    expect(JSON.stringify(bodyAt(fetchMock, 0))).toContain(
      'Never claim that Jolanda lacks any of these attached capabilities',
    );
  });

  it('preserves image content parts through tool rounds and accounts for provider image usage', async () => {
    const streams = [
      functionToolSse({
        id: 'calculate_1',
        name: 'calculate',
        argumentFragments: ['{"expression":"2+2"}'],
      }),
      sse({ content: 'Four dogs.', cost: 0.002, promptTokens: 1500 }),
    ];
    const fetchMock = vi.fn(async () => response(streams.shift() ?? ''));
    vi.stubGlobal('fetch', fetchMock);
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });
    const message = {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: 'Add the dogs in these images.' },
        { type: 'image_url' as const, image_url: { url: 'data:image/jpeg;base64,IMAGE' } },
      ],
    };
    const result = await openRouter.run(
      { model: 'glm-5.3-flash', reasoning: 'high', messages: [message] },
      async () => undefined,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const index of [0, 1]) {
      expect(bodyAt(fetchMock, index).messages).toEqual(expect.arrayContaining([message]));
      expect(bodyAt(fetchMock, index).provider).toMatchObject({
        data_collection: 'deny',
        zdr: true,
        require_parameters: true,
      });
    }
    expect(result.usage).toMatchObject({ promptTokens: 1510, costMicrodollars: 3000 });
  });

  it('executes fragmented local function calls and returns their bounded result to the model', async () => {
    const streams = [
      functionToolSse({
        id: 'call_calculate_1',
        name: 'calculate',
        argumentFragments: ['{"expression":"(12 + ', '8) / 4"}'],
      }),
      sse({ content: 'The answer is 5.', cost: 0.002 }),
    ];
    const fetchMock = vi.fn(async () => response(streams.shift() ?? ''));
    vi.stubGlobal('fetch', fetchMock);
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });
    const deltas: string[] = [];

    const result = await openRouter.run(
      {
        model: 'luna',
        reasoning: 'medium',
        messages: [{ role: 'user', content: 'What is (12 + 8) / 4?' }],
      },
      async (delta) => {
        deltas.push(delta);
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyAt(fetchMock, 1).messages).toEqual([
      {
        role: 'system',
        content: expect.stringContaining('Jolanda has direct read-only calculator'),
      },
      { role: 'user', content: 'What is (12 + 8) / 4?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_calculate_1',
            type: 'function',
            function: {
              name: 'calculate',
              arguments: '{"expression":"(12 + 8) / 4"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_calculate_1',
        name: 'calculate',
        content: '{"ok":true,"expression":"(12 + 8) / 4","result":5}',
      },
    ]);
    expect(deltas).toEqual(['The answer is 5.']);
    expect(result).toMatchObject({
      content: 'The answer is 5.',
      usage: {
        costMicrodollars: 3_000,
        promptTokens: 20,
        completionTokens: 10,
        reasoningTokens: 4,
      },
      toolActivity: {
        offered: [
          'openrouter:datetime',
          'calculate',
          'get_datetime_in_timezone',
          'openrouter:web_search',
          'openrouter:web_fetch',
        ],
        called: ['calculate'],
        functionRounds: 1,
      },
      diagnostics: { route: 'assistant', toolRounds: [expect.any(Object)] },
    });
  });

  it('stops offering local functions after two bounded tool rounds', async () => {
    const streams = [
      functionToolSse({
        id: 'call_one',
        name: 'calculate',
        argumentFragments: ['{"expression":"6 * 7"}'],
      }),
      functionToolSse({
        id: 'call_two',
        name: 'get_datetime_in_timezone',
        argumentFragments: ['{"time_zone":"UTC"}'],
      }),
      sse({ content: '42, and the UTC time is 12:00.', cost: 0.001 }),
    ];
    const fetchMock = vi.fn(async () => response(streams.shift() ?? ''));
    vi.stubGlobal('fetch', fetchMock);
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });

    const result = await openRouter.run(
      {
        model: 'luna',
        reasoning: 'medium',
        messages: [{ role: 'user', content: 'Calculate 6 * 7 and give me the UTC time.' }],
      },
      async () => undefined,
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      ((bodyAt(fetchMock, 1).tools ?? []) as Array<{ type: string }>).map(({ type }) => type),
    ).toEqual([
      'openrouter:datetime',
      'function',
      'function',
      'openrouter:web_search',
      'openrouter:web_fetch',
    ]);
    expect(
      ((bodyAt(fetchMock, 2).tools ?? []) as Array<{ type: string }>).map(({ type }) => type),
    ).toEqual(['openrouter:datetime', 'openrouter:web_search', 'openrouter:web_fetch']);
    expect(result).toMatchObject({
      content: '42, and the UTC time is 12:00.',
      toolActivity: {
        called: ['calculate', 'get_datetime_in_timezone'],
        functionRounds: 2,
      },
      diagnostics: { toolRounds: [expect.any(Object), expect.any(Object)] },
    });
  });

  it('normalizes a missing provider tool-call ID and safely completes the function round', async () => {
    const incompleteCall = [
      `data: ${JSON.stringify({
        id: 'generation',
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  type: 'function',
                  function: { name: 'calculate', arguments: '{"expression":"2 + 2"}' },
                },
              ],
            },
          },
        ],
      })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');
    const streams = [incompleteCall, sse({ content: 'Four.', cost: 0.001 })];
    const fetchMock = vi.fn(async () =>
      response(streams.shift() ?? '', 200, { 'X-Generation-Id': 'gen-tool-normalized' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });

    const result = await openRouter.run(
      { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: '2 + 2?' }] },
      async () => undefined,
    );

    const messages = bodyAt(fetchMock, 1).messages as Array<Record<string, unknown>>;
    const assistant = messages[2] as {
      tool_calls: Array<{ id: string }>;
    };
    const tool = messages[3] as { tool_call_id: string; content: string };
    expect(assistant.tool_calls[0]?.id).toMatch(/^call_jolanda_\d+_0$/u);
    expect(tool.tool_call_id).toBe(assistant.tool_calls[0]?.id);
    expect(JSON.parse(tool.content)).toMatchObject({ ok: true, result: 4 });
    expect(result.content).toBe('Four.');
  });

  it('answers an unoffered tool call and lets the model finish instead of cutting off', async () => {
    // Reproduces the mid-sentence cutoff: the final round no longer offers `calculate`, the
    // model calls it anyway, and the call used to be discarded as if the answer were done.
    const streams = [
      functionToolSse({
        id: 'call_calculate_1',
        name: 'calculate',
        argumentFragments: ['{"expression":"2 + 2"}'],
      }),
      functionToolSse({
        id: 'call_calculate_2',
        name: 'calculate',
        argumentFragments: ['{"expression":"3 + 3"}'],
      }),
      [
        `data: ${JSON.stringify({
          id: 'generation',
          choices: [
            {
              delta: {
                content: 'Chýbajúci výpočet:',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_calculate_3',
                    type: 'function',
                    function: { name: 'calculate', arguments: '{"expression":"4 + 4"}' },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''),
      sse({ content: ' rádovo 8.', cost: 0.001 }),
    ];
    const fetchMock = vi.fn(async () => response(streams.shift() ?? ''));
    vi.stubGlobal('fetch', fetchMock);
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });

    const result = await openRouter.run(
      { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Koľko?' }] },
      async () => undefined,
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(bodyAt(fetchMock, 3)).not.toHaveProperty('tools');
    expect(bodyAt(fetchMock, 3).messages).toContainEqual({
      role: 'tool',
      tool_call_id: 'call_calculate_3',
      name: 'calculate',
      content: '{"ok":false,"error":"tool_unavailable"}',
    });
    expect(result.content).toBe('Chýbajúci výpočet: rádovo 8.');
  });

  it('reports a length-truncated answer instead of presenting it as complete', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(sse({ content: 'Partial', cost: 0.001, finishReason: 'length' }))),
    );
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });

    await expect(
      openRouter.run(
        { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Hi' }] },
        async () => undefined,
      ),
    ).resolves.toMatchObject({ content: 'Partial', truncated: true });
  });

  it('names an exhausted reasoning budget rather than blaming a malformed response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(sse({ content: '', cost: 0.001, finishReason: 'length' }))),
    );
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });

    await expect(
      openRouter.run(
        { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Hi' }] },
        async () => undefined,
      ),
    ).rejects.toMatchObject({
      diagnostic: { category: 'malformed_response', malformedReason: 'reasoning_budget_exhausted' },
    });
  });

  it('retries a malformed stream once while nothing has reached the user', async () => {
    const streams = [
      sse({ content: '', cost: 0.001 }),
      sse({ content: 'Recovered answer.', cost: 0.002 }),
    ];
    const fetchMock = vi.fn(async () => response(streams.shift() ?? ''));
    vi.stubGlobal('fetch', fetchMock);
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });
    const deltas: string[] = [];

    const result = await openRouter.run(
      { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Hi' }] },
      async (delta) => {
        deltas.push(delta);
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(deltas).toEqual(['Recovered answer.']);
    expect(result.content).toBe('Recovered answer.');
  });

  it.each([
    ['Z.AI', 'stop', ['z-ai']],
    ['Z.AI', 'length', undefined],
    ['Other Provider', 'stop', undefined],
  ] as const)(
    'retries %s/%s without globally changing provider routing',
    async (provider, finish, ignored) => {
      const empty = [
        `data: ${JSON.stringify({ id: 'gen-empty', choices: [{ delta: { content: '', reasoning: 'PRIVATE reasoning' }, finish_reason: finish }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [], usage: { cost: 0.00033425, prompt_tokens: 2065, completion_tokens: 49, completion_tokens_details: { reasoning_tokens: 49 } }, openrouter_metadata: { endpoints: { available: [{ provider, selected: true }] } } })}\n\n`,
        'data: [DONE]\n\n',
      ].join('');
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(response(empty))
        .mockImplementation(async () =>
          response(sse({ content: 'Recovered answer.', cost: 0.001 })),
        );
      vi.stubGlobal('fetch', fetchMock);
      const onProgress = vi.fn(async (progress: ModelProgress) => void progress);
      const onDelta = vi.fn(async () => undefined);
      const openRouter = createTestOpenRouter({
        apiKey: 'test-key',
        logger: pino({ enabled: false }),
      });
      const request = {
        model: 'glm-5.3-flash',
        reasoning: 'max',
        messages: [{ role: 'user', content: 'A historical question' }],
      } satisfies Omit<ModelRunRequest, 'clock'>;

      await expect(openRouter.run(request, onDelta, onProgress)).resolves.toMatchObject({
        content: 'Recovered answer.',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(bodyAt(fetchMock, 0).provider).not.toHaveProperty('ignore');
      const second = bodyAt(fetchMock, 1);
      expect(second.model).toBe('z-ai/glm-5.3-flash');
      expect(second.provider).toMatchObject({
        data_collection: 'deny',
        zdr: true,
        require_parameters: true,
      });
      if (ignored) expect(second.provider).toHaveProperty('ignore', [...ignored]);
      else expect(second.provider).not.toHaveProperty('ignore');
      expect(onDelta).toHaveBeenCalledOnce();
      expect(JSON.stringify(onProgress.mock.calls)).not.toContain('PRIVATE');
      if (finish === 'stop')
        expect(onProgress).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'retry',
            reason: 'The provider finished without returning any answer text',
          }),
        );

      await openRouter.run(request, async () => undefined);
      expect(bodyAt(fetchMock, 2).provider).not.toHaveProperty('ignore');
    },
  );

  it.each([502, 503, 429])(
    'recovers from four %i failures on the fifth attempt',
    async (status) => {
      const fetchMock = vi
        .fn()
        .mockImplementation(async () =>
          response(JSON.stringify({ error: { code: status } }), status),
        );
      for (let attempt = 0; attempt < 4; attempt += 1)
        fetchMock.mockImplementationOnce(async () =>
          response(
            JSON.stringify({ error: { code: status, message: 'private upstream response' } }),
            status,
          ),
        );
      fetchMock.mockImplementationOnce(async () =>
        response(sse({ content: 'Recovered.', cost: 0.001 })),
      );
      vi.stubGlobal('fetch', fetchMock);
      const waitForRetry = vi.fn(async () => undefined);
      const onProgress = vi.fn(async (progress: ModelProgress) => void progress);
      const onDelta = vi.fn(async () => undefined);
      const result = await createTestOpenRouter({
        apiKey: 'test-key',
        logger: pino({ enabled: false }),
        waitForRetry,
      }).run(
        {
          model: 'glm-5.3-flash',
          reasoning: 'max',
          messages: [{ role: 'user', content: 'Hello?' }],
        },
        onDelta,
        onProgress,
      );
      expect(result.content).toBe('Recovered.');
      expect(result.usage?.costMicrodollars).toBe(1_000);
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(waitForRetry.mock.calls).toEqual([
        [1_000, undefined],
        [2_000, undefined],
        [4_000, undefined],
        [8_000, undefined],
      ]);
      const retries = onProgress.mock.calls
        .map(([progress]) => progress)
        .filter((progress) => progress.type === 'retry');
      expect(retries).toEqual(
        [2, 3, 4, 5].map((attempt) =>
          expect.objectContaining({
            type: 'retry',
            attempt,
            maximumAttempts: 5,
            reason: expect.stringContaining(String(status)),
          }),
        ),
      );
      expect(JSON.stringify(retries)).not.toContain('private upstream response');
      expect(onDelta).toHaveBeenCalledOnce();
      for (let attempt = 0; attempt < 5; attempt += 1)
        expect(bodyAt(fetchMock, attempt).provider).toMatchObject({
          data_collection: 'deny',
          zdr: true,
          require_parameters: true,
        });
    },
  );

  it.each([400, 401, 402, 403])('does not retry permanent HTTP %i failures', async (status) => {
    const fetchMock = vi.fn(async () =>
      response(JSON.stringify({ error: { code: status } }), status),
    );
    vi.stubGlobal('fetch', fetchMock);
    const waitForRetry = vi.fn(async () => undefined);
    await expect(
      createTestOpenRouter({
        apiKey: 'test-key',
        logger: pino({ enabled: false }),
        waitForRetry,
      }).run(
        { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Hello?' }] },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(ModelFailure);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(waitForRetry).not.toHaveBeenCalled();
  });

  it('waits before retrying and cancels promptly during the backoff', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => response(JSON.stringify({ error: { code: 502 } }), 502));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const onProgress = vi.fn(async (progress: ModelProgress) => void progress);
    const pending = createOpenRouterAdapter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    })
      .run(
        {
          model: 'luna',
          reasoning: 'medium',
          messages: [{ role: 'user', content: 'Hello?' }],
          clock,
          signal: controller.signal,
        },
        async () => undefined,
        onProgress,
      )
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ type: 'retry', attempt: 2 }));
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ diagnostic: { category: 'cancelled' } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry once partial text is already on screen', async () => {
    const streams = [
      [
        `data: ${JSON.stringify({ id: 'generation', choices: [{ delta: { content: 'Half' } }] })}\n\n`,
        `data: ${JSON.stringify({ error: { code: 'upstream_error' } })}\n\n`,
      ].join(''),
      sse({ content: 'Never used.', cost: 0.001 }),
    ];
    const fetchMock = vi.fn(async () => response(streams.shift() ?? ''));
    vi.stubGlobal('fetch', fetchMock);
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });

    await expect(
      openRouter.run(
        { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Hi' }] },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(ModelFailure);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores surfaced server-tool deltas while retaining final text and bounded diagnostics', async () => {
    const stream = [
      `data: ${JSON.stringify({
        id: 'generation',
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'server-search',
                  type: 'openrouter:web_search',
                  function: { name: 'web_search', arguments: '{"query":"Stupava events"}' },
                },
              ],
            },
          },
        ],
      })}\n\n`,
      sse({ content: 'Grounded answer.', cost: 0.001, finishReason: 'stop' }),
    ].join('');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(stream)),
    );
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });

    const result = await openRouter.run(
      {
        model: 'luna',
        reasoning: 'medium',
        messages: [{ role: 'user', content: 'What is happening next month?' }],
      },
      async () => undefined,
    );

    expect(result).toMatchObject({
      content: 'Grounded answer.',
      diagnostics: {
        answer: { finishReason: 'stop', ignoredToolCallDeltas: 1 },
      },
    });
  });

  it('does not expose provider error bodies or messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(
          JSON.stringify({
            error: {
              code: 'upstream_error',
              message: 'secret provider body and private prompt',
              metadata: { provider_name: 'Example Provider' },
            },
            openrouter_metadata: { strategy: 'fallback', attempt: 2 },
          }),
          500,
          { 'X-Generation-Id': 'gen-safe-123' },
        ),
      ),
    );
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });

    const error = await openRouter
      .run(
        { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Ahoj' }] },
        async () => undefined,
      )
      .catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(ModelFailure);
    expect(error).toMatchObject({
      diagnostic: {
        category: 'provider_failure',
        stage: 'answer',
        status: 500,
        code: 'upstream_error',
        generationId: 'gen-safe-123',
        provider: 'Example Provider',
        routingStrategy: 'fallback',
        attempt: 2,
      },
    });
    expect(JSON.stringify(error)).not.toContain('secret provider body');
    expect(JSON.stringify(error)).not.toContain('private prompt');
  });

  it.each([
    [408, 'timeout'],
    [429, 'rate_limited'],
    [401, 'authentication'],
    [402, 'payment_required'],
    [400, 'request_rejected'],
    [404, 'provider_unavailable'],
    [502, 'provider_failure'],
    [503, 'provider_unavailable'],
    [418, 'unknown'],
  ] as const)('classifies a bounded HTTP %i response as %s', async (status, category) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(JSON.stringify({ error: {} }), status)),
    );
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });

    await expect(
      openRouter.run(
        { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Hello?' }] },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ diagnostic: { category, stage: 'answer', status } });
  });

  it('reports repeated in-stream 502s on an image turn as upstream failures', async () => {
    const fetchMock = vi.fn(async () =>
      response(
        `data: ${JSON.stringify({ id: 'gen-image', choices: [] })}\n\n` +
          `data: ${JSON.stringify({
            error: { code: 502, message: 'private upstream response' },
            openrouter_metadata: { strategy: 'direct', attempt: 1 },
          })}\n\n`,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });
    const onDelta = vi.fn(async () => undefined);
    const error = await openRouter
      .run(
        {
          model: 'glm-5.3-flash',
          reasoning: 'max',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Describe this image.' },
                { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,PRIVATE' } },
              ],
            },
          ],
        },
        onDelta,
      )
      .catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      diagnostic: {
        category: 'provider_failure',
        stage: 'answer',
        code: 502,
        generationId: 'gen-image',
        routingStrategy: 'direct',
        attempt: 1,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(openRouterMaximumAttempts);
    expect(onDelta).not.toHaveBeenCalled();
    expect(JSON.stringify(error)).not.toContain('private upstream response');
    expect(JSON.stringify(error)).not.toContain('PRIVATE');
  });

  it('bounds non-streaming provider error bodies before classification', async () => {
    const oversized = JSON.stringify({
      error: {
        code: 'upstream_error',
        message: `private prompt${'x'.repeat(maximumProviderErrorBytes)}`,
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(oversized, 503)),
    );
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });

    const error = await openRouter
      .run(
        { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Ahoj' }] },
        async () => undefined,
      )
      .catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      diagnostic: { category: 'provider_unavailable', stage: 'answer', status: 503 },
    });
    expect(JSON.stringify(error)).not.toContain('private prompt');
  });

  it('classifies an empty answer stream as a malformed response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response('data: [DONE]\n\n', 200, { 'X-Generation-Id': 'gen-empty' })),
    );
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });

    const error = await openRouter
      .run(
        { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Ahoj' }] },
        async () => undefined,
      )
      .catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(ModelFailure);
    expect(error).toMatchObject({
      diagnostic: {
        category: 'malformed_response',
        stage: 'answer',
        generationId: 'gen-empty',
        malformedReason: 'empty_answer',
      },
    });
  });

  it('distinguishes an unsupported event shape from an ordinary empty answer', async () => {
    const stream = [
      'data: {"id":"generation","choices":"not-an-array"}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(stream)),
    );
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });

    await expect(
      openRouter.run(
        { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Ahoj' }] },
        async () => undefined,
      ),
    ).rejects.toMatchObject({
      diagnostic: {
        category: 'malformed_response',
        malformedReason: 'unsupported_event_shape',
        ignoredSseEvents: 1,
      },
    });
  });

  it('rejects oversized local function arguments with a bounded reason code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(
          functionToolSse({
            id: 'call_oversized',
            name: 'calculate',
            argumentFragments: ['x'.repeat(4_001)],
          }),
        ),
      ),
    );
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });

    await expect(
      openRouter.run(
        { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Ahoj' }] },
        async () => undefined,
      ),
    ).rejects.toMatchObject({
      diagnostic: {
        category: 'malformed_response',
        malformedReason: 'invalid_function_tool_call',
      },
    });
  });

  it('fails closed on streamed provider errors without exposing their message', async () => {
    const body = `data: ${JSON.stringify({
      error: { code: 'upstream_error', message: 'private provider detail' },
    })}\n\n`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(body)),
    );
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });

    const error = await openRouter
      .run(
        { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Ahoj' }] },
        async () => undefined,
      )
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ModelFailure);
    expect(error).toMatchObject({
      diagnostic: { category: 'provider_failure', stage: 'answer', code: 'upstream_error' },
    });
    expect(JSON.stringify(error)).not.toContain('private provider detail');
  });

  it('ignores unknown JSON events and supports input/output usage aliases', async () => {
    const stream = [
      'data: {"unknown":true}\n\n',
      'data: {"id":"generation","choices":[{"delta":{"content":"Alias"}}]}\n\n',
      'data: {"id":"generation","choices":[],"usage":{"cost":0.001,"input_tokens":7,"output_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(stream)),
    );
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });

    const result = await openRouter.run(
      { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Ahoj' }] },
      async () => undefined,
    );

    expect(result).toMatchObject({
      content: 'Alias',
      usage: { promptTokens: 7, completionTokens: 3, costMicrodollars: 1_000 },
    });
  });

  it.each(['{"usage":', 'not-json'])(
    'invalidates earlier usage when a trailing SSE frame is malformed JSON: %s',
    async (malformedFrame) => {
      const stream = [
        'data: {"id":"generation","choices":[{"delta":{"content":"Answer"}}]}\n\n',
        'data: {"id":"generation","choices":[],"usage":{"cost":0,"prompt_tokens":1}}\n\n',
        `data: ${malformedFrame}\n\n`,
        'data: [DONE]\n\n',
      ].join('');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => response(stream)),
      );
      const openRouter = createTestOpenRouter({
        apiKey: 'test-key',
        logger: pino({ enabled: false }),
      });

      const result = await openRouter.run(
        { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Ahoj' }] },
        async () => undefined,
      );

      expect(result.content).toBe('Answer');
      expect(result.usage).toBeUndefined();
      expect(result.diagnostics).toMatchObject({ answer: { ignoredSseFrames: 1 } });
    },
  );

  it('uses the output-token parameter supported by DeepSeek', async () => {
    const fetchMock = vi.fn(async () => response(sse({ content: 'Answer', cost: 0.001 })));
    vi.stubGlobal('fetch', fetchMock);
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });

    await openRouter.run(
      {
        model: 'deepseek-v4-flash',
        reasoning: 'high',
        messages: [{ role: 'user', content: 'Ahoj' }],
      },
      async () => undefined,
    );

    expect(bodyAt(fetchMock, 0)).toMatchObject({
      model: 'deepseek/deepseek-v4-flash-0731',
      max_tokens: 49_152,
    });
    expect(bodyAt(fetchMock, 0)).not.toHaveProperty('max_completion_tokens');
  });

  it('treats usage without a finite reported cost as missing', async () => {
    const stream = [
      'data: {"id":"generation","choices":[{"delta":{"content":"Answer"}}]}\n\n',
      'data: {"id":"generation","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(stream)),
    );
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });

    const result = await openRouter.run(
      { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Ahoj' }] },
      async () => undefined,
    );

    expect(result.content).toBe('Answer');
    expect(result.usage).toBeUndefined();
  });

  it('treats a cost whose microdollar conversion overflows as missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(sse({ content: 'Answer', cost: 1e308 }))),
    );
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });

    const result = await openRouter.run(
      { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Ahoj' }] },
      async () => undefined,
    );

    expect(result.content).toBe('Answer');
    expect(result.usage).toBeUndefined();
  });

  it.each([{ prompt_tokens: 999 }, { cost: 'wrong-type' }, { cost: 1e308 }])(
    'invalidates earlier usage when a trailing non-null usage event is malformed: %j',
    async (trailingUsage) => {
      const stream = [
        'data: {"id":"generation","choices":[{"delta":{"content":"Answer"}}]}\n\n',
        'data: {"id":"generation","choices":[],"usage":{"cost":0,"prompt_tokens":1}}\n\n',
        `data: ${JSON.stringify({ id: 'generation', choices: [], usage: trailingUsage })}\n\n`,
        'data: [DONE]\n\n',
      ].join('');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => response(stream)),
      );
      const openRouter = createTestOpenRouter({
        apiKey: 'test-key',
        logger: pino({ enabled: false }),
      });

      const result = await openRouter.run(
        { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Ahoj' }] },
        async () => undefined,
      );

      expect(result.content).toBe('Answer');
      expect(result.usage).toBeUndefined();
    },
  );

  it('does not treat an ordinary null usage field as malformed', async () => {
    const stream = [
      'data: {"id":"generation","choices":[{"delta":{"content":"Answer"}}]}\n\n',
      'data: {"id":"generation","choices":[],"usage":{"cost":0.001}}\n\n',
      'data: {"id":"generation","choices":[],"usage":null}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(stream)),
    );
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });

    const result = await openRouter.run(
      { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Ahoj' }] },
      async () => undefined,
    );

    expect(result.usage?.costMicrodollars).toBe(1_000);
  });

  it('propagates caller aborts to an in-flight provider request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url, init) =>
          new Promise<Response>((_, reject) => {
            if (init?.signal?.aborted) {
              reject(init.signal.reason);
              return;
            }
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      ),
    );
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });
    const controller = new AbortController();
    const request = openRouter.run(
      {
        model: 'luna',
        reasoning: 'medium',
        messages: [{ role: 'user', content: 'Ahoj' }],
        signal: controller.signal,
      },
      async () => undefined,
    );

    controller.abort(new Error('test abort'));

    await expect(request).rejects.toMatchObject({
      diagnostic: { category: 'cancelled', stage: 'answer' },
    });
  });

  it('classifies an inference deadline before response headers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url, init) =>
          new Promise<Response>((_, reject) => {
            if (init?.signal?.aborted) {
              reject(init.signal.reason);
              return;
            }
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      ),
    );
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });
    const controller = new AbortController();
    const request = openRouter.run(
      {
        model: 'luna',
        reasoning: 'medium',
        messages: [{ role: 'user', content: 'Ahoj' }],
        signal: controller.signal,
      },
      async () => undefined,
    );

    controller.abort(new DOMException('deadline', 'TimeoutError'));

    await expect(request).rejects.toMatchObject({
      diagnostic: {
        category: 'timeout',
        stage: 'answer',
        timeoutPoint: 'before_headers',
      },
    });
  });

  it('allows ten minutes for the response stream to start', async () => {
    vi.useFakeTimers();
    let providerSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url, init) =>
          new Promise<Response>((_, reject) => {
            providerSignal = init?.signal ?? undefined;
            if (providerSignal?.aborted) {
              reject(providerSignal.reason);
              return;
            }
            providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason), {
              once: true,
            });
          }),
      ),
    );
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });
    const result = openRouter
      .run(
        { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Ahoj' }] },
        async () => undefined,
      )
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(openRouterStreamStartTimeoutMs - 1);
    expect(providerSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(
      openRouterStreamStartTimeoutMs * (openRouterMaximumAttempts - 1),
    );
    await expect(result).resolves.toMatchObject({
      diagnostic: {
        category: 'timeout',
        stage: 'answer',
        timeoutPoint: 'before_headers',
        elapsedMs: openRouterStreamStartTimeoutMs,
      },
    });
  });

  it('disables its deadline after the first non-empty stream chunk', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let finishStream: () => void = () => undefined;
    let providerSignal: AbortSignal | undefined;
    let acknowledgeDelta: () => void = () => undefined;
    const receivedDelta = new Promise<void>((resolve) => {
      acknowledgeDelta = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"id":"generation","choices":[{"delta":{"content":"Answer"}}]}\n\n',
          ),
        );
        finishStream = () => {
          controller.enqueue(
            encoder.encode(
              'data: {"id":"generation","choices":[],"usage":{"cost":0.001}}\n\ndata: [DONE]\n\n',
            ),
          );
          controller.close();
        };
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        providerSignal = init?.signal ?? undefined;
        return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
      }),
    );
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });
    const result = openRouter.run(
      { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Ahoj' }] },
      async () => acknowledgeDelta(),
    );
    await receivedDelta;

    await vi.advanceTimersByTimeAsync(openRouterStreamStartTimeoutMs * 2);
    expect(providerSignal?.aborted).toBe(false);

    finishStream();
    await expect(result).resolves.toMatchObject({ content: 'Answer' });
  });

  it('caps accumulated output independently of provider token behavior', async () => {
    const frames = Array.from(
      { length: Math.ceil(maximumResponseCharacters / 1_000) + 2 },
      () => `data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(1_000) } }] })}\n\n`,
    ).join('');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(`${frames}data: [DONE]\n\n`)),
    );
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });
    const deltas: string[] = [];

    const result = await openRouter.run(
      { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Ahoj' }] },
      async (delta) => {
        deltas.push(delta);
      },
    );

    expect(result.content.length).toBe(maximumResponseCharacters);
    expect(deltas.join('').length).toBe(maximumResponseCharacters);
  });

  it('rejects oversized SSE frames', async () => {
    const oversized = `data: ${'x'.repeat(maximumSseFrameCharacters)}\n\n`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(oversized)),
    );
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });

    await expect(
      openRouter.run(
        { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Ahoj' }] },
        async () => undefined,
      ),
    ).rejects.toMatchObject({
      diagnostic: { category: 'malformed_response', stage: 'answer' },
    });
  });

  it('rejects oversized raw SSE read batches before materializing all frames', async () => {
    const manyFrames = `data: {}\n\n`.repeat(Math.ceil(maximumSseReadBytes / 10) + 1);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(manyFrames)),
    );
    const openRouter = createTestOpenRouter({
      apiKey: 'test-key',
      logger: pino({ enabled: false }),
    });

    await expect(
      openRouter.run(
        { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Ahoj' }] },
        async () => undefined,
      ),
    ).rejects.toMatchObject({
      diagnostic: { category: 'malformed_response', stage: 'answer' },
    });
  });
});

describe('reminder draft collection', () => {
  it('returns normalized drafts without any persistence inside the toolbox', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          functionToolSse({
            id: 'reminder-call',
            name: 'create_reminder',
            argumentFragments: [
              JSON.stringify({ instant: '2026-08-26T07:00:00Z', text: ' Invoice ' }),
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(response(sse({ content: 'Tomorrow at nine.', cost: 0.001 })));
    vi.stubGlobal('fetch', fetch);
    const runner = createTestOpenRouter({ apiKey: 'test', logger: pino({ enabled: false }) });
    const result = await runner.run(
      {
        model: 'luna',
        reasoning: 'medium',
        allowReminders: true,
        messages: [{ role: 'user', content: 'Remind me tomorrow at nine.' }],
      },
      async () => {},
    );
    expect(result.reminderDrafts).toEqual([
      { instant: '2026-08-26T07:00:00.000Z', text: 'Invoice' },
    ]);
    expect(result.toolActivity?.called).toContain('create_reminder');
  });
});
