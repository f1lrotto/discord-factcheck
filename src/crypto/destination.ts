import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

export type EncryptedDestination = {
  version: 1;
  nonce: string;
  ciphertext: string;
  tag: string;
};

/**
 * Authenticated routing-identifier storage shared by every feature that must deliver to a
 * Discord channel from a background worker without persisting a raw identifier.
 *
 * `namespace` and `aadDomain` are part of the wire format: changing either for an existing
 * feature makes previously stored destinations undecryptable. Each feature owns its own pair.
 */
export const createDestinationCipher = <T>(options: {
  secret: string;
  namespace: string;
  aadDomain: string;
  parse: (value: unknown) => T | null;
  reject: () => never;
}) => {
  const derive = (purpose: string) =>
    Buffer.from(hkdfSync('sha256', options.secret, options.namespace, purpose, 32));
  const encryptionKey = derive('destination-encryption');
  const lookupKey = derive('identifier-lookup');
  const hash = (domain: string, values: readonly string[]) =>
    createHmac('sha256', lookupKey)
      .update(JSON.stringify([domain, ...values]))
      .digest('hex');
  const context = (key: string, revision: number) =>
    Buffer.from(JSON.stringify([options.aadDomain, 1, key, revision]));

  const encrypt = (destination: T, key: string, revision: number): EncryptedDestination => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
    cipher.setAAD(context(key, revision));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(destination), 'utf8'),
      cipher.final(),
    ]);
    return {
      version: 1,
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  };

  const decrypt = (value: EncryptedDestination, key: string, revision: number): T => {
    try {
      if (value.version !== 1) options.reject();
      const nonce = Buffer.from(value.nonce, 'base64');
      const tag = Buffer.from(value.tag, 'base64');
      if (nonce.length !== 12 || tag.length !== 16) options.reject();
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, nonce);
      decipher.setAAD(context(key, revision));
      decipher.setAuthTag(tag);
      const parsed: unknown = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(value.ciphertext, 'base64')),
          decipher.final(),
        ]).toString('utf8'),
      );
      const destination = options.parse(parsed);
      if (destination === null) options.reject();
      return destination;
    } catch {
      options.reject();
    }
  };

  return { encrypt, decrypt, hash, keyVerifier: hash('deployment-key-verifier', []) };
};
