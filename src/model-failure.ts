import { defaultLocale, messages, type Locale } from './i18n/index.js';

export const modelFailureCategories = [
  'timeout',
  'rate_limited',
  'authentication',
  'payment_required',
  'request_rejected',
  'provider_unavailable',
  'provider_failure',
  'malformed_response',
  'network_failure',
  'cancelled',
  'unknown',
] as const;

export type ModelFailureCategory = (typeof modelFailureCategories)[number];
export type ModelFailureStage = 'answer';
export type ModelTimeoutPoint = 'before_headers' | 'before_first_event' | 'during_stream';
export const modelMalformedReasons = [
  'missing_body',
  'frame_too_large',
  'read_too_large',
  'invalid_function_tool_call',
  'unsupported_event_shape',
  'empty_answer',
  'reasoning_budget_exhausted',
] as const;
export type ModelMalformedReason = (typeof modelMalformedReasons)[number];

export type ModelFailureDiagnostic = {
  category: ModelFailureCategory;
  stage: ModelFailureStage;
  status?: number;
  code?: string | number;
  generationId?: string;
  provider?: string;
  routingStrategy?: string;
  attempt?: number;
  timeoutPoint?: ModelTimeoutPoint;
  malformedReason?: ModelMalformedReason;
  finishReason?: string;
  ignoredSseFrames?: number;
  ignoredSseEvents?: number;
  ignoredToolCallDeltas?: number;
  elapsedMs: number;
  providerQuietMs: number;
};

export class ModelFailure extends Error {
  readonly diagnostic: ModelFailureDiagnostic;

  constructor(diagnostic: ModelFailureDiagnostic) {
    super(`OpenRouter ${diagnostic.stage} failed (${diagnostic.category})`);
    this.name = 'ModelFailure';
    this.diagnostic = diagnostic;
  }
}

export const modelFailureDiagnostic = (error: unknown) =>
  error instanceof ModelFailure ? error.diagnostic : undefined;

// Only fixed labels and numeric status codes reach Discord; never the provider's error body.
export const modelRetryReason = (
  diagnostic: ModelFailureDiagnostic,
  locale: Locale = defaultLocale,
) => {
  const status =
    diagnostic.status ?? (typeof diagnostic.code === 'number' ? diagnostic.code : undefined);
  return messages(locale).failures.retryReason({
    category: diagnostic.category,
    ...(status === undefined ? {} : { status }),
    ...(diagnostic.malformedReason ? { malformedReason: diagnostic.malformedReason } : {}),
  });
};
