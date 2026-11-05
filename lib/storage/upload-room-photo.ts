/**
 * Upload helper.
 *
 * Single entry point: `uploadRoomPhoto(sessionId, buffer, opts?)`. It:
 *   1. Runs the buffer through `processUpload` so EXIF is gone, dimensions
 *      fit the long-edge cap, and the format is JPEG.
 *   2. Generates a fresh `imageId` (UUID) and assembles the storage key
 *      `<session_id>/<image_id>.jpg` via `imageKey()`.
 *   3. Uploads via the service-role storage client (RLS does not apply).
 *   4. Returns `{ path, imageId, bytes, width, height, contentType }` —
 *      no URL, so nothing leaks into caller-side caches.
 */

import { randomUUID } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';

import { imageKey } from './keys';
import { processUpload, type ProcessedImage, type ProcessOptions } from './process-image';

const BUCKET = 'room-photos';

export interface UploadedPhoto {
  path: string;
  imageId: string;
  bytes: number;
  width: number;
  height: number;
  contentType: 'image/jpeg';
  /**
   * The exact bytes that were stored — EXIF-stripped and re-encoded.
   *
   * Returned rather than re-derived so the caller analyses the same image that
   * was persisted. It is tempting to analyse the original upload instead, which
   * silently ships the location metadata the pipeline just removed.
   */
  buffer: Buffer;
}

export class UploadError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'UploadError';
  }
}

let cachedClient: ReturnType<typeof createClient> | null = null;

function storageClient(): ReturnType<typeof createClient> {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new UploadError('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  }
  cachedClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedClient;
}

export function _resetUploadStorageClient(): void {
  cachedClient = null;
}

export interface UploadOptions extends ProcessOptions {
  /** Override the auto-generated imageId. Use only for tests. */
  imageId?: string;
}

export async function uploadRoomPhoto(
  sessionId: string,
  buffer: Buffer,
  originalContentType: string | undefined,
  opts: UploadOptions = {},
): Promise<UploadedPhoto> {
  let processed: ProcessedImage;
  try {
    processed = await processUpload(buffer, originalContentType, opts);
  } catch (err) {
    if (err instanceof Error && err.name === 'ImageProcessingError') throw err;
    throw new UploadError('Image processing failed', err);
  }

  const imageId = opts.imageId ?? randomUUID();
  const path = imageKey(sessionId, imageId);

  const { error } = await storageClient()
    .storage.from(BUCKET)
    .upload(path, processed.buffer, {
      cacheControl: 'private, max-age=3600',
      contentType: processed.contentType,
      upsert: false,
    });
  if (error) {
    throw new UploadError(`Storage upload failed for "${path}": ${error.message}`, error);
  }

  return {
    path,
    imageId,
    bytes: processed.bytes,
    width: processed.width,
    height: processed.height,
    contentType: 'image/jpeg',
    buffer: processed.buffer,
  };
}
