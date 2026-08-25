export const reasoningEfforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ReasoningEffort = (typeof reasoningEfforts)[number];
export type ModelId = 'luna' | 'deepseek-v4-flash';

export type ModelDefinition = {
  id: ModelId;
  label: string;
  openRouterId: string;
  defaultReasoning: ReasoningEffort;
  reasoningEfforts: readonly ReasoningEffort[];
  maxPromptPricePerMillion: number;
  maxCompletionPricePerMillion: number;
};

export const modelCatalog = {
  luna: {
    id: 'luna',
    label: 'GPT-5.6 Luna',
    openRouterId: 'openai/gpt-5.6-luna',
    defaultReasoning: 'medium',
    reasoningEfforts,
    maxPromptPricePerMillion: 0.5,
    maxCompletionPricePerMillion: 2,
  },
  'deepseek-v4-flash': {
    id: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    openRouterId: 'deepseek/deepseek-v4-flash-0731',
    defaultReasoning: 'high',
    reasoningEfforts: ['low', 'high', 'max'],
    maxPromptPricePerMillion: 0.25,
    maxCompletionPricePerMillion: 0.75,
  },
} as const satisfies Record<ModelId, ModelDefinition>;

const maxTokensByEffort: Record<ReasoningEffort, number> = {
  none: 2_048,
  low: 3_072,
  medium: 4_096,
  high: 6_144,
  xhigh: 8_192,
  max: 8_192,
};

export const defaultGuildSettings = {
  model: 'luna',
  reasoning: 'medium',
  contextMessages: 0,
} as const satisfies Omit<GuildSettings, 'guildId' | 'updatedAt'>;

export type GuildSettings = {
  guildId: string;
  model: ModelId;
  reasoning: ReasoningEffort;
  contextMessages: number;
  updatedAt: Date;
};

export const getModel = (id: ModelId) => modelCatalog[id];

export const isModelId = (value: string): value is ModelId => value in modelCatalog;

export const isReasoningEffort = (value: string): value is ReasoningEffort =>
  reasoningEfforts.some((effort) => effort === value);

export const modelSupportsReasoning = (model: ModelId, effort: ReasoningEffort) =>
  getModel(model).reasoningEfforts.some((supported) => supported === effort);

export const maxTokensForReasoning = (effort: ReasoningEffort) => maxTokensByEffort[effort];

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
