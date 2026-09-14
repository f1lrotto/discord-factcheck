import type {
  NewsSubscriptionDocument,
  NewsSourceDocument,
  NewsSourcePayloadDocument,
  NewsMetadataDocument,
  NewsObservationDocument,
  NewsPublicationDocument,
} from './news/mongo.js';
import type { ReelSettingDocument, ReelDeliveryDocument } from './mongo-reels.js';
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
  newsSubscriptions: Collection<NewsSubscriptionDocument>;
  newsSources: Collection<NewsSourceDocument>;
  newsSourcePayloads: Collection<NewsSourcePayloadDocument>;
  newsMetadata: Collection<NewsMetadataDocument>;
  newsObservations: Collection<NewsObservationDocument>;
  newsPublications: Collection<NewsPublicationDocument>;
  reelSettings: Collection<ReelSettingDocument>;
  reelDeliveries: Collection<ReelDeliveryDocument>;
  guildSettings: Collection<GuildSettingsDocument>;
  conversations: Collection<ConversationDocument>;
  messageLinks: Collection<MessageLinkDocument>;
  conversationLocks: Collection<ConversationLockDocument>;
  rateLimits: Collection<RateLimitDocument>;
  budgetBuckets: Collection<BudgetBucketDocument>;
  requests: Collection<RequestDocument>;
};

export const getCollections = (database: Db): Collections => ({
  newsSubscriptions: database.collection<NewsSubscriptionDocument>('news_subscriptions'),
  newsSources: database.collection<NewsSourceDocument>('news_sources'),
  newsSourcePayloads: database.collection<NewsSourcePayloadDocument>('news_source_payloads'),
  newsMetadata: database.collection<NewsMetadataDocument>('news_metadata'),
  newsObservations: database.collection<NewsObservationDocument>('news_observations'),
  newsPublications: database.collection<NewsPublicationDocument>('news_publications'),
  reelSettings: database.collection<ReelSettingDocument>('reel_settings'),
  reelDeliveries: database.collection<ReelDeliveryDocument>('reel_deliveries'),
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
    collections.newsSourcePayloads.createIndex(
      { retainedUntil: 1 },
      { expireAfterSeconds: 0, ...mongoOperationOptions },
    ),
    collections.newsObservations.createIndex(
      { retainedUntil: 1 },
      { expireAfterSeconds: 0, ...mongoOperationOptions },
    ),
    collections.newsPublications.createIndex(
      { retainedUntil: 1 },
      { expireAfterSeconds: 0, ...mongoOperationOptions },
    ),
    collections.newsPublications.createIndex(
      { subscriptionKey: 1, status: 1 },
      mongoOperationOptions,
    ),
    collections.newsPublications.createIndex({ status: 1, dueAt: 1 }, mongoOperationOptions),
    collections.newsPublications.createIndex(
      { status: 1, 'lease.expiresAt': 1 },
      mongoOperationOptions,
    ),
    collections.newsSubscriptions.createIndex(
      { guildKey: 1, feed: 1 },
      { unique: true, ...mongoOperationOptions },
    ),
    collections.newsSubscriptions.createIndex({ enabled: 1, feed: 1 }, mongoOperationOptions),
    collections.reelDeliveries.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, ...mongoOperationOptions },
    ),
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
