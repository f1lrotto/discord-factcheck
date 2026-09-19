import { createMongoBriefing } from './briefing/mongo.js';
import { createReleaseStore } from './releases/store.js';
import { createMongoReminders } from './mongo-reminders.js';
import { createMongoNews, type NewsMongoOptions } from './news/mongo.js';
import { MongoClient, type MongoClientOptions } from 'mongodb';
import type { Logger } from 'pino';
import { createMongoAccounting } from './mongo-accounting.js';
import { createMongoConversations } from './mongo-conversations.js';
import type { MongoContext } from './mongo-context.js';
import { createIndexes, getCollections } from './mongo-schema.js';
import { createMongoSettings } from './mongo-settings.js';
import { mongoOperationTimeoutMs } from './limits.js';
import { createMongoReels } from './mongo-reels.js';
import type { ReelStore } from './reel-types.js';
import type { JolandaStore } from './types.js';

export const mongoClientOptions = {
  appName: 'jolanda-discord-bot',
  maxPoolSize: 10,
  minPoolSize: 1,
  connectTimeoutMS: mongoOperationTimeoutMs,
  serverSelectionTimeoutMS: mongoOperationTimeoutMs,
  socketTimeoutMS: mongoOperationTimeoutMs,
} satisfies MongoClientOptions;

export const createMongoStore = (
  input: {
    uri: string;
    databaseName: string;
    monthlyLimitMicrodollars: number;
    promptsPerMinute: number;
    transcriptTtlMs: number;
    instanceId: string;
    protectIdentifier: (identifier: string) => string;
    logger: Logger;
    recoveryIntervalMs?: number;
    requestLeaseMs?: number;
    news?: NewsMongoOptions;
    secret?: string;
  },
  dependencies: {
    client?: MongoClient;
    createAccounting?: typeof createMongoAccounting;
  } = {},
): JolandaStore & {
  reels: ReelStore;
  releases?: ReturnType<typeof createReleaseStore>;
  briefing?: ReturnType<typeof createMongoBriefing>;
  reminders?: ReturnType<typeof createMongoReminders>;
  news?: ReturnType<typeof createMongoNews>;
} => {
  const client = dependencies.client ?? new MongoClient(input.uri, mongoClientOptions);
  const database = client.db(input.databaseName);
  const context: MongoContext = {
    client,
    collections: getCollections(database),
    protectIdentifier: input.protectIdentifier,
    logger: input.logger,
  };
  const news = input.news ? createMongoNews(context, input.news) : undefined;
  const settings = createMongoSettings(context);
  const conversations = createMongoConversations(context, input.requestLeaseMs);
  const accounting = (dependencies.createAccounting ?? createMongoAccounting)(context, input);

  const initialize = async () => {
    try {
      await client.connect();
      await createIndexes(context.collections);
      await news?.initialize();
      await database.command({ ping: 1 }, { timeoutMS: mongoOperationTimeoutMs });
      await accounting.recoverExpiredRequests();
      accounting.startRecovery();
      input.logger.info({
        event: 'mongodb_connected',
        database: input.databaseName,
        instanceKey: input.protectIdentifier(input.instanceId),
      });
    } catch (error) {
      await accounting.stopRecovery();
      await client.close().catch(() => undefined);
      throw error;
    }
  };

  const close = async () => {
    await accounting.stopRecovery();
    await client.close();
  };

  return {
    reels: createMongoReels(context),
    ...(input.secret
      ? {
          releases: createReleaseStore(database, input.secret),
          reminders: createMongoReminders(context, { secret: input.secret }),
          briefing: createMongoBriefing(context, input.secret),
        }
      : {}),
    ...(news ? { news } : {}),
    initialize,
    close,
    ...settings,
    ...conversations,
    authorizeTurn: accounting.authorizeTurn,
    settleRequest: accounting.settleRequest,
    failRequest: accounting.failRequest,
    getBudgetSummary: accounting.getBudgetSummary,
    getUsageSummary: accounting.getUsageSummary,
  };
};
