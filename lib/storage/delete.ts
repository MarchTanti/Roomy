/**
 * Delete one photo from the private bucket.
 *
 * Separate from `upload-room-photo.ts` because the Supabase client is already
 * memoised there, and a second memoised client would just double the open
 * connection pool.
 */

import { createClient } from '@supabase/supabase-js';

import { isUuid } from './keys';

export class DeleteError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'DeleteError';
  }
}

let cachedClient: ReturnType<typeof createClient> | null = null;

function storageClient(): ReturnType<typeof createClient> {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new DeleteError('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  }
  cachedClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedClient;
}

export function _resetDeleteStorageClient(): void {
  cachedClient = null;
}

export async function removeRoomPhoto(path: string): Promise<void> {
  const { error } = await storageClient().storage.from('room-photos').remove([path]);
  if (error) {
    throw new DeleteError(`Failed to remove "${path}": ${error.message}`, error);
  }
}

/**
 * Removes every photo of one session from the private bucket.
 *
 * The photos of a session live under `<session_id>/`, so the folder is listed
 * and removed as a set. The Storage API has no "delete a prefix" call, so the
 * listing is explicit — and paged, because a session with many generations
 * holds more objects than one page of the listing.
 *
 * Returns how many objects were removed.
 */
export async function removeRoomPhotoFolder(sessionId: string): Promise<number> {
  if (!isUuid(sessionId)) {
    throw new DeleteError(`Not a session id: "${sessionId}"`);
  }

  const bucket = storageClient().storage.from('room-photos');
  const pageSize = 1000;
  const paths: string[] = [];

  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await bucket.list(sessionId, { limit: pageSize, offset });
    if (error) {
      throw new DeleteError(
        `Failed to list the photos of session "${sessionId}": ${error.message}`,
        error,
      );
    }
    const page = data ?? [];
    for (const item of page) {
      if (item.name) paths.push(`${sessionId}/${item.name}`);
    }
    if (page.length < pageSize) break;
  }

  if (paths.length === 0) return 0;

  // The API takes a batch, and a session with hundreds of photos would need
  // more than one call.
  for (let i = 0; i < paths.length; i += 100) {
    const batch = paths.slice(i, i + 100);
    const { error } = await bucket.remove(batch);
    if (error) {
      throw new DeleteError(
        `Failed to remove the photos of session "${sessionId}": ${error.message}`,
        error,
      );
    }
  }

  return paths.length;
}