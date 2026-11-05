/**
 * The tokens that stand for "signed in".
 *
 * The token itself is random and only ever lives in the browser cookie. What
 * reaches the database is its SHA-256, so a copy of the table tells an
 * attacker nothing they can sign in with.
 *
 * The cookie is `httpOnly`, so a script on the page cannot read it either.
 */

import { createHash, randomBytes } from 'node:crypto';

/** 32 random bytes, as url-safe text. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The hash of a token — what the database stores. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** How long a sign-in lasts. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** When a token minted now stops working. */
export function expiryFromNow(now = Date.now()): string {
  return new Date(now + SESSION_TTL_SECONDS * 1000).toISOString();
}

/** Whether an expiry is still in the future. */
export function isLive(expiresAt: string, now = Date.now()): boolean {
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at > now;
}
