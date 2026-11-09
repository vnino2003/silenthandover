import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encrypts secrets an administrator enters in the app (the AI provider's API key) before they
 * are stored. AES-256-GCM: a stolen database copy without SECRETS_ENCRYPTION_KEY reveals nothing,
 * and a tampered value fails to open instead of decrypting to garbage.
 */
export interface SecretBox {
  seal(plain: string): string;
  open(sealed: string): string;
}

const VERSION = 'v1';

export function createSecretBox(key: Buffer): SecretBox {
  if (key.length !== 32) throw new Error('SECRETS_ENCRYPTION_KEY must decode to exactly 32 bytes');
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
    },
    open(sealed) {
      const [version, iv, tag, data] = sealed.split('.');
      if (version !== VERSION || !iv || !tag || !data) throw new Error('Unrecognised secret format');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
    },
  };
}

/** Accepts the key as base64 or base64url (`openssl rand -base64 32`). */
export function decodeSecretsKey(value: string): Buffer {
  return Buffer.from(value.trim().replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
