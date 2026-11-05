/**
 * Password hashing.
 *
 * scrypt from Node's own crypto — no extra dependency, and it is the right
 * tool: it is slow on purpose and it needs a lot of memory, so guessing a
 * password costs the attacker far more than it costs us.
 *
 * The stored form is `scrypt$<salt hex>$<hash hex>`. The salt is per user and
 * the parameters live inside the hash, so an old row keeps verifying after the
 * defaults change.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

const SALT_BYTES = 16;
const KEY_BYTES = 64;

/** scrypt with a promise, without fighting the callback overloads. */
function scrypt(password: string, salt: Buffer, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** Hashes a password. The result is safe to store. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, KEY_BYTES);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

/**
 * Checks a password against a stored hash.
 *
 * Returns false for anything that is not a hash we wrote — a missing hash, a
 * hash from an older scheme, a row that was hand-edited. A wrong password and
 * an unreadable hash give the same answer, so the caller cannot tell them
 * apart.
 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored) return false;

  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = await scrypt(password, salt, expected.length);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
