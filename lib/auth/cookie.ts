/**
 * The signed-in cookie.
 *
 * One cookie, `httpOnly`, holding an opaque token. The browser cannot read it
 * (so a script on the page cannot steal it) and it is not a JWT (so there is
 * nothing in it to decode and nothing to keep in sync).
 *
 * The cookie is read from the request's own headers rather than from
 * `next/headers`, so a route handler works the same way in a test as it does
 * on a server. The server components still use `cookies()`, which is the only
 * way to reach the request from there.
 */

import { cookies } from 'next/headers';

import { SESSION_TTL_SECONDS } from './tokens';

export const AUTH_COOKIE = 'roomy_session';

/** The token in a `Cookie:` header, if it is there. */
export function tokenFromCookieHeader(header: string | null | undefined): string | null {
  if (!header) return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (name !== AUTH_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return null;
}

/**
 * The token of whoever is signed in.
 *
 * A route handler passes its request; a server component leaves it out.
 */
export async function readAuthToken(request?: Request): Promise<string | null> {
  if (request) return tokenFromCookieHeader(request.headers.get('cookie'));
  const store = await cookies();
  return store.get(AUTH_COOKIE)?.value ?? null;
}

/** The `Set-Cookie` value that signs someone in. */
export function authCookieHeader(token: string): string {
  const parts = [
    `${AUTH_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  // The dev server runs on plain http, where a secure cookie is dropped.
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

/** The `Set-Cookie` value that signs someone out. */
export function clearAuthCookieHeader(): string {
  return `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
