import { MongoClient, type MongoClientOptions } from 'mongodb';
import type { Logger } from 'pino';
import { createMongoAccounting } from './mongo-accounting.js';
import { createMongoConversations } from './mongo-conversations.js';
import type { MongoContext } from './mongo-context.js';
import { createIndexes, getCollections } from './mongo-schema.js';
import { createMongoSettings } from './mongo-settings.js';
import { mongoOperationTimeoutMs } from './limits.js';
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
    dailyLimitMicrodollars: number;
    monthlyLimitMicrodollars: number;
    promptsPerMinute: number;
    transcriptTtlMs: number;
    instanceId: string;
    protectIdentifier: (identifier: string) => string;
    logger: Logger;
    recoveryIntervalMs?: number;
    requestLeaseMs?: number;
  },
  dependencies: {
    client?: MongoClient;
    createAccounting?: typeof createMongoAccounting;
  } = {},
): JolandaStore => {
  const client = dependencies.client ?? new MongoClient(input.uri, mongoClientOptions);
  const database = client.db(input.databaseName);
  const context: MongoContext = {
    client,
    collections: getCollections(database),
    protectIdentifier: input.protectIdentifier,
    logger: input.logger,
  };
  const settings = createMongoSettings(context);
  const conversations = createMongoConversations(context, input.requestLeaseMs);
  const accounting = (dependencies.createAccounting ?? createMongoAccounting)(context, input);

  const initialize = async () => {
    try {
      await client.connect();
      await createIndexes(context.collections);
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
    initialize,
    close,
    ...settings,
    ...conversations,
    authorizeTurn: accounting.authorizeTurn,
    settleRequest: accounting.settleRequest,
    failRequest: accounting.failRequest,
    getBudgetSummary: accounting.getBudgetSummary,
  };
};
