/**
 * Read a stored photo back out of the private bucket.
 *
 * Needed on the `analyzeRoom` tool path: the upload route already has the bytes
 * in memory, but when the model asks to look at the room again the only copy
 * left is in storage. Bytes come back as `inlineData` to the vision model, so
 * nothing here ever produces a URL a caller could cache or leak.
 */

import { createClient } from '@supabase/supabase-js';

import { parseImageKey } from './keys';

const BUCKET = 'room-photos';

export class DownloadError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'DownloadError';
  }
}

let cachedClient: ReturnType<typeof createClient> | null = null;

function storageClient(): ReturnType<typeof createClient> {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new DownloadError('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  }
  cachedClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedClient;
}

export function _resetDownloadStorageClient(): void {
  cachedClient = null;
}

/**
 * Fetches the bytes for one photo.
 *
 * `path` is checked against the `<session_id>/<image_id>.jpg` convention and
 * the expected session, so a caller cannot read another session's photo by
 * passing a path it was handed some other way.
 */
export async function downloadRoomPhoto(path: string, expectedSessionId?: string): Promise<Buffer> {
  let key: ReturnType<typeof parseImageKey>;
  try {
    key = parseImageKey(path);
  } catch (err) {
    throw new DownloadError('Refusing to read a path that is not a room photo', err);
  }
  if (expectedSessionId !== undefined && key.sessionId !== expectedSessionId) {
    throw new DownloadError(`Photo "${path}" does not belong to this session`);
  }

  const { data, error } = await storageClient().storage.from(BUCKET).download(path);
  if (error || !data) {
    throw new DownloadError(`Failed to read "${path}": ${error?.message ?? 'no data returned'}`, error);
  }

  return Buffer.from(await data.arrayBuffer());
}