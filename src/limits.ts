import {
  modelCatalog,
  maxTokensForReasoning,
  type ModelId,
  type ReasoningEffort,
} from './models.js';

export const conversationReplyLimit = 10;
export const discordMessageCharacters = 1_900;
export const maximumReasoningSummaryCharacters = discordMessageCharacters - 300;
export const maximumDiscordChunks = 6;
export const maximumResponseCharacters =
  discordMessageCharacters * maximumDiscordChunks - '[…response truncated]'.length - 2;
export const openRouterStreamStartTimeoutMs = 10 * 60_000;
export const discordOperationTimeoutMs = 15_000;
export const mongoOperationTimeoutMs = 15_000;
export const discordAdapterDrainTimeoutMs = 30_000;
export const maximumDiscordAdapterHandlers = 20;
export const streamUpdateIntervalMs = 1_000;
export const progressHeartbeatIntervalMs = 2_000;
export const providerQuietThresholdMs = 15_000;
export const requestLeaseMs = openRouterStreamStartTimeoutMs + 2 * 60_000;
export const recoveryIntervalMs = 60_000;
export const webSearchMaxResults = 3;
export const webSearchResultCharacters = 1_500;
export const webFetchMaxUses = 2;
export const webFetchMaxContentTokens = 8_000;
export const maximumToolCallsPerRequest = 5;
export const maximumFunctionToolRounds = 2;
export const maximumFunctionToolCallsPerRound = 4;
export const maximumToolArgumentCharacters = 4_000;
export const maximumToolResultCharacters = 2_000;
export const maximumSourceUrlCharacters = 2_048;
export const maximumSseFrameCharacters = 256_000;
export const maximumSseReadBytes = 512_000;
export const maximumProviderErrorBytes = 64_000;
export const maximumCitationAnnotations = 24;
export const maximumCitationTitleCharacters = 200;
export const messageLinkLookupsPerMinute = 10;

const maximumTokensPerCharacter = 4;
const requestProtocolOverheadCharacters = 8_000;
const reservedWebSearchMicrodollars = 50_000;
const fixedSafetyMarginMicrodollars = 20_000;

const tokenCost = (tokens: number, pricePerMillion: number) =>
  Math.ceil((tokens * pricePerMillion * 1_000_000) / 1_000_000);

export const costEnvelopeDetails = (input: {
  model: ModelId;
  reasoning: ReasoningEffort;
  maximumPromptCharacters: number;
}) => {
  const model = modelCatalog[input.model];
  const functionLoopCharacters =
    maximumFunctionToolRounds *
    (input.maximumPromptCharacters +
      requestProtocolOverheadCharacters +
      maximumFunctionToolCallsPerRound *
        (maximumToolArgumentCharacters + maximumToolResultCharacters));
  const inputCharacters =
    input.maximumPromptCharacters +
    webSearchMaxResults * webSearchResultCharacters +
    requestProtocolOverheadCharacters +
    functionLoopCharacters;
  const inputTokens =
    inputCharacters * maximumTokensPerCharacter + webFetchMaxUses * webFetchMaxContentTokens;
  const outputTokens = maxTokensForReasoning(input.reasoning) * (maximumFunctionToolRounds + 1);

  const promptMicrodollars = tokenCost(inputTokens, model.maxPromptPricePerMillion);
  const completionMicrodollars = tokenCost(outputTokens, model.maxCompletionPricePerMillion);
  return {
    maximumInputCharacters: inputCharacters,
    maximumInputTokens: inputTokens,
    maximumOutputTokens: outputTokens,
    promptMicrodollars,
    completionMicrodollars,
    webSearchMicrodollars: reservedWebSearchMicrodollars,
    safetyMarginMicrodollars: fixedSafetyMarginMicrodollars,
    totalMicrodollars:
      promptMicrodollars +
      completionMicrodollars +
      reservedWebSearchMicrodollars +
      fixedSafetyMarginMicrodollars,
  };
};

export const costEnvelopeMicrodollars = (input: Parameters<typeof costEnvelopeDetails>[0]) =>
  costEnvelopeDetails(input).totalMicrodollars;

export const maximumCostEnvelopeMicrodollars = (maximumPromptCharacters: number) =>
  Math.max(
    ...Object.values(modelCatalog).flatMap((model) =>
      model.reasoningEfforts.map((reasoning) =>
        costEnvelopeMicrodollars({
          model: model.id,
          reasoning,
          maximumPromptCharacters,
        }),
      ),
    ),
  );

export const createConcurrencyGate = (maximum: number) => {
  let active = 0;

  const tryAcquire = () => {
    if (active >= maximum) return null;
    active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
    };
  };

  return { tryAcquire, active: () => active };
};

export const createSlidingWindowGate = (maximum: number, windowMs = 60_000, capacity = 10_000) => {
  const attempts = new Map<string, number[]>();

  const tryAcquire = (key: string, now = Date.now()) => {
    const cutoff = now - windowMs;
    if (!attempts.has(key) && attempts.size >= capacity) {
      for (const [candidate, values] of attempts) {
        if (values.every((attempt) => attempt <= cutoff)) attempts.delete(candidate);
      }
      if (attempts.size >= capacity) return false;
    }
    const recent = (attempts.get(key) ?? []).filter((attempt) => attempt > cutoff);
    if (recent.length >= maximum) {
      attempts.set(key, recent);
      return false;
    }
    attempts.set(key, [...recent, now]);
    if (attempts.size > capacity) {
      for (const [candidate, values] of attempts) {
        if (values.every((attempt) => attempt <= cutoff)) attempts.delete(candidate);
      }
    }
    return true;
  };

  return { tryAcquire };
};
