import type { Collection, Db } from 'mongodb';
import type { GuildSettings } from './models.js';
import { mongoOperationOptions } from './mongo-context.js';
import type { ConversationTurn, Usage } from './types.js';

export type GuildSettingsDocument = Omit<GuildSettings, 'guildId' | 'contextLimitMessages'> & {
  _id: string;
  contextLimitMessages?: number;
  contextMessages?: number;
};

export type StoredConversationTurn = ConversationTurn & { requestKey: string };

export type ConversationDocument = {
  _id: string;
  guildKey: string;
  channelKey: string;
  ownerKey: string;
  replyCount: number;
  turns: StoredConversationTurn[];
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
};

export type MessageLinkDocument = {
  _id: string;
  conversationId: string;
  guildKey: string;
  channelKey: string;
  expiresAt: Date;
};

export type ConversationLockDocument = {
  _id: string;
  requestKey: string;
  expiresAt: Date;
};

export type RateLimitDocument = {
  _id: string;
  attempts: Date[];
  expiresAt: Date;
};

export type BudgetBucketDocument = {
  _id: string;
  guildKey: string;
  period: 'day' | 'month';
  periodKey: string;
  usedMicrodollars: number;
  reservedMicrodollars: number;
  expiresAt: Date;
};

export type RequestDocument = {
  _id: string;
  guildKey: string;
  channelKey: string;
  userKey: string;
  instanceKey: string;
  dailyBucketId: string;
  monthlyBucketId: string;
  reservationMicrodollars: number;
  status: 'processing' | 'completed' | 'usage_missing' | 'failed';
  usage?: Usage;
  errorCode?: string;
  createdAt: Date;
  leaseExpiresAt: Date;
  settledAt?: Date;
  expiresAt: Date;
};

export type Collections = {
  guildSettings: Collection<GuildSettingsDocument>;
  conversations: Collection<ConversationDocument>;
  messageLinks: Collection<MessageLinkDocument>;
  conversationLocks: Collection<ConversationLockDocument>;
  rateLimits: Collection<RateLimitDocument>;
  budgetBuckets: Collection<BudgetBucketDocument>;
  requests: Collection<RequestDocument>;
};

export const getCollections = (database: Db): Collections => ({
  guildSettings: database.collection<GuildSettingsDocument>('guild_settings'),
  conversations: database.collection<ConversationDocument>('conversations'),
  messageLinks: database.collection<MessageLinkDocument>('message_links'),
  conversationLocks: database.collection<ConversationLockDocument>('conversation_locks'),
  rateLimits: database.collection<RateLimitDocument>('rate_limits'),
  budgetBuckets: database.collection<BudgetBucketDocument>('budget_buckets'),
  requests: database.collection<RequestDocument>('requests'),
});

export const createIndexes = async (collections: Collections) => {
  await Promise.all([
    collections.conversations.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, ...mongoOperationOptions },
    ),
    collections.messageLinks.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, ...mongoOperationOptions },
    ),
    collections.conversationLocks.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, ...mongoOperationOptions },
    ),
    collections.rateLimits.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, ...mongoOperationOptions },
    ),
    collections.budgetBuckets.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, ...mongoOperationOptions },
    ),
    collections.requests.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, ...mongoOperationOptions },
    ),
    collections.requests.createIndex({ guildKey: 1, createdAt: -1 }, mongoOperationOptions),
    collections.requests.createIndex({ userKey: 1, createdAt: -1 }, mongoOperationOptions),
    collections.requests.createIndex({ status: 1, leaseExpiresAt: 1 }, mongoOperationOptions),
  ]);
};
