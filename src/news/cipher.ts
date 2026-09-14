import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { NewsDestination, NewsEncryptedDestination, NewsFeed } from './types.js';

export class NewsDecryptionError extends Error {
  constructor() {
    super('News destination authentication failed; reconfigure the affected subscription');
    this.name = 'NewsDecryptionError';
  }
}

export const createNewsCipher = (secret: string) => {
  if (!secret.trim()) throw new Error('News encryption requires a deployment secret');
  const derive = (purpose: string) =>
    Buffer.from(hkdfSync('sha256', secret, 'jolanda/news/v1', purpose, 32));
  const encryptionKey = derive('destination-encryption');
  const lookupKey = derive('identifier-lookup');
  const hash = (domain: string, values: string[]) =>
    createHmac('sha256', lookupKey)
      .update(JSON.stringify([domain, ...values]))
      .digest('hex');
  const context = (key: string, revision: number) =>
    Buffer.from(JSON.stringify(['jolanda/news/destination', 1, key, revision]));
  const encrypt = (destination: NewsDestination, key: string, revision: number) => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
    cipher.setAAD(context(key, revision));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(destination), 'utf8'),
      cipher.final(),
    ]);
    return {
      version: 1 as const,
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  };
  const decrypt = (value: NewsEncryptedDestination, key: string, revision: number) => {
    try {
      if (value.version !== 1) throw new NewsDecryptionError();
      const nonce = Buffer.from(value.nonce, 'base64');
      const tag = Buffer.from(value.tag, 'base64');
      if (nonce.length !== 12 || tag.length !== 16) throw new NewsDecryptionError();
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, nonce);
      decipher.setAAD(context(key, revision));
      decipher.setAuthTag(tag);
      const destination: unknown = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(value.ciphertext, 'base64')),
          decipher.final(),
        ]).toString('utf8'),
      );
      if (
        !destination ||
        typeof destination !== 'object' ||
        !('guildId' in destination) ||
        typeof destination.guildId !== 'string' ||
        !('channelId' in destination) ||
        typeof destination.channelId !== 'string' ||
        ('notifyRoleId' in destination && typeof destination.notifyRoleId !== 'string')
      )
        throw new NewsDecryptionError();
      return destination as NewsDestination;
    } catch {
      throw new NewsDecryptionError();
    }
  };
  return {
    encrypt,
    decrypt,
    guildKey: (guildId: string) => hash('guild', [guildId]),
    subscriptionKey: (guildId: string, feed: NewsFeed) => hash('subscription', [guildId, feed]),
    messageKey: (messageId: string) => hash('message', [messageId]),
    keyVerifier: hash('deployment-key-verifier', []),
  };
};
