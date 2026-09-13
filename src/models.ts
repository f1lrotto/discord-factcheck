export const reasoningEfforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ReasoningEffort = (typeof reasoningEfforts)[number];
export type ModelId = 'luna' | 'deepseek-v4-flash' | 'glm-5.3-flash';

export type ModelDefinition = {
  id: ModelId;
  label: string;
  openRouterId: string;
  supportsZdr: boolean;
  defaultReasoning: ReasoningEffort;
  reasoningEfforts: readonly ReasoningEffort[];
  maxPromptPricePerMillion: number;
  maxCompletionPricePerMillion: number;
  maxOutputTokens: number;
};

export const modelCatalog = {
  luna: {
    id: 'luna',
    label: 'GPT-5.6 Luna',
    openRouterId: 'openai/gpt-5.6-luna',
    supportsZdr: false,
    defaultReasoning: 'medium',
    reasoningEfforts,
    maxPromptPricePerMillion: 0.5,
    maxCompletionPricePerMillion: 2,
    maxOutputTokens: 128_000,
  },
  'deepseek-v4-flash': {
    id: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    openRouterId: 'deepseek/deepseek-v4-flash-0731',
    supportsZdr: true,
    defaultReasoning: 'high',
    reasoningEfforts: ['low', 'high', 'max'],
    maxPromptPricePerMillion: 0.25,
    maxCompletionPricePerMillion: 0.75,
    maxOutputTokens: 131_072,
  },
  'glm-5.3-flash': {
    id: 'glm-5.3-flash',
    label: 'GLM 5.3 Flash',
    openRouterId: 'z-ai/glm-5.3-flash',
    supportsZdr: true,
    defaultReasoning: 'max',
    reasoningEfforts: ['low', 'high', 'max'],
    maxPromptPricePerMillion: 0.15,
    maxCompletionPricePerMillion: 0.5,
    maxOutputTokens: 131_072,
  },
} as const satisfies Record<ModelId, ModelDefinition>;

// `max_tokens` is the combined reasoning + answer budget. Thinking models spend most of
// it before emitting a single answer token, so the ladder leaves generous reasoning
// headroom; the visible answer is separately bounded by `maximumResponseCharacters`.
const maxTokensByEffort: Record<ReasoningEffort, number> = {
  none: 4_096,
  low: 16_384,
  medium: 32_768,
  high: 49_152,
  xhigh: 65_536,
  max: 81_920,
};

export const defaultGuildSettings = {
  model: 'glm-5.3-flash',
  reasoning: 'high',
  contextLimitMessages: 0,
} as const satisfies Omit<GuildSettings, 'guildId' | 'updatedAt'>;

export type GuildSettings = {
  guildId: string;
  model: ModelId;
  reasoning: ReasoningEffort;
  contextLimitMessages: number;
  updatedAt: Date;
};

export const getModel = (id: ModelId) => modelCatalog[id];

export const modelProfiles = () =>
  Object.values(modelCatalog).flatMap((model) =>
    model.reasoningEfforts.map((reasoning) => ({
      id: `${model.id}:${reasoning}`,
      label: `${model.label} · ${reasoning}${reasoning === model.defaultReasoning ? ' (default)' : ''}${model.supportsZdr ? '' : ' · [no ZDR]'}`,
      model: model.id,
      reasoning,
    })),
  );

export const findModelProfile = (id: string) =>
  modelProfiles().find((profile) => profile.id === id);

export const modelSupportsZdr = (model: ModelId) => getModel(model).supportsZdr;

export const isModelId = (value: string): value is ModelId => value in modelCatalog;

export const isReasoningEffort = (value: string): value is ReasoningEffort =>
  reasoningEfforts.some((effort) => effort === value);

export const modelSupportsReasoning = (model: ModelId, effort: ReasoningEffort) =>
  getModel(model).reasoningEfforts.some((supported) => supported === effort);

export const completionTokenBudget = (model: ModelId, effort: ReasoningEffort) =>
  Math.min(maxTokensByEffort[effort], modelCatalog[model].maxOutputTokens);

export class UnsupportedReasoningError extends Error {
  readonly model: ModelId;
  readonly reasoning: ReasoningEffort;

  constructor(model: ModelId, reasoning: ReasoningEffort) {
    super(`${model} does not support ${reasoning} reasoning`);
    this.name = 'UnsupportedReasoningError';
    this.model = model;
    this.reasoning = reasoning;
  }
}
