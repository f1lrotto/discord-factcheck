import type { GuildSettings, ModelId, ReasoningEffort } from './models.js';
import type {
  ModelFailureCategory,
  ModelFailureStage,
  ModelMalformedReason,
} from './model-failure.js';
import type { SourceCitation } from './citations.js';
import type { ClockSnapshot } from './clock.js';

export type FunctionToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: FunctionToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string; name: string };

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
  id: string;
  guildId: string;
  channelId: string;
  userId: string;
  question: string;
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

export type AuthorizationResult =
  | { ok: true }
  | { ok: false; reason: 'duplicate' | 'rate_limited' | 'daily_budget' | 'monthly_budget' };

export type TurnOutcome =
  | { status: 'completed'; conversationId: string }
  | {
      status: 'rejected';
      reason:
        | 'empty_question'
        | 'expired_conversation'
        | 'conversation_busy'
        | 'conversation_limit'
        | 'conversation_owner'
        | 'context_limit'
        | 'server_busy'
        | 'shutting_down'
        | 'duplicate'
        | 'rate_limited'
        | 'daily_budget'
        | 'monthly_budget';
    }
  | { status: 'failed' };

export type ResponseSink = {
  prepare: (signal?: AbortSignal) => Promise<void>;
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
  messages: ChatMessage[];
  model: ModelId;
  reasoning: ReasoningEffort;
  clock: ClockSnapshot;
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
    patch: Partial<Pick<GuildSettings, 'model' | 'reasoning' | 'contextLimitMessages'>>,
  ) => Promise<GuildSettings>;
  getBudgetSummary: (guildId: string, now: Date) => Promise<BudgetSummary>;
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
