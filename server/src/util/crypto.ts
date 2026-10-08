import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest();
export const sha256hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** AES-256-GCM encryption for secrets stored in the database (mailbox OAuth tokens). */
export function encryptSecret(plaintext: string, aad: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.tokenKey, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ct]);
}

export function decryptSecret(blob: Buffer, aad: string): string {
  if (blob[0] !== 1) throw new Error('unknown secret format');
  const iv = blob.subarray(1, 13);
  const tag = blob.subarray(13, 29);
  const decipher = createDecipheriv('aes-256-gcm', config.tokenKey, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]).toString('utf8');
}

export function hmac(data: string) {
  return createHmac('sha256', config.urlKey).update(data).digest('base64url');
}

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
