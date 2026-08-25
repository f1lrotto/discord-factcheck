import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  maximumResponseCharacters,
  maximumResearchEvidenceCharacters,
  maximumSourceUrlCharacters,
  maximumSseFrameCharacters,
  maximumSseReadBytes,
} from '../src/limits.js';
import { createOpenRouter, extractSseFrames } from '../src/openrouter.js';

const sse = (input: {
  content: string;
  cost: number;
  promptTokens?: number;
  completionTokens?: number;
  webSearchRequests?: number;
  citationUrls?: string[];
}) =>
  [
    `data: ${JSON.stringify({
      id: 'generation',
      choices: [
        {
          delta: {
            content: input.content,
            ...(input.citationUrls
              ? {
                  annotations: input.citationUrls.map((url) => ({
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

const response = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });

const bodyAt = (fetchMock: ReturnType<typeof vi.fn>, index: number) => {
  const request = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  if (!request) throw new Error(`OpenRouter request ${index} was not captured`);
  return JSON.parse(String(request.body)) as Record<string, unknown>;
};

afterEach(() => vi.unstubAllGlobals());

describe('extractSseFrames', () => {
  it('handles complete frames and preserves an incomplete tail', () => {
    const result = extractSseFrames('data: one\r\n\r\ndata: two\n\ndata: partial');

    expect(result.frames).toEqual(['data: one', 'data: two']);
    expect(result.remainder).toBe('data: partial');
  });
});

describe('OpenRouter adapter', () => {
  it('isolates public research from private final context and combines exact usage', async () => {
    const streams = [
      sse({
        content:
          'Verejné poznámky [Zdroj](https://example.com) a vymyslený https://attacker.example',
        cost: 0.001,
        webSearchRequests: 1,
        citationUrls: ['https://example.com'],
      }),
      sse({ content: 'Odpoveď', cost: 0.002, promptTokens: 20, completionTokens: 8 }),
    ];
    const fetchMock = vi.fn(async () => response(streams.shift() ?? ''));
    vi.stubGlobal('fetch', fetchMock);
    const openRouter = createOpenRouter({
      apiKey: 'test-key',
      enforceZdr: true,
      logger: pino({ enabled: false }),
    });
    const deltas: string[] = [];

    const result = await openRouter.run(
      {
        model: 'luna',
        reasoning: 'medium',
        publicQuestion: 'Čo je dnes nové?',
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'private replied text and Discord history' },
        ],
      },
      async (delta) => {
        deltas.push(delta);
      },
    );
    const researchBody = bodyAt(fetchMock, 0);
    const finalBody = bodyAt(fetchMock, 1);

    expect(JSON.stringify(researchBody)).toContain('Čo je dnes nové?');
    expect(JSON.stringify(researchBody)).not.toContain('private replied text');
    expect(researchBody).toMatchObject({
      model: 'openai/gpt-5.6-luna',
      max_tokens: 2_048,
      max_tool_calls: 1,
      tools: [
        {
          type: 'openrouter:web_search',
          parameters: { max_uses: 1, max_total_results: 3, max_characters: 1_500 },
        },
      ],
    });
    expect(researchBody).not.toHaveProperty('max_completion_tokens');
    expect(finalBody).toMatchObject({ max_tokens: 4_096 });
    expect(finalBody).not.toHaveProperty('tools');
    expect(JSON.stringify(finalBody)).toContain('private replied text');
    expect(JSON.stringify(finalBody)).toContain('Verejné poznámky');
    expect(finalBody.provider).toMatchObject({
      zdr: true,
      data_collection: 'deny',
      max_price: { prompt: 0.5, completion: 2 },
    });
    expect(deltas).toEqual(['Odpoveď']);
    expect(result).toMatchObject({
      content: 'Odpoveď',
      allowedSourceUrls: ['https://example.com/'],
      usage: {
        costMicrodollars: 3_000,
        promptTokens: 30,
        completionTokens: 13,
        reasoningTokens: 4,
        webSearchRequests: 1,
      },
    });
  });

  it('runs final inference without exposing a web tool when research is disabled', async () => {
    const fetchMock = vi.fn(async () => response(sse({ content: 'Safe', cost: 0.001 })));
    vi.stubGlobal('fetch', fetchMock);
    const openRouter = createOpenRouter({
      apiKey: 'test-key',
      enforceZdr: true,
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
    expect(bodyAt(fetchMock, 0)).not.toHaveProperty('tools');
  });

  it('does not expose provider error bodies or messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response('secret provider body', 500)),
    );
    const openRouter = createOpenRouter({
      apiKey: 'test-key',
      enforceZdr: true,
      logger: pino({ enabled: false }),
    });

    await expect(
      openRouter.run(
        { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Ahoj' }] },
        async () => undefined,
      ),
    ).rejects.toThrow('status 500');
  });

  it('fails closed on streamed provider errors without exposing their message', async () => {
    const body = `data: ${JSON.stringify({
      error: { code: 'upstream_error', message: 'private provider detail' },
    })}\n\n`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(body)),
    );
    const openRouter = createOpenRouter({
      apiKey: 'test-key',
      enforceZdr: true,
      logger: pino({ enabled: false }),
    });

    const request = openRouter.run(
      { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Ahoj' }] },
      async () => undefined,
    );
    await expect(request).rejects.toThrow('OpenRouter stream failed (upstream_error)');
    await expect(request).rejects.not.toThrow('private provider detail');
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
    const openRouter = createOpenRouter({
      apiKey: 'test-key',
      enforceZdr: true,
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
      const openRouter = createOpenRouter({
        apiKey: 'test-key',
        enforceZdr: true,
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

  it('uses the output-token parameter supported by DeepSeek', async () => {
    const fetchMock = vi.fn(async () => response(sse({ content: 'Answer', cost: 0.001 })));
    vi.stubGlobal('fetch', fetchMock);
    const openRouter = createOpenRouter({
      apiKey: 'test-key',
      enforceZdr: true,
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
      max_tokens: 6_144,
    });
    expect(bodyAt(fetchMock, 0)).not.toHaveProperty('max_completion_tokens');
  });

  it('omits unused research and marks combined usage missing when one stage lacks it', async () => {
    const researchWithoutUsage = [
      'data: {"id":"research","choices":[{"delta":{"content":"NO_RESEARCH"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(researchWithoutUsage))
      .mockResolvedValueOnce(response(sse({ content: 'Final', cost: 0.001 })));
    vi.stubGlobal('fetch', fetchMock);
    const openRouter = createOpenRouter({
      apiKey: 'test-key',
      enforceZdr: true,
      logger: pino({ enabled: false }),
    });

    const result = await openRouter.run(
      {
        model: 'luna',
        reasoning: 'medium',
        publicQuestion: 'What is two plus two?',
        messages: [{ role: 'user', content: 'private final context' }],
      },
      async () => undefined,
    );

    expect(result.usage).toBeUndefined();
    expect(JSON.stringify(bodyAt(fetchMock, 1))).not.toContain('NO_RESEARCH');
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
    const openRouter = createOpenRouter({
      apiKey: 'test-key',
      enforceZdr: true,
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
    const openRouter = createOpenRouter({
      apiKey: 'test-key',
      enforceZdr: true,
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
      const openRouter = createOpenRouter({
        apiKey: 'test-key',
        enforceZdr: true,
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
    const openRouter = createOpenRouter({
      apiKey: 'test-key',
      enforceZdr: true,
      logger: pino({ enabled: false }),
    });

    const result = await openRouter.run(
      { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Ahoj' }] },
      async () => undefined,
    );

    expect(result.usage?.costMicrodollars).toBe(1_000);
  });

  it('uses one overall abort signal across research and final inference', async () => {
    const signals: AbortSignal[] = [];
    const streams = [
      sse({
        content: 'Research https://example.com/source',
        cost: 0.001,
        webSearchRequests: 1,
        citationUrls: ['https://example.com/source'],
      }),
      sse({ content: 'Answer', cost: 0.001 }),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        if (init?.signal) signals.push(init.signal);
        return response(streams.shift() ?? '');
      }),
    );
    const openRouter = createOpenRouter({
      apiKey: 'test-key',
      enforceZdr: true,
      logger: pino({ enabled: false }),
    });

    const result = await openRouter.run(
      {
        model: 'luna',
        reasoning: 'medium',
        publicQuestion: 'What is new?',
        messages: [{ role: 'user', content: 'private context' }],
      },
      async () => undefined,
    );

    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    expect(result.allowedSourceUrls).toEqual(['https://example.com/source']);
  });

  it('trusts only valid public provider citation annotations, never research prose', async () => {
    const research = [
      `data: ${JSON.stringify({
        id: 'research',
        choices: [
          {
            delta: {
              content: 'Invented https://attacker.example and annotated https://example.com/source',
              annotations: [
                {
                  type: 'url_citation',
                  url_citation: { url: 'https://example.com/source?tracking=1' },
                },
                { type: 'url_citation', url_citation: { url: 'http://127.0.0.1/private' } },
                { type: 'other', url_citation: { url: 'https://ignored.example' } },
                { type: 'url_citation', url_citation: { url: 42 } },
              ],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [],
        usage: {
          cost: 0.001,
          server_tool_use: { web_search_requests: 1 },
        },
      })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(research))
      .mockResolvedValueOnce(response(sse({ content: 'Final', cost: 0.001 })));
    vi.stubGlobal('fetch', fetchMock);
    const openRouter = createOpenRouter({
      apiKey: 'test-key',
      enforceZdr: true,
      logger: pino({ enabled: false }),
    });

    const result = await openRouter.run(
      {
        model: 'luna',
        reasoning: 'medium',
        publicQuestion: 'What is new?',
        messages: [{ role: 'user', content: 'private context' }],
      },
      async () => undefined,
    );

    expect(result.allowedSourceUrls).toEqual(['https://example.com/source']);
    expect(result.allowedSourceUrls).not.toContain('https://attacker.example/');
  });

  it('bounds worst-case serialized research evidence and citation URLs', async () => {
    const citationUrls = Array.from(
      { length: 4 },
      (_, index) => `https://example.com/${index}/${'a'.repeat(maximumSourceUrlCharacters - 100)}`,
    );
    const streams = [
      sse({
        content: '\\"'.repeat(maximumResponseCharacters),
        cost: 0.001,
        webSearchRequests: 1,
        citationUrls,
      }),
      sse({ content: 'Final', cost: 0.001 }),
    ];
    const fetchMock = vi.fn(async () => response(streams.shift() ?? ''));
    vi.stubGlobal('fetch', fetchMock);
    const openRouter = createOpenRouter({
      apiKey: 'test-key',
      enforceZdr: true,
      logger: pino({ enabled: false }),
    });

    const result = await openRouter.run(
      {
        model: 'luna',
        reasoning: 'medium',
        publicQuestion: 'What is new?',
        messages: [{ role: 'user', content: 'private context' }],
      },
      async () => undefined,
    );
    const finalMessages = bodyAt(fetchMock, 1).messages as Array<{ content: string }>;
    const evidence = finalMessages.find(({ content }) => content.includes('public_web_research'));

    expect(evidence?.content.length).toBeLessThanOrEqual(maximumResearchEvidenceCharacters);
    expect(result.allowedSourceUrls).toHaveLength(3);
    expect(result.allowedSourceUrls?.every((url) => url.length <= maximumSourceUrlCharacters)).toBe(
      true,
    );
  });

  it('propagates caller aborts to an in-flight provider request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url, init) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      ),
    );
    const openRouter = createOpenRouter({
      apiKey: 'test-key',
      enforceZdr: true,
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

    await expect(request).rejects.toThrow('test abort');
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
    const openRouter = createOpenRouter({
      apiKey: 'test-key',
      enforceZdr: true,
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
    const openRouter = createOpenRouter({
      apiKey: 'test-key',
      enforceZdr: true,
      logger: pino({ enabled: false }),
    });

    await expect(
      openRouter.run(
        { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Ahoj' }] },
        async () => undefined,
      ),
    ).rejects.toThrow('SSE frame exceeded');
  });

  it('rejects oversized raw SSE read batches before materializing all frames', async () => {
    const manyFrames = `data: {}\n\n`.repeat(Math.ceil(maximumSseReadBytes / 10) + 1);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(manyFrames)),
    );
    const openRouter = createOpenRouter({
      apiKey: 'test-key',
      enforceZdr: true,
      logger: pino({ enabled: false }),
    });

    await expect(
      openRouter.run(
        { model: 'luna', reasoning: 'medium', messages: [{ role: 'user', content: 'Ahoj' }] },
        async () => undefined,
      ),
    ).rejects.toThrow('SSE read exceeded');
  });
});
