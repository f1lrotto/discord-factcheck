import type { Logger } from 'pino';
import { z } from 'zod';
import { createAssistantToolbox, type AssistantToolDefinition } from './assistant-tools.js';
import { addSourceCitation, createSourceCitation, type SourceCitation } from './citations.js';
import { usdToMicrodollars } from './config.js';
import {
  maximumCitationAnnotations,
  maximumFunctionToolCallsPerRound,
  maximumFunctionToolRounds,
  maximumResponseCharacters,
  maximumReasoningSummaryCharacters,
  maximumProviderErrorBytes,
  maximumSourceUrlCharacters,
  maximumSseFrameCharacters,
  maximumSseReadBytes,
  maximumToolArgumentCharacters,
  maximumToolCallsPerRequest,
  openRouterStreamStartTimeoutMs,
  openRouterMaximumAttempts,
  openRouterRetryBaseDelayMs,
} from './limits.js';
import {
  ModelFailure,
  modelRetryReason,
  type ModelFailureCategory,
  type ModelFailureDiagnostic,
  type ModelMalformedReason,
  type ModelFailureStage,
  type ModelTimeoutPoint,
} from './model-failure.js';
import { completionTokenBudget, getModel } from './models.js';
import type {
  ChatMessage,
  FunctionToolCall,
  ModelProgress,
  ModelRunRequest,
  ModelRunner,
  ModelStageDiagnostics,
  Usage,
} from './types.js';

const usageSchema = z
  .object({
    cost: z.number().finite().nonnegative(),
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    completion_tokens_details: z
      .object({ reasoning_tokens: z.number().int().nonnegative().optional() })
      .nullish(),
    server_tool_use: z
      .object({ web_search_requests: z.number().int().nonnegative().optional() })
      .nullish(),
  })
  .passthrough();

const citationAnnotationSchema = z
  .object({
    type: z.literal('url_citation'),
    url_citation: z
      .object({
        url: z.string().min(1),
        title: z.unknown().optional(),
        start_index: z.unknown().optional(),
        end_index: z.unknown().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const reasoningSummarySchema = z
  .object({
    type: z.literal('reasoning.summary'),
    summary: z.string(),
  })
  .passthrough();

const functionToolCallDeltaSchema = z
  .object({
    index: z.number().int().nonnegative().optional(),
    id: z.string().optional(),
    type: z.string().max(64).optional(),
    function: z
      .object({ name: z.string().optional(), arguments: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const streamChunkSchema = z
  .object({
    id: z.string().optional(),
    choices: z
      .array(
        z
          .object({
            finish_reason: z.string().max(64).nullish(),
            delta: z
              .object({
                content: z.string().nullish(),
                annotations: z.array(z.unknown()).optional(),
                reasoning_details: z.array(z.unknown()).optional(),
                tool_calls: z.array(z.unknown()).optional(),
              })
              .passthrough()
              .optional()
              .default({}),
            message: z
              .object({ annotations: z.array(z.unknown()).optional() })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .optional()
      .default([]),
    usage: usageSchema.nullish(),
    openrouter_metadata: z.unknown().optional(),
  })
  .passthrough();

const errorChunkSchema = z.object({
  error: z.object({
    message: z.string().optional(),
    code: z.union([z.string(), z.number()]).optional(),
    metadata: z.object({ provider_name: z.unknown().optional() }).passthrough().optional(),
  }),
  openrouter_metadata: z.unknown().optional(),
});

const routerMetadataSchema = z
  .object({
    strategy: z.unknown().optional(),
    attempt: z.unknown().optional(),
    attempts: z
      .array(
        z
          .object({ provider: z.unknown().optional(), provider_name: z.unknown().optional() })
          .passthrough(),
      )
      .optional(),
    endpoints: z
      .object({
        available: z
          .array(z.object({ provider: z.unknown().optional(), selected: z.unknown().optional() }))
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

type RouterDiagnostic = {
  provider?: string;
  routingStrategy?: string;
  attempt?: number;
};

const safeIdentifier = (value: unknown, maximum = 128) =>
  typeof value === 'string' && value.length <= maximum && /^[A-Za-z0-9_. -]+$/u.test(value)
    ? value
    : undefined;

const safeGenerationId = (value: unknown) =>
  typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9_-]+$/u.test(value)
    ? value
    : undefined;

const safeToolCallId = (value: unknown) =>
  typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9_-]+$/u.test(value)
    ? value
    : undefined;

const safeErrorCode = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return typeof value === 'string' && value.length <= 64 && /^[A-Za-z0-9_.-]+$/u.test(value)
    ? value
    : undefined;
};

const routerDiagnostic = (value: unknown): RouterDiagnostic => {
  const parsed = routerMetadataSchema.safeParse(value);
  if (!parsed.success) return {};
  const lastAttempt = parsed.data.attempts?.at(-1);
  const selectedEndpoint = parsed.data.endpoints?.available?.find(
    (endpoint) => endpoint.selected === true,
  );
  const provider = safeIdentifier(
    lastAttempt?.provider ?? lastAttempt?.provider_name ?? selectedEndpoint?.provider,
    80,
  );
  const routingStrategy = safeIdentifier(parsed.data.strategy, 40);
  const attempt =
    typeof parsed.data.attempt === 'number' &&
    Number.isSafeInteger(parsed.data.attempt) &&
    parsed.data.attempt >= 0 &&
    parsed.data.attempt <= 100
      ? parsed.data.attempt
      : undefined;
  return {
    ...(provider ? { provider } : {}),
    ...(routingStrategy ? { routingStrategy } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
  };
};

const failureCategory = (
  status: number | undefined,
  code: string | number | undefined,
): ModelFailureCategory => {
  const effectiveStatus = status ?? (typeof code === 'number' ? code : undefined);
  const normalizedCode = String(code ?? '').toLocaleLowerCase('en-US');
  if (effectiveStatus === 408 || effectiveStatus === 504 || normalizedCode.includes('timeout'))
    return 'timeout';
  if (effectiveStatus === 429 || normalizedCode.includes('rate_limit')) return 'rate_limited';
  if (effectiveStatus === 401 || normalizedCode.includes('auth')) return 'authentication';
  if (
    effectiveStatus === 402 ||
    normalizedCode.includes('credit') ||
    normalizedCode.includes('payment')
  )
    return 'payment_required';
  if (effectiveStatus === 400 || effectiveStatus === 403) return 'request_rejected';
  if (effectiveStatus === 404 || effectiveStatus === 503 || effectiveStatus === 529)
    return 'provider_unavailable';
  if (
    effectiveStatus === 500 ||
    effectiveStatus === 502 ||
    normalizedCode === 'provider_error' ||
    normalizedCode === 'upstream_error'
  )
    return 'provider_failure';
  return 'unknown';
};

const cancelReader = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  try {
    await reader.cancel();
  } catch {
    // The original provider failure remains the actionable error.
  }
};

const readBoundedJson = async (body: ReadableStream<Uint8Array> | null) => {
  if (!body) return undefined;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let content = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumProviderErrorBytes) {
        await cancelReader(reader);
        return undefined;
      }
      content += decoder.decode(value, { stream: true });
    }
    content += decoder.decode();
    return JSON.parse(content) as unknown;
  } catch {
    await cancelReader(reader);
    return undefined;
  }
};

export const extractSseFrames = (buffer: string) => {
  const frames: string[] = [];
  let remainder = buffer;

  while (true) {
    const separator = /\r?\n\r?\n/.exec(remainder);
    if (!separator) break;
    frames.push(remainder.slice(0, separator.index));
    remainder = remainder.slice(separator.index + separator[0].length);
  }

  return { frames, remainder };
};

const frameData = (frame: string) =>
  frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');

const toUsage = (usage: z.infer<typeof usageSchema>): Usage | undefined => {
  const costMicrodollars = usdToMicrodollars(usage.cost);
  if (!Number.isSafeInteger(costMicrodollars) || costMicrodollars < 0) return undefined;
  return {
    costMicrodollars,
    promptTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    webSearchRequests: usage.server_tool_use?.web_search_requests ?? 0,
  };
};

const combineUsage = (left: Usage | undefined, right: Usage | undefined) => {
  if (!left || !right) return undefined;
  return {
    costMicrodollars: left.costMicrodollars + right.costMicrodollars,
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    webSearchRequests: left.webSearchRequests + right.webSearchRequests,
  } satisfies Usage;
};

const withToolContext = (messages: ChatMessage[]) => {
  const context = `Trusted capability state:
- Jolanda has direct read-only calculator, datetime, time-zone, public web-search, and public web-fetch tools on this generation.
- Use the tools when they improve accuracy or freshness, and answer directly when they do not.
- Never claim that Jolanda lacks any of these attached capabilities.`;
  const systemIndex = messages.findIndex((message) => message.role === 'system');
  if (systemIndex < 0) return [{ role: 'system' as const, content: context }, ...messages];
  return messages.map((message, index) =>
    index === systemIndex && message.role === 'system'
      ? { ...message, content: `${message.content}\n\n${context}` }
      : message,
  );
};

const unavailableToolResult = JSON.stringify({ ok: false, error: 'tool_unavailable' });

type CompletionInput = Pick<ModelRunRequest, 'model' | 'reasoning' | 'locale' | 'signal'> & {
  ignoredProviders?: string[];
  messages: ChatMessage[];
  maximumCompletionTokens: number;
  maximumOutputCharacters: number;
  tools: AssistantToolDefinition[];
  stage: ModelFailureStage;
};

const waitForRetry = (delayMs: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(
        new ModelFailure({
          category: 'cancelled',
          stage: 'answer',
          elapsedMs: 0,
          providerQuietMs: 0,
        }),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });

export const createOpenRouter = (input: {
  apiKey: string;
  appUrl?: string;
  logger: Logger;
  waitForRetry?: typeof waitForRetry;
}): ModelRunner => {
  const complete = async (
    request: CompletionInput,
    onDelta: (delta: string, citationUrls: readonly string[]) => Promise<void>,
    onReasoningSummary: (delta: string) => Promise<void>,
    onActivity: () => Promise<void>,
  ) => {
    const startedAt = Date.now();
    let finishReason: string | undefined;
    let ignoredSseFrames = 0;
    let ignoredSseEvents = 0;
    let ignoredToolCallDeltas = 0;
    let timeoutPhase: ModelTimeoutPoint = 'before_headers';
    let firstEventAt: number | undefined;
    let firstTokenAt: number | undefined;
    let lastActivityAt = startedAt;
    let providerActivityEvents = 0;
    let generationId: string | undefined;
    let routing: RouterDiagnostic = {};
    const timeoutPoint = () => timeoutPhase;
    const failure = (
      category: ModelFailureCategory,
      details: Partial<
        Omit<ModelFailureDiagnostic, 'category' | 'stage' | 'elapsedMs' | 'providerQuietMs'>
      > = {},
    ) =>
      new ModelFailure({
        category,
        stage: request.stage,
        ...routing,
        ...(finishReason ? { finishReason } : {}),
        ...(ignoredSseFrames ? { ignoredSseFrames } : {}),
        ...(ignoredSseEvents ? { ignoredSseEvents } : {}),
        ...(ignoredToolCallDeltas ? { ignoredToolCallDeltas } : {}),
        ...details,
        elapsedMs: Date.now() - startedAt,
        providerQuietMs: Date.now() - lastActivityAt,
      });
    const streamStartController = new AbortController();
    const streamStartTimeout = setTimeout(
      () =>
        streamStartController.abort(
          new DOMException('OpenRouter stream did not start before the deadline', 'TimeoutError'),
        ),
      openRouterStreamStartTimeoutMs,
    );
    streamStartTimeout.unref();
    const providerSignal = request.signal
      ? AbortSignal.any([request.signal, streamStartController.signal])
      : streamStartController.signal;
    let streamStarted = false;
    const clearStreamStartTimeout = () => clearTimeout(streamStartTimeout);
    const markStreamStarted = () => {
      if (streamStarted) return;
      streamStarted = true;
      clearStreamStartTimeout();
    };
    const malformedFailure = (malformedReason: ModelMalformedReason) =>
      failure('malformed_response', {
        malformedReason,
        ...(generationId ? { generationId } : {}),
      });
    const signalFailure = () => {
      const reason = providerSignal.reason;
      const name = reason instanceof Error ? reason.name : '';
      const category = name === 'TimeoutError' ? 'timeout' : 'cancelled';
      return failure(category, category === 'timeout' ? { timeoutPoint: timeoutPoint() } : {});
    };
    const providerActivity = async (isStreamEvent = false) => {
      const activityAt = Date.now();
      lastActivityAt = activityAt;
      providerActivityEvents += 1;
      if (isStreamEvent) {
        firstEventAt ??= activityAt;
        timeoutPhase = 'during_stream';
      }
      await onActivity();
    };
    const model = getModel(request.model);
    const functionToolNames = new Set(
      request.tools.flatMap((tool) => (tool.type === 'function' ? [tool.function.name] : [])),
    );
    const hasServerTools = request.tools.some((tool) => tool.type.startsWith('openrouter:'));
    const headers: Record<string, string> = {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'Jolanda Discord Bot',
      'X-OpenRouter-Metadata': 'enabled',
    };
    if (input.appUrl) headers['HTTP-Referer'] = input.appUrl;

    let response: Response;
    try {
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model.openRouterId,
          messages: request.messages,
          reasoning: { effort: request.reasoning, exclude: false },
          max_tokens: request.maximumCompletionTokens,
          stream: true,
          ...(request.tools.length
            ? {
                tool_choice: 'auto',
                max_tool_calls: maximumToolCallsPerRequest,
                tools: request.tools,
              }
            : {}),
          provider: {
            ...(request.ignoredProviders?.length ? { ignore: request.ignoredProviders } : {}),
            data_collection: 'deny',
            ...(model.supportsZdr ? { zdr: true } : {}),
            require_parameters: true,
            sort: 'price',
            // OpenRouter currently rejects max_price when a server tool is present.
            ...(hasServerTools
              ? {}
              : {
                  max_price: {
                    prompt: model.maxPromptPricePerMillion,
                    completion: model.maxCompletionPricePerMillion,
                  },
                }),
          },
        }),
        signal: providerSignal,
      });
    } catch {
      clearStreamStartTimeout();
      if (providerSignal.aborted) throw signalFailure();
      throw failure('network_failure');
    }

    const headersAt = Date.now();
    timeoutPhase = 'before_first_event';
    generationId = safeGenerationId(response.headers.get('X-Generation-Id'));
    await providerActivity();

    if (!response.ok) {
      const parsed = errorChunkSchema.safeParse(await readBoundedJson(response.body));
      clearStreamStartTimeout();
      if (providerSignal.aborted) throw signalFailure();
      const code = safeErrorCode(parsed.success ? parsed.data.error.code : undefined);
      routing = parsed.success ? routerDiagnostic(parsed.data.openrouter_metadata) : {};
      const provider = safeIdentifier(
        parsed.success ? parsed.data.error.metadata?.provider_name : undefined,
        80,
      );
      const category = failureCategory(response.status, code);
      throw failure(category, {
        status: response.status,
        ...(code !== undefined ? { code } : {}),
        ...(generationId ? { generationId } : {}),
        ...(provider ? { provider } : {}),
        ...(category === 'timeout' ? { timeoutPoint: timeoutPoint() } : {}),
      });
    }
    if (!response.body) {
      clearStreamStartTimeout();
      throw malformedFailure('missing_body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let usage: Usage | undefined;
    let usageInvalid = false;
    let reasoningSummaryCharacters = 0;
    const citationUrls = new Set<string>();
    let sourceCitations: readonly SourceCitation[] = [];
    const partialToolCalls = new Map<
      number,
      { id?: string; name: string; arguments: string; invalid: boolean }
    >();

    const processFrame = async (frame: string) => {
      if (frame.length > maximumSseFrameCharacters) throw malformedFailure('frame_too_large');
      const data = frameData(frame);
      if (!data || data === '[DONE]') return;

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(data);
      } catch {
        usageInvalid = true;
        ignoredSseFrames += 1;
        return;
      }

      const errorChunk = errorChunkSchema.safeParse(parsedJson);
      if (errorChunk.success) {
        const code = safeErrorCode(errorChunk.data.error.code);
        routing = routerDiagnostic(errorChunk.data.openrouter_metadata);
        const provider = safeIdentifier(errorChunk.data.error.metadata?.provider_name, 80);
        const category = failureCategory(undefined, code);
        throw failure(category, {
          ...(code !== undefined ? { code } : {}),
          ...(generationId ? { generationId } : {}),
          ...(provider ? { provider } : {}),
          ...(category === 'timeout' ? { timeoutPoint: timeoutPoint() } : {}),
        });
      }

      const chunk = streamChunkSchema.safeParse(parsedJson);
      if (!chunk.success) {
        if (
          typeof parsedJson === 'object' &&
          parsedJson !== null &&
          'usage' in parsedJson &&
          parsedJson.usage !== null &&
          parsedJson.usage !== undefined
        )
          usageInvalid = true;
        ignoredSseEvents += 1;
        return;
      }

      generationId ??= safeGenerationId(chunk.data.id);
      if (chunk.data.openrouter_metadata)
        routing = routerDiagnostic(chunk.data.openrouter_metadata);
      if (chunk.data.usage) {
        const parsedUsage = toUsage(chunk.data.usage);
        if (parsedUsage) usage = parsedUsage;
        else usageInvalid = true;
      }
      for (const choice of chunk.data.choices) {
        finishReason = safeIdentifier(choice.finish_reason, 64) ?? finishReason;
        for (const [fallbackIndex, value] of (choice.delta.tool_calls ?? []).entries()) {
          const parsed = functionToolCallDeltaSchema.safeParse(value);
          if (!parsed.success) {
            ignoredToolCallDeltas += 1;
            continue;
          }
          if (parsed.data.type && parsed.data.type !== 'function') {
            ignoredToolCallDeltas += 1;
            continue;
          }
          const index = parsed.data.index ?? fallbackIndex;
          if (index >= maximumFunctionToolCallsPerRound) {
            ignoredToolCallDeltas += 1;
            continue;
          }
          const current = partialToolCalls.get(index) ?? {
            name: '',
            arguments: '',
            invalid: false,
          };
          const id = parsed.data.id ? safeToolCallId(parsed.data.id) : current.id;
          const name = `${current.name}${parsed.data.function?.name ?? ''}`;
          const arguments_ = `${current.arguments}${parsed.data.function?.arguments ?? ''}`;
          partialToolCalls.set(index, {
            ...(id ? { id } : {}),
            name: name.slice(0, 65),
            arguments: arguments_.slice(0, maximumToolArgumentCharacters + 1),
            invalid:
              current.invalid ||
              name.length > 64 ||
              arguments_.length > maximumToolArgumentCharacters,
          });
        }
      }
      for (const annotation of chunk.data.choices.flatMap((choice) => [
        ...(choice.delta.annotations ?? []),
        ...(choice.message?.annotations ?? []),
      ])) {
        const parsedCitation = citationAnnotationSchema.safeParse(annotation);
        if (!parsedCitation.success) continue;
        const candidate = parsedCitation.data.url_citation;
        if (candidate.url.length > maximumSourceUrlCharacters) continue;
        const citation = createSourceCitation({
          url: candidate.url,
          title: candidate.title,
          startIndex: candidate.start_index,
          endIndex: candidate.end_index,
        });
        if (!citation) continue;
        // `webSearchMaxResults` bounds what we ask the provider for; what we are allowed to
        // render is bounded by the annotation cap, otherwise valid links become "[link removed]".
        if (!citationUrls.has(citation.url) && citationUrls.size >= maximumCitationAnnotations)
          continue;
        citationUrls.add(citation.url);
        sourceCitations = addSourceCitation(sourceCitations, citation);
      }
      for (const detail of chunk.data.choices.flatMap(
        (choice) => choice.delta.reasoning_details ?? [],
      )) {
        if (reasoningSummaryCharacters >= maximumReasoningSummaryCharacters) break;
        const summary = reasoningSummarySchema.safeParse(detail);
        if (!summary.success || !summary.data.summary) continue;
        const accepted = summary.data.summary.slice(
          0,
          maximumReasoningSummaryCharacters - reasoningSummaryCharacters,
        );
        reasoningSummaryCharacters += accepted.length;
        if (accepted) await onReasoningSummary(accepted);
      }
      const delta = chunk.data.choices.map((choice) => choice.delta.content ?? '').join('');
      if (!delta || content.length >= request.maximumOutputCharacters) return;
      const accepted = delta.slice(0, request.maximumOutputCharacters - content.length);
      content += accepted;
      if (accepted) {
        firstTokenAt ??= Date.now();
        await onDelta(accepted, [...citationUrls]);
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if ((value?.byteLength ?? 0) > maximumSseReadBytes)
          throw malformedFailure('read_too_large');
        if (value?.byteLength) {
          markStreamStarted();
          await providerActivity(true);
        }
        buffer += decoder.decode(value, { stream: !done });
        while (true) {
          const separator = /\r?\n\r?\n/.exec(buffer);
          if (!separator) break;
          const frame = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          await processFrame(frame);
        }
        if (buffer.length > maximumSseFrameCharacters) throw malformedFailure('frame_too_large');
        if (done) break;
      }
      if (buffer.trim()) await processFrame(buffer);
    } catch (error) {
      clearStreamStartTimeout();
      await cancelReader(reader);
      if (error instanceof ModelFailure) throw error;
      if (providerSignal.aborted) throw signalFailure();
      if (error instanceof TypeError) throw failure('network_failure');
      throw error;
    }
    clearStreamStartTimeout();

    let localToolCallInvalid = false;
    const parsedToolCalls = [...partialToolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap(([index, call]) => {
        if (call.invalid) {
          localToolCallInvalid = true;
          return [];
        }
        if (!call.name) return [];
        return [
          {
            id: call.id ?? `call_jolanda_${startedAt}_${index}`,
            name: call.name,
            arguments: call.arguments || '{}',
          },
        ];
      });
    if (localToolCallInvalid) throw malformedFailure('invalid_function_tool_call');
    const toolCalls = parsedToolCalls.filter((call) => functionToolNames.has(call.name));
    // A call to a tool we did not offer used to be discarded, which silently ended the answer
    // mid-sentence. Surface it so the caller can answer it with an error and let the model finish.
    const unavailableToolCalls = parsedToolCalls.filter(
      (call) => !functionToolNames.has(call.name),
    );
    if (request.stage === 'answer' && !content.trim() && !parsedToolCalls.length)
      throw malformedFailure(
        finishReason === 'length'
          ? 'reasoning_budget_exhausted'
          : ignoredSseEvents || ignoredSseFrames
            ? 'unsupported_event_shape'
            : 'empty_answer',
      );

    const completedAt = Date.now();
    const diagnostics = {
      durationMs: completedAt - startedAt,
      headersMs: headersAt - startedAt,
      ...(firstEventAt ? { firstEventMs: firstEventAt - startedAt } : {}),
      ...(firstTokenAt ? { firstTokenMs: firstTokenAt - startedAt } : {}),
      providerActivityEvents,
      ...(generationId ? { generationId } : {}),
      ...(finishReason ? { finishReason } : {}),
      ...(ignoredSseFrames ? { ignoredSseFrames } : {}),
      ...(ignoredSseEvents ? { ignoredSseEvents } : {}),
      ...(ignoredToolCallDeltas ? { ignoredToolCallDeltas } : {}),
      ...routing,
    } satisfies ModelStageDiagnostics;
    return {
      content,
      ...(generationId ? { generationId } : {}),
      ...(usage && !usageInvalid ? { usage } : {}),
      citationUrls: [...citationUrls],
      sourceCitations: [...sourceCitations],
      toolCalls,
      unavailableToolCalls,
      diagnostics,
    };
  };

  // Retry transient failures only before any answer text has reached Discord.
  const retryableFailure = (error: unknown) =>
    error instanceof ModelFailure &&
    [
      'malformed_response',
      'provider_failure',
      'provider_unavailable',
      'rate_limited',
      'network_failure',
      'timeout',
    ].includes(error.diagnostic.category);

  const completeWithRetry = async (
    request: CompletionInput,
    onDelta: (delta: string, citationUrls: readonly string[]) => Promise<void>,
    onReasoningSummary: (delta: string) => Promise<void>,
    onActivity: () => Promise<void>,
    canRetry: () => boolean,
    onRetry: (progress: Extract<ModelProgress, { type: 'retry' }>) => Promise<void>,
  ) => {
    const ignoredProviders = new Set(request.ignoredProviders);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await complete(
          { ...request, ignoredProviders: [...ignoredProviders] },
          onDelta,
          onReasoningSummary,
          onActivity,
        );
      } catch (error) {
        if (
          !(error instanceof ModelFailure) ||
          !retryableFailure(error) ||
          !canRetry() ||
          request.signal?.aborted
        )
          throw error;
        // Malformed answers can consume a full generation budget; preserve their single retry.
        const maximumAttempts =
          error.diagnostic.category === 'malformed_response' ? 2 : openRouterMaximumAttempts;
        if (attempt >= maximumAttempts) throw error;
        // Z.AI can finish normally with reasoning but no answer text. Its verified routing
        // slug is `z-ai`; skip that endpoint on this generation's retry, not globally.
        if (
          error.diagnostic.malformedReason === 'empty_answer' &&
          error.diagnostic.provider === 'Z.AI'
        )
          ignoredProviders.add('z-ai');
        const delayMs = openRouterRetryBaseDelayMs * 2 ** (attempt - 1);
        input.logger.info({
          event: 'openrouter_completion_retry',
          model: request.model,
          reasoning: request.reasoning,
          nextAttempt: attempt + 1,
          maximumAttempts,
          delayMs,
          ...(ignoredProviders.size ? { ignoredProviders: [...ignoredProviders] } : {}),
          providerFailure: error.diagnostic,
        });
        await onRetry({
          type: 'retry',
          attempt: attempt + 1,
          maximumAttempts,
          delayMs,
          reason: modelRetryReason(error.diagnostic, request.locale),
        });
        await (input.waitForRetry ?? waitForRetry)(delayMs, request.signal);
      }
    }
  };

  const run: ModelRunner['run'] = async (request, onDelta, onProgress) => {
    const reportProgress = onProgress ?? (async (progress: ModelProgress) => void progress);
    const answerRequest = async (messages: ChatMessage[]) => {
      await reportProgress({ type: 'stage', stage: 'answering' });
      const activeMessages = withToolContext(messages);
      const citationUrls = new Set<string>();
      let sourceCitations: SourceCitation[] = [];
      let content = '';
      let usage: Usage | undefined;
      let usageComplete = true;
      let generationId: string | undefined;
      let finalDiagnostics: ModelStageDiagnostics | undefined;
      const toolRoundDiagnostics: ModelStageDiagnostics[] = [];
      const called: string[] = [];
      const reminderDrafts: { instant: string; text: string }[] = [];
      const initialToolbox = createAssistantToolbox({
        clock: request.clock,
        allowReminders: request.allowReminders ?? false,
        allowFunctions: true,
      });
      let streamedAnyDelta = false;

      // One extra round beyond the tool budget: a text-only pass that lets the model finish an
      // answer it was about to interrupt with a tool call it is no longer allowed to make.
      const finalTextOnlyRound = maximumFunctionToolRounds + 1;
      for (let round = 0; round <= finalTextOnlyRound; round += 1) {
        const textOnly = round === finalTextOnlyRound;
        const toolbox =
          round === 0
            ? initialToolbox
            : createAssistantToolbox({
                clock: request.clock,
                allowReminders: request.allowReminders ?? false,
                allowFunctions: round < maximumFunctionToolRounds,
              });
        const remainingCharacters = maximumResponseCharacters - content.length;
        if (remainingCharacters <= 0) throw new Error('Function tool loop exhausted answer output');
        const completion = await completeWithRetry(
          {
            model: request.model,
            reasoning: request.reasoning,
            ...(request.locale ? { locale: request.locale } : {}),
            messages: activeMessages,
            maximumCompletionTokens: completionTokenBudget(request.model, request.reasoning),
            maximumOutputCharacters: remainingCharacters,
            tools: textOnly ? [] : toolbox.definitions,
            stage: 'answer',
            ...(request.signal ? { signal: request.signal } : {}),
          },
          async (delta, liveSourceUrls) => {
            streamedAnyDelta = true;
            for (const url of liveSourceUrls) citationUrls.add(url);
            await onDelta(delta, [...citationUrls]);
          },
          async (delta) => reportProgress({ type: 'reasoning_summary', delta }),
          async () => reportProgress({ type: 'activity' }),
          () => !streamedAnyDelta && !content,
          // Failed attempts are excluded from the server budget; retain successful usage.
          reportProgress,
        );
        const citationOffset = content.length;
        content += completion.content;
        generationId = completion.generationId ?? generationId;
        for (const url of completion.citationUrls) citationUrls.add(url);
        for (const citation of completion.sourceCitations) {
          const adjusted = {
            ...citation,
            ...(citation.startIndex === undefined
              ? {}
              : { startIndex: citation.startIndex + citationOffset }),
            ...(citation.endIndex === undefined
              ? {}
              : { endIndex: citation.endIndex + citationOffset }),
          };
          sourceCitations = [...addSourceCitation(sourceCitations, adjusted)];
        }
        if (!completion.usage) usageComplete = false;
        else usage = usage ? combineUsage(usage, completion.usage) : completion.usage;

        const pendingCalls = [...completion.toolCalls, ...completion.unavailableToolCalls];
        if (textOnly || !pendingCalls.length) {
          finalDiagnostics = completion.diagnostics;
          break;
        }
        toolRoundDiagnostics.push(completion.diagnostics);
        called.push(...completion.toolCalls.map((call) => call.name));
        const modelToolCalls: FunctionToolCall[] = pendingCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }));
        activeMessages.push({
          role: 'assistant',
          content: completion.content || null,
          tool_calls: modelToolCalls,
        });
        for (const call of completion.toolCalls) {
          let result = toolbox.execute(call);
          if (call.name === 'create_reminder') {
            const parsed = z
              .object({
                ok: z.literal(true),
                draft: z.object({ instant: z.string(), text: z.string() }),
              })
              .safeParse(JSON.parse(result));
            if (
              parsed.success &&
              reminderDrafts.length &&
              !reminderDrafts.some(
                (draft) =>
                  draft.instant === parsed.data.draft.instant &&
                  draft.text === parsed.data.draft.text,
              )
            ) {
              result = JSON.stringify({ ok: false, error: 'one_reminder_per_turn' });
            } else if (
              parsed.success &&
              !reminderDrafts.some(
                (draft) =>
                  draft.instant === parsed.data.draft.instant &&
                  draft.text === parsed.data.draft.text,
              )
            )
              reminderDrafts.push(parsed.data.draft);
          }
          activeMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: result,
          });
        }
        for (const call of completion.unavailableToolCalls)
          activeMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: unavailableToolResult,
          });
        await reportProgress({ type: 'activity' });
      }

      if (!finalDiagnostics) throw new Error('Function tool loop did not produce a final answer');
      return {
        content,
        reminderDrafts,
        ...(generationId ? { generationId } : {}),
        ...(usageComplete && usage ? { usage } : {}),
        citationUrls: [...citationUrls],
        sourceCitations,
        truncated: finalDiagnostics.finishReason === 'length',
        toolActivity: {
          offered: initialToolbox.offered,
          called,
          functionRounds: toolRoundDiagnostics.length,
        },
        diagnostics: finalDiagnostics,
        toolRoundDiagnostics,
      };
    };
    const final = await answerRequest(request.messages);
    return {
      content: final.content,
      ...(final.reminderDrafts.length ? { reminderDrafts: final.reminderDrafts } : {}),
      truncated: final.truncated,
      ...(final.generationId ? { generationId: final.generationId } : {}),
      ...(final.usage ? { usage: final.usage } : {}),
      ...(final.citationUrls.length ? { allowedSourceUrls: final.citationUrls } : {}),
      ...(final.sourceCitations.length ? { sourceCitations: final.sourceCitations } : {}),
      toolActivity: final.toolActivity,
      diagnostics: {
        route: 'assistant',
        answer: final.diagnostics,
        ...(final.toolRoundDiagnostics.length ? { toolRounds: final.toolRoundDiagnostics } : {}),
      },
    };
  };

  return { run };
};
