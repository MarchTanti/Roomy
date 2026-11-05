/**
 * Database entry point.
 *
 * Every caller imports `getDb()` from here and never knows which adapter is
 * live. `DB_ADAPTER=supabase` with both Supabase credentials present switches
 * the whole app to Postgres; otherwise it stays on the zero-credential local
 * JSON files.
 */

import { dbAdapter, hasSupabase, NoWritableStorageError } from '../env';
import { canStoreLocally, createLocalDbClient } from './local';
import { createSupabaseDbClient } from './supabase';
import type { DbClient } from './types';

let cached: DbClient | null = null;

/**
 * The reason this server cannot keep a session, or null when it can.
 *
 * The local adapter writes JSON files. A serverless instance keeps its files
 * read-only apart from `/tmp`, and `/tmp` is thrown away with the instance:
 * a session written there would be gone before anyone came back. So on such a
 * server the local adapter is not a fallback — it is a missing setting, and
 * the app says which one instead of failing with "permission denied" from
 * the filesystem.
 */
function storageProblem(): { key: string; detail: string } | null {
  if (process.env.VERCEL !== '1') return null;

  if (dbAdapter() === 'supabase') {
    if (hasSupabase()) return null;
    return {
      key: 'SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY',
      detail:
        'DB_ADAPTER is "supabase" but the Supabase keys are not both set, so the app fell back to the local adapter — and this server cannot keep files between requests. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then deploy again.',
    };
  }

  return {
    key: 'DB_ADAPTER',
    detail:
      'DB_ADAPTER is not "supabase", so the app fell back to the local adapter — and this server cannot keep files between requests. Set DB_ADAPTER=supabase, with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then deploy again.',
  };
}

export function getDb(): DbClient {
  if (cached) return cached;

  const problem = storageProblem();
  if (problem) throw new NoWritableStorageError(problem.key, problem.detail);

  cached = dbAdapter() === 'supabase' && hasSupabase() ? createSupabaseDbClient() : createLocalDbClient();
  return cached;
}

/** Which adapter is active, for the status page and the README. */
export function activeAdapter(): 'local' | 'supabase' {
  return dbAdapter() === 'supabase' && hasSupabase() ? 'supabase' : 'local';
}

/**
 * Whether this server can keep a session in the local adapter.
 *
 * Two things have to hold: the filesystem has to accept a write, and the
 * platform has to keep the file. A serverless instance passes the first (in
 * `/tmp`) and fails the second — `/tmp` goes away with the instance — so the
 * platform is asked first and the filesystem second.
 */
export async function canKeepLocalSessions(): Promise<boolean> {
  if (process.env.VERCEL === '1') return false;
  return canStoreLocally();
}

/** Test seam: drop the memoised client. */
export function resetDb(): void {
  cached = null;
}

export type { DbClient };
export * from './types';