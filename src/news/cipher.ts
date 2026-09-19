import { createDestinationCipher } from '../crypto/destination.js';
import type { NewsDestination, NewsEncryptedDestination, NewsFeed } from './types.js';

export class NewsDecryptionError extends Error {
  constructor() {
    super('News destination authentication failed; reconfigure the affected subscription');
    this.name = 'NewsDecryptionError';
  }
}

const parseNewsDestination = (value: unknown) =>
  value &&
  typeof value === 'object' &&
  'guildId' in value &&
  typeof value.guildId === 'string' &&
  'channelId' in value &&
  typeof value.channelId === 'string' &&
  !('notifyRoleId' in value && typeof value.notifyRoleId !== 'string')
    ? (value as NewsDestination)
    : null;

export const createNewsCipher = (secret: string) => {
  if (!secret.trim()) throw new Error('News encryption requires a deployment secret');
  // These namespace strings are the stored wire format; changing them orphans destinations.
  const cipher = createDestinationCipher({
    secret,
    namespace: 'jolanda/news/v1',
    aadDomain: 'jolanda/news/destination',
    parse: parseNewsDestination,
    reject: () => {
      throw new NewsDecryptionError();
    },
  });
  return {
    encrypt: (destination: NewsDestination, key: string, revision: number) =>
      cipher.encrypt(destination, key, revision) satisfies NewsEncryptedDestination,
    decrypt: (value: NewsEncryptedDestination, key: string, revision: number) =>
      cipher.decrypt(value, key, revision),
    guildKey: (guildId: string) => cipher.hash('guild', [guildId]),
    subscriptionKey: (guildId: string, feed: NewsFeed) =>
      cipher.hash('subscription', [guildId, feed]),
    messageKey: (messageId: string) => cipher.hash('message', [messageId]),
    keyVerifier: cipher.keyVerifier,
  };
};
