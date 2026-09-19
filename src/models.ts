import type { Locale } from './i18n/plural.js';

export const reasoningEfforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ReasoningEffort = (typeof reasoningEfforts)[number];
export type ModelId =
  | 'luna'
  | 'deepseek-v4-flash'
  | 'glm-5.3-flash'
  | 'hermes-4-405b'
  | 'venice-uncensored'
  | 'grok-4.3'
  | 'qwen3.8-flash'
  | 'mistral-small-4';

export type ModelDefinition = {
  id: ModelId;
  label: string;
  description: Record<Locale, string>;
  supportsTools: boolean;
  reasoningMode: 'effort' | 'toggle' | 'none';
  openRouterId: string;
  supportsZdr: boolean;
  supportsVision: boolean;
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
    description: { en: 'General chat, images', sk: 'Bežný chat, obrázky' },
    supportsTools: true,
    reasoningMode: 'effort',
    openRouterId: 'openai/gpt-5.6-luna',
    supportsZdr: false,
    supportsVision: true,
    defaultReasoning: 'medium',
    reasoningEfforts,
    maxPromptPricePerMillion: 0.5,
    maxCompletionPricePerMillion: 2,
    maxOutputTokens: 128_000,
  },
  'deepseek-v4-flash': {
    id: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    description: { en: 'Text reasoning', sk: 'Uvažovanie nad textom' },
    supportsTools: true,
    reasoningMode: 'effort',
    openRouterId: 'deepseek/deepseek-v4-flash-0731',
    supportsZdr: true,
    supportsVision: false,
    defaultReasoning: 'high',
    reasoningEfforts: ['low', 'high', 'max'],
    maxPromptPricePerMillion: 0.25,
    maxCompletionPricePerMillion: 0.75,
    maxOutputTokens: 131_072,
  },
  'glm-5.3-flash': {
    id: 'glm-5.3-flash',
    label: 'GLM 5.3 Flash',
    description: { en: 'Budget chat, images', sk: 'Lacný chat, obrázky' },
    supportsTools: true,
    reasoningMode: 'effort',
    openRouterId: 'z-ai/glm-5.3-flash',
    supportsZdr: true,
    supportsVision: true,
    defaultReasoning: 'max',
    reasoningEfforts: ['low', 'high', 'max'],
    maxPromptPricePerMillion: 0.15,
    maxCompletionPricePerMillion: 0.5,
    maxOutputTokens: 131_072,
  },
  'hermes-4-405b': {
    id: 'hermes-4-405b',
    label: 'Hermes 4 405B',
    description: { en: 'Fewer refusals; chat only', sk: 'Menej odmietnutí; iba chat' },
    openRouterId: 'nousresearch/hermes-4-405b',
    supportsZdr: true,
    supportsVision: false,
    supportsTools: false,
    reasoningMode: 'toggle',
    defaultReasoning: 'none',
    reasoningEfforts: ['none', 'high'],
    maxPromptPricePerMillion: 1,
    maxCompletionPricePerMillion: 3,
    maxOutputTokens: 117_964,
  },
  'venice-uncensored': {
    id: 'venice-uncensored',
    label: 'Venice Uncensored',
    description: { en: 'Uncensored assistant; chat only', sk: 'Necenzurovaný asistent; iba chat' },
    openRouterId: 'cognitivecomputations/dolphin-mistral-24b-venice-edition',
    supportsZdr: true,
    supportsVision: false,
    supportsTools: false,
    reasoningMode: 'none',
    defaultReasoning: 'none',
    reasoningEfforts: ['none'],
    maxPromptPricePerMillion: 0.2,
    maxCompletionPricePerMillion: 0.9,
    maxOutputTokens: 8_192,
  },
  'grok-4.3': {
    id: 'grok-4.3',
    label: 'Grok 4.3',
    description: { en: 'General reasoning, images', sk: 'Všeobecné uvažovanie, obrázky' },
    openRouterId: 'x-ai/grok-4.3',
    supportsZdr: true,
    supportsVision: true,
    supportsTools: true,
    reasoningMode: 'effort',
    defaultReasoning: 'low',
    reasoningEfforts: ['none', 'low', 'medium', 'high'],
    // Cover the provider's >200k-token tier and priority route in the reservation.
    maxPromptPricePerMillion: 5,
    maxCompletionPricePerMillion: 10,
    maxOutputTokens: 900_000,
  },
  'qwen3.8-flash': {
    id: 'qwen3.8-flash',
    label: 'Qwen3.8 Flash',
    description: { en: 'Budget coding, charts, images', sk: 'Lacné kódovanie, grafy, obrázky' },
    openRouterId: 'qwen/qwen3.8-flash',
    supportsZdr: false,
    supportsVision: true,
    supportsTools: true,
    reasoningMode: 'effort',
    defaultReasoning: 'medium',
    reasoningEfforts,
    maxPromptPricePerMillion: 0.2,
    maxCompletionPricePerMillion: 0.47,
    maxOutputTokens: 131_072,
  },
  'mistral-small-4': {
    id: 'mistral-small-4',
    label: 'Mistral Small 4',
    description: { en: 'Budget all-rounder, images', sk: 'Lacný univerzál, obrázky' },
    openRouterId: 'mistralai/mistral-small-2603',
    supportsZdr: true,
    supportsVision: true,
    supportsTools: true,
    reasoningMode: 'effort',
    defaultReasoning: 'none',
    reasoningEfforts: ['none', 'high'],
    maxPromptPricePerMillion: 0.165,
    maxCompletionPricePerMillion: 0.66,
    maxOutputTokens: 209_715,
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
  // Slovak by default: this deployment's server speaks Slovak. Model answers are unaffected
  // and keep following the language each question is written in.
  locale: 'sk',
} as const satisfies Omit<GuildSettings, 'guildId' | 'updatedAt'>;

export type GuildSettings = {
  guildId: string;
  model: ModelId;
  reasoning: ReasoningEffort;
  contextLimitMessages: number;
  locale: Locale;
  updatedAt: Date;
};

export const getModel = (id: ModelId) => modelCatalog[id];

// Keep the server's text model; only image-bearing turns need the vision fallback.
export const resolveImageModel = (settings: GuildSettings, hasImages: boolean) =>
  hasImages && !getModel(settings.model).supportsVision
    ? {
        ...settings,
        model: 'glm-5.3-flash' as const,
        reasoning: modelCatalog['glm-5.3-flash'].reasoningEfforts.some(
          (effort) => effort === settings.reasoning,
        )
          ? settings.reasoning
          : modelCatalog['glm-5.3-flash'].defaultReasoning,
      }
    : settings;

export const modelProfiles = () =>
  Object.values(modelCatalog).flatMap((model) =>
    model.reasoningEfforts.map((reasoning) => ({
      id: `${model.id}:${reasoning}`,
      label: `${model.label} · ${reasoning}${reasoning === model.defaultReasoning ? ' (default)' : ''}${model.supportsZdr ? '' : ' · [no ZDR]'}`,
      model: model.id,
      reasoning,
    })),
  );

// Discord autocomplete permits 25 choices. Show every model's default first;
// typing a model or effort exposes all matching profiles without dropping any.
export const modelChoices = (query = '', locale: Locale = 'sk') => {
  const words = query.toLocaleLowerCase(locale).trim().split(/\s+/u).filter(Boolean);
  return modelProfiles()
    .filter((profile) => {
      const model = getModel(profile.model);
      const searchable =
        `${profile.label} ${profile.id} ${model.description[locale]}`.toLocaleLowerCase(locale);
      return words.length
        ? words.every((word) => searchable.includes(word))
        : profile.reasoning === model.defaultReasoning;
    })
    .slice(0, 25)
    .map((profile) => ({
      name: `${profile.label} · ${getModel(profile.model).description[locale]}`,
      value: profile.id,
    }));
};

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
