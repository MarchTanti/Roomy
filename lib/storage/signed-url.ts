/**
 * Signed-URL helper.
 *
 * Per the spec: "Photos live in a private bucket, served with signed URLs that
 * expire in 1 hour." This module reads the TTL from `settings.signedUrlTtlSeconds()`
 * (default 3600s) so changing the lifetime is an env-var edit, not a code change.
 *
 * Two entry points:
 *   - `signedUrlFor(path)`  — sign one path. Returns `{ url, expiresAt }`.
 *   - `signedUrlsFor(paths)` — bulk sign. Empty list returns []. The caller does
 *                              not get partial successes; we throw on any failure.
 */

import { createClient } from '@supabase/supabase-js';

import { settings } from '../env';

export interface SignedUrl {
  path: string;
  url: string;
  expiresAt: Date;
}

export class SignedUrlError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'SignedUrlError';
  }
}

let cachedClient: ReturnType<typeof createClient> | null = null;

/** Internal: service-role storage client. Memoised per process. */
function storageClient(): ReturnType<typeof createClient> {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new SignedUrlError(
      'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set. Cannot create storage client.',
    );
  }
  cachedClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedClient;
}

/** Test seam: drop the memoised client (e.g. between vitest runs). */
export function _resetStorageClient(): void {
  cachedClient = null;
}

export async function signedUrlFor(path: string): Promise<SignedUrl> {
  const ttl = settings.signedUrlTtlSeconds();
  const { data, error } = await storageClient()
    .storage.from('room-photos')
    .createSignedUrl(path, ttl);
  if (error || !data?.signedUrl) {
    throw new SignedUrlError(
      `Failed to sign "${path}": ${error?.message ?? 'no signedUrl returned'}`,
    );
  }
  return {
    path,
    url: data.signedUrl,
    expiresAt: new Date(Date.now() + ttl * 1000),
  };
}

export async function signedUrlsFor(paths: readonly string[]): Promise<SignedUrl[]> {
  if (paths.length === 0) return [];
  const ttl = settings.signedUrlTtlSeconds();
  const { data, error } = await storageClient()
    .storage.from('room-photos')
    .createSignedUrls([...paths], ttl);
  if (error || !data) {
    throw new SignedUrlError(
      `Bulk sign failed: ${error?.message ?? 'no data returned'}`,
    );
  }
  const byPath = new Map(data.map((row) => [row.path ?? '', row]));
  return paths.map((p) => {
    const row = byPath.get(p);
    if (!row?.signedUrl) {
      throw new SignedUrlError(`No signed URL returned for "${p}"`);
    }
    return { path: p, url: row.signedUrl, expiresAt: new Date(Date.now() + ttl * 1000) };
  });
}
