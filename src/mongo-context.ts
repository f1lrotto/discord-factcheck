import type { Logger } from 'pino';
import type { MongoClient } from 'mongodb';
import { mongoOperationTimeoutMs } from './limits.js';
import type { Collections } from './mongo-schema.js';

export const mongoOperationOptions = { timeoutMS: mongoOperationTimeoutMs } as const;

export type MongoContext = {
  client: MongoClient;
  collections: Collections;
  protectIdentifier: (identifier: string) => string;
  logger: Logger;
};
