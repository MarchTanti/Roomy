/**
 * Photo storage adapter.
 *
 * Mirrors `lib/db/index.ts`: callers import `getPhotoStore()` and never know
 * which one is live. `local` writes under `.data/uploads/` with zero
 * credentials so the upload flow is runnable without a Supabase project; the
 * `supabase` store talks to the private `room-photos` bucket.
 *
 * Both stores expose the same two operations and neither one hands out a URL on
 * its own. Producing a URL is the caller's decision, because only the Supabase
 * store can produce a *signed* one, and a plain public URL would defeat the
 * spec's "private bucket, signed URLs that expire in 1 hour".
 */

import { mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { hasSupabase, settings } from '../env';
import { imageKey, isUuid, parseImageKey } from './keys';
import { downloadRoomPhoto } from './download';
import { uploadRoomPhoto, type UploadedPhoto, type UploadOptions } from './upload-room-photo';
import { signedUrlFor, type SignedUrl } from './signed-url';

export class PhotoStoreError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'PhotoStoreError';
  }
}

export interface PhotoStore {
  readonly id: 'local' | 'supabase';
  put(sessionId: string, buffer: Buffer, opts?: UploadOptions): Promise<UploadedPhoto>;
  get(path: string, expectedSessionId?: string): Promise<Buffer>;
  /** Omitted by the local store — it has no signing key. */
  sign?(path: string): Promise<SignedUrl>;
  remove(path: string): Promise<void>;
  /**
   * Removes every photo of one session. Returns how many were removed.
   *
   * Optional: a store that cannot delete a whole folder falls back to removing
   * the files one by one, using the image rows the database still holds.
   */
  removeSession?(sessionId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// local — files under .data/uploads/, mirroring the local DB adapter
// ---------------------------------------------------------------------------

const SEP = '/';

/**
 * Resolved per call rather than cached in a module-level const.
 *
 * `lib/db/local.ts` snapshots ROOMY_DATA_DIR at import time, which is right for
 * it and wrong here: tests set the variable after import. Reading lazily keeps
 * both honest.
 */
function uploadsRoot(): string {
  return path.join(process.env.ROOMY_DATA_DIR ?? path.join(process.cwd(), '.data'), 'uploads');
}

/** Refuses anything that is not the `<session>/<image>.jpg` convention. */
function localPathFor(storagePath: string): string {
  parseImageKey(storagePath);
  return path.join(uploadsRoot(), ...storagePath.split(SEP));
}

/** True for the "no such file or directory" error. */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

const localStore: PhotoStore = {
  id: 'local',

  async put(sessionId: string, buffer: Buffer, opts: UploadOptions = {}): Promise<UploadedPhoto> {
    // Sharp still runs on this path, so EXIF is stripped here exactly as it is
    // in production. That is the one part of upload that must never be skipped
    // on the grounds that "it's only local".
    const { processUpload } = await import('./process-image');
    const processed = await processUpload(buffer, 'image/jpeg', opts);
    const imageId = opts.imageId ?? crypto.randomUUID();
    const storagePath = imageKey(sessionId, imageId);

    const target = localPathFor(storagePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, processed.buffer);

    return {
      path: storagePath,
      imageId,
      bytes: processed.bytes,
      width: processed.width,
      height: processed.height,
      contentType: 'image/jpeg',
      buffer: processed.buffer,
    };
  },

  async get(storagePath: string, expectedSessionId?: string): Promise<Buffer> {
    try {
      if (expectedSessionId !== undefined) {
        if (parseImageKey(storagePath).sessionId !== expectedSessionId) {
          throw new PhotoStoreError(`Photo "${storagePath}" does not belong to this session`);
        }
      }
      return await readFile(localPathFor(storagePath));
    } catch (err) {
      if (err instanceof PhotoStoreError) throw err;
      throw new PhotoStoreError(`Failed to read "${storagePath}"`, err);
    }
  },

  async remove(storagePath: string): Promise<void> {
    try {
      await unlink(localPathFor(storagePath));
    } catch {
      // Deleting a photo that is already gone is the outcome we wanted.
    }
  },

  async removeSession(sessionId: string): Promise<number> {
    if (!isUuid(sessionId)) {
      throw new PhotoStoreError(`Not a session id: "${sessionId}"`);
    }
    // The session id is the folder name under the uploads root, so it has to
    // be a UUID — anything else could walk out of that directory.
    const dir = path.join(uploadsRoot(), sessionId);

    let count = 0;
    try {
      count = (await readdir(dir)).length;
    } catch (err) {
      if (isNotFound(err)) return 0;
      throw new PhotoStoreError(`Failed to list the photos of "${sessionId}"`, err);
    }

    await rm(dir, { recursive: true, force: true });
    return count;
  },
};

// ---------------------------------------------------------------------------
// supabase — private bucket + service role (RLS does not apply)
// ---------------------------------------------------------------------------

const supabaseStore: PhotoStore = {
  id: 'supabase',

  async put(sessionId: string, buffer: Buffer, opts: UploadOptions = {}): Promise<UploadedPhoto> {
    return uploadRoomPhoto(sessionId, buffer, 'image/jpeg', opts);
  },

  async get(storagePath: string, expectedSessionId?: string): Promise<Buffer> {
    return downloadRoomPhoto(storagePath, expectedSessionId);
  },

  async sign(storagePath: string): Promise<SignedUrl> {
    return signedUrlFor(storagePath);
  },

  async remove(storagePath: string): Promise<void> {
    const { removeRoomPhoto } = await import('./delete');
    await removeRoomPhoto(storagePath);
  },

  async removeSession(sessionId: string): Promise<number> {
    const { removeRoomPhotoFolder } = await import('./delete');
    return removeRoomPhotoFolder(sessionId);
  },
};

// ---------------------------------------------------------------------------

let cached: PhotoStore | null = null;
let override: PhotoStore | null = null;

export function getPhotoStore(): PhotoStore {
  if (override) return override;
  if (cached) return cached;

  // Supabase when it is configured, local otherwise — so a project with the
  // bucket but `DB_ADAPTER=local` (development) still stores photos where the
  // vision call can read them back.
  if (hasSupabase() && process.env.PHOTO_STORE === 'local') {
    cached = localStore;
  } else if (hasSupabase()) {
    cached = supabaseStore;
  } else {
    cached = localStore;
  }
  return cached;
}

/** Test seam: force a store, or pass null to restore the real one. */
export function setPhotoStoreForTesting(store: PhotoStore | null): void {
  override = store;
}

export function resetPhotoStore(): void {
  cached = null;
  override = null;
}

export { imageKey, parseImageKey };
export { signedUrlFor, signedUrlsFor, SignedUrlError } from './signed-url';
export type { SignedUrl } from './signed-url';
export { processUpload, assertNoExif, readDimensions, ImageProcessingError } from './process-image';
export type { ProcessedImage, ProcessOptions, ProcessedContentType } from './process-image';
export { UploadError } from './upload-room-photo';
export type { UploadedPhoto, UploadOptions } from './upload-room-photo';
export { settings };