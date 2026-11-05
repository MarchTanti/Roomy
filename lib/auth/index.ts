/**
 * The account layer.
 *
 * Everything above this file deals in one thing: an `AuthUser` and a token.
 * Which system holds the accounts is decided here, once:
 *
 *   - `DB_ADAPTER=supabase` → Supabase Auth
 *   - anything else          → our own email + password table
 *
 * `AUTH_MODE` can override that, for the case where the database is Supabase
 * but the accounts are meant to be ours (or the other way round).
 *
 * Whichever mode is in use, the browser holds the same thing: an opaque
 * `httpOnly` cookie. The token in it is ours, not the provider's, so the
 * signed-in state survives a provider that keeps no client session.
 */

import { activeAdapter, getDb } from '@/lib/db';
import { readEnv } from '@/lib/env';

import { LocalAuth } from './local';
import { SupabaseAuth } from './supabase';
import { expiryFromNow, hashToken, isLive, newSessionToken } from './tokens';
import {
  type AuthClient,
  type AuthMode,
  type AuthResult,
  type AuthUser,
} from './types';

export type { AuthClient, AuthMode, AuthResult, AuthUser };

/** The outcome of signing in: the user, and the token to put in the cookie. */
export interface AuthOutcome {
  ok: boolean;
  user: AuthUser | null;
  error: string | null;
  /** Only set when ok is true. */
  token: string | null;
}

let cachedMode: AuthMode | null = null;
let cachedClient: AuthClient | null = null;
/** Set once Supabase Auth turned out to be unusable, so we stop asking it. */
let useLocalFallback = false;

/** Which system holds the accounts. */
export function authMode(): AuthMode {
  if (cachedMode) return cachedMode;
  const configured = readEnv('AUTH_MODE');
  if (configured === 'local' || configured === 'supabase') {
    cachedMode = configured;
    return cachedMode;
  }
  cachedMode = activeAdapter() === 'supabase' ? 'supabase' : 'local';
  return cachedMode;
}

/** The client for the current mode. */
export function getAuthClient(): AuthClient {
  if (cachedClient) return cachedClient;

  if (authMode() === 'supabase' && !useLocalFallback) {
    try {
      cachedClient = SupabaseAuth.fromEnv(getDb());
      return cachedClient;
    } catch {
      // No anon key, or Supabase is unreachable at startup. Our own accounts
      // still work, so the app carries on rather than refusing to start.
      useLocalFallback = true;
    }
  }

  cachedClient = new LocalAuth(getDb());
  return cachedClient;
}

/**
 * Runs an operation, and falls back to our own accounts when Supabase Auth is
 * not switched on.
 *
 * The fallback is one-way for the life of the process: a project without Auth
 * does not grow one while the server is up, and asking again each time would
 * add a round trip to every sign-in attempt.
 */
async function withFallback(
  run: (client: AuthClient) => Promise<AuthResult>,
): Promise<AuthResult> {
  const client = getAuthClient();
  const result = await run(client);

  if (result.ok || !result.providerUnavailable) return result;
  if (client.mode !== 'supabase') return result;

  useLocalFallback = true;
  cachedClient = new LocalAuth(getDb());
  return run(cachedClient);
}

/** Mints a token and stores its hash. */
async function issueToken(userId: string): Promise<string> {
  const token = newSessionToken();
  await getDb().createAuthSession({
    user_id: userId,
    token_hash: hashToken(token),
    expires_at: expiryFromNow(),
  });
  return token;
}

/** Creates an account and signs the person in. */
export async function signUp(email: string, password: string): Promise<AuthOutcome> {
  const result = await withFallback((client) => client.register(email, password));
  if (!result.ok || !result.user) {
    return { ok: false, user: null, error: result.error, token: null };
  }
  return { ok: true, user: result.user, error: null, token: await issueToken(result.user.id) };
}

/** Signs an existing person in. */
export async function signIn(email: string, password: string): Promise<AuthOutcome> {
  const result = await withFallback((client) => client.login(email, password));
  if (!result.ok || !result.user) {
    return { ok: false, user: null, error: result.error, token: null };
  }
  return { ok: true, user: result.user, error: null, token: await issueToken(result.user.id) };
}

/**
 * The account a token belongs to.
 *
 * A token that was revoked, or that has expired, or whose account is gone,
 * signs nobody in — quietly, and without an error the page has to show.
 */
export async function resolveUserByToken(token: string | null | undefined): Promise<AuthUser | null> {
  if (!token) return null;

  try {
    const db = getDb();
    const session = await db.getAuthSessionByTokenHash(hashToken(token));
    if (!session || session.revoked_at) return null;
    if (!isLive(session.expires_at)) return null;

    const user = await db.getUser(session.user_id);
    if (!user) return null;

    return {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      provider: user.provider,
      created_at: user.created_at,
    };
  } catch {
    // The account tables are not there yet (the migration has not been
    // applied). Nobody is signed in, and the chat carries on as a guest.
    return null;
  }
}

/** Ends a signed-in session. The token stops working straight away. */
export async function endSession(token: string | null | undefined): Promise<void> {
  if (!token) return;
  try {
    const db = getDb();
    const session = await db.getAuthSessionByTokenHash(hashToken(token));
    if (session) await db.revokeAuthSession(session.id);
  } catch {
    // Nothing to end.
  }
}

/** Drops the memoised client. A test seam. */
export function resetAuth(): void {
  cachedMode = null;
  cachedClient = null;
  useLocalFallback = false;
}
