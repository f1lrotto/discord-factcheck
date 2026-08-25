import type { GuildSettings, ModelId, ReasoningEffort } from './models.js';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type ContextMessage = {
  id: string;
  content: string;
};

export type ReferencedMessage = ContextMessage & {
  isJolanda: boolean;
};

export type TurnRequest = {
  id: string;
  guildId: string;
  channelId: string;
  userId: string;
  question: string;
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
    signal?: AbortSignal,
  ) => Promise<void>;
};

export type ModelRunRequest = {
  messages: ChatMessage[];
  model: ModelId;
  reasoning: ReasoningEffort;
  publicQuestion?: string;
  signal?: AbortSignal;
};

export type ModelRunResult = {
  content: string;
  generationId?: string;
  usage?: Usage;
  allowedSourceUrls?: string[];
};

export type ModelRunner = {
  run: (
    request: ModelRunRequest,
    onDelta: (delta: string, allowedSourceUrls?: readonly string[]) => Promise<void>,
  ) => Promise<ModelRunResult>;
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
    patch: Partial<Pick<GuildSettings, 'model' | 'reasoning' | 'contextMessages'>>,
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
