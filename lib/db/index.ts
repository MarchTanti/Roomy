/**
 * Database entry point.
 *
 * Every caller imports `getDb()` from here and never knows which adapter is
 * live. `DB_ADAPTER=supabase` with both Supabase credentials present switches
 * the whole app to Postgres; otherwise it stays on the zero-credential local
 * JSON files.
 */

import { dbAdapter, hasSupabase } from '../env';
import { createLocalDbClient } from './local';
import { createSupabaseDbClient } from './supabase';
import type { DbClient } from './types';

let cached: DbClient | null = null;

export function getDb(): DbClient {
  if (cached) return cached;
  cached = dbAdapter() === 'supabase' && hasSupabase() ? createSupabaseDbClient() : createLocalDbClient();
  return cached;
}

/** Which adapter is active, for the status page and the README. */
export function activeAdapter(): 'local' | 'supabase' {
  return dbAdapter() === 'supabase' && hasSupabase() ? 'supabase' : 'local';
}

/** Test seam: drop the memoised client. */
export function resetDb(): void {
  cached = null;
}

export type { DbClient };
export * from './types';