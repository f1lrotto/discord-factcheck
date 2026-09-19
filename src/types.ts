import type { GuildSettings, ModelId, ReasoningEffort } from './models.js';
import type {
  ModelFailureCategory,
  ModelFailureStage,
  ModelMalformedReason,
} from './model-failure.js';
import type { SourceCitation } from './citations.js';
import type { ClockSnapshot } from './clock.js';
import type { ImageAttachment } from './discord-images.js';
import type { Locale } from './i18n/plural.js';

export type FunctionToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | UserContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: FunctionToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string; name: string };

export type UserContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export type ContextMessage = {
  id: string;
  content: string;
};

export type ReferencedMessage = ContextMessage & {
  isJolanda: boolean;
};

export type AmbientContextRequest = {
  limit: number | 'maximum';
};

export type TurnRequest = {
  remindersSupported?: boolean;
  id: string;
  guildId: string;
  channelId: string;
  userId: string;
  question: string;
  modelProfile?: string;
  images?: ImageAttachment[];
  ambientContext?: AmbientContextRequest;
  referencedMessage?: ReferencedMessage;
  loadAmbientContext: (limit: number) => Promise<ContextMessage[]>;
};

export type Usage = {
  costMicrodollars: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  webSearchRequests: number;
};

export type ConversationTurn = {
  userContent: string;
  assistantContent: string;
  createdAt: Date;
};

export type Conversation = {
  id: string;
  ownerKey: string;
  replyCount: number;
  turns: ConversationTurn[];
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
};

export type BudgetSummary = {
  dailyUsedMicrodollars: number;
  dailyReservedMicrodollars: number;
  monthlyUsedMicrodollars: number;
  monthlyReservedMicrodollars: number;
};

/**
 * Two windows with different retention, deliberately reported separately.
 * `trend` comes from budget buckets, which live far longer than the per-request documents
 * that `members` is derived from, so the two must never be presented as one window.
 */
export type UsageSummary = {
  trendDays: number;
  memberWindowDays: number;
  trend: { date: string; costMicrodollars: number; requests: number }[];
  members: {
    userKey: string;
    requests: number;
    costMicrodollars: number;
    failures: number;
  }[];
  totalCostMicrodollars: number;
};

export type AuthorizationResult =
  { ok: true } | { ok: false; reason: 'duplicate' | 'rate_limited' | 'monthly_budget' };

export type TurnOutcome =
  | { status: 'completed'; conversationId: string }
  | {
      status: 'rejected';
      reason:
        | 'empty_question'
        | 'invalid_model'
        | 'image_limit'
        | 'image_too_large'
        | 'image_unavailable'
        | 'expired_conversation'
        | 'conversation_busy'
        | 'conversation_limit'
        | 'conversation_owner'
        | 'context_limit'
        | 'server_busy'
        | 'shutting_down'
        | 'duplicate'
        | 'rate_limited'
        | 'monthly_budget';
    }
  | { status: 'failed' };

export type ResponseSink = {
  prepare: (
    signal?: AbortSignal,
    profile?: Pick<GuildSettings, 'model' | 'reasoning'> | null,
  ) => Promise<void>;
  update: (
    content: string,
    allowedSourceUrls?: readonly string[],
    signal?: AbortSignal,
  ) => Promise<void>;
  finish: (
    content: string,
    allowedSourceUrls?: readonly string[],
    signal?: AbortSignal,
  ) => Promise<string[]>;
  fail: (
    partialContent: string,
    allowedSourceUrls?: readonly string[],
    failure?: FailureNotice,
    signal?: AbortSignal,
  ) => Promise<void>;
};

export type ModelRunRequest = {
  allowReminders?: boolean;
  messages: ChatMessage[];
  model: ModelId;
  reasoning: ReasoningEffort;
  clock: ClockSnapshot;
  /** Renders retry notices only. It never reaches the prompt or the provider. */
  locale?: Locale;
  signal?: AbortSignal;
};

export type ModelStageDiagnostics = {
  durationMs: number;
  headersMs: number;
  firstEventMs?: number;
  firstTokenMs?: number;
  providerActivityEvents: number;
  generationId?: string;
  provider?: string;
  routingStrategy?: string;
  attempt?: number;
  finishReason?: string;
  ignoredSseFrames?: number;
  ignoredSseEvents?: number;
  ignoredToolCallDeltas?: number;
};

export type ModelRunDiagnostics = {
  route: 'assistant';
  answer: ModelStageDiagnostics;
  toolRounds?: ModelStageDiagnostics[];
};

export type ToolActivity = {
  offered: string[];
  called: string[];
  functionRounds: number;
};

export type ModelRunResult = {
  reminderDrafts?: { instant: string; text: string }[];
  content: string;
  /** The provider stopped on `finish_reason: "length"`, so the answer is incomplete. */
  truncated?: boolean;
  generationId?: string;
  usage?: Usage;
  allowedSourceUrls?: string[];
  sourceCitations?: SourceCitation[];
  toolActivity?: ToolActivity;
  diagnostics?: ModelRunDiagnostics;
};

export type ModelProgress =
  | { type: 'stage'; stage: 'answering' }
  | { type: 'reasoning_summary'; delta: string }
  | { type: 'retry'; attempt: number; maximumAttempts: number; delayMs: number; reason: string }
  | { type: 'activity' };

export type ModelRunner = {
  run: (
    request: ModelRunRequest,
    onDelta: (delta: string, allowedSourceUrls?: readonly string[]) => Promise<void>,
    onProgress?: (progress: ModelProgress) => Promise<void>,
  ) => Promise<ModelRunResult>;
};

export type FailureNotice = {
  category: ModelFailureCategory;
  stage?: ModelFailureStage;
  malformedReason?: ModelMalformedReason;
  reference: string;
};

export type StoredTurn = {
  conversationId: string;
  guildId: string;
  channelId: string;
  ownerId: string;
  requestId: string;
  assistantMessageIds: string[];
  turn: ConversationTurn;
  expiresAt: Date;
};

export type JolandaStore = {
  initialize: () => Promise<void>;
  close: () => Promise<void>;
  getSettings: (guildId: string) => Promise<GuildSettings>;
  updateSettings: (
    guildId: string,
    patch: Partial<Pick<GuildSettings, 'model' | 'reasoning' | 'contextLimitMessages' | 'locale'>>,
  ) => Promise<GuildSettings>;
  getBudgetSummary: (guildId: string, now: Date) => Promise<BudgetSummary>;
  getUsageSummary: (
    guildId: string,
    options: { now: Date; trendDays: number; memberWindowDays: number },
  ) => Promise<UsageSummary>;
  findConversationByMessage: (input: {
    messageId: string;
    guildId: string;
    channelId: string;
  }) => Promise<Conversation | null>;
  tryLockConversation: (conversationId: string, lockToken: string, now: Date) => Promise<boolean>;
  releaseConversation: (conversationId: string, lockToken: string) => Promise<void>;
  authorizeTurn: (input: {
    requestId: string;
    guildId: string;
    channelId: string;
    userId: string;
    reservationMicrodollars: number;
    now: Date;
  }) => Promise<AuthorizationResult>;
  settleRequest: (input: {
    requestId: string;
    usage: Usage;
    status: 'completed' | 'usage_missing';
  }) => Promise<void>;
  failRequest: (requestId: string, errorCode: string) => Promise<void>;
  appendTurn: (input: StoredTurn) => Promise<void>;
};
