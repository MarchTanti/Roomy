/**
 * Deleting a session, for real.
 *
 * The rows and the photos live in two different places, and they have to go
 * together: a deleted session whose room photo is still in the bucket is not a
 * deletion, it is a photo the user asked to be rid of and cannot get rid of.
 *
 * So the photos go **first**, and the rows only go once the files are gone. If
 * the storage removal fails, the rows stay — a session the user can delete
 * again (and the cleanup can retry) beats a half-deleted one that nothing can
 * clean up afterwards.
 *
 * The same code serves the "delete everything" button and the 7-day retention
 * sweep, so the two can never disagree about what a deletion means.
 */

import type { DbClient } from '../db/types';
import { getPhotoStore, type PhotoStore } from '../storage/store';

export class PurgeError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'PurgeError';
  }
}

export interface PurgeResult {
  session_id: string;
  /** How many photo files were removed from storage. */
  photos_deleted: number;
  /** False when the photos could not be removed and the rows were kept. */
  session_deleted: boolean;
}

export interface ExpiredPurgeResult {
  sessions_deleted: number;
  photos_deleted: number;
  /** Sessions that could not be purged, and why. */
  failures: { session_id: string; error: string }[];
}

/**
 * Removes one session: its photos first, then its rows.
 *
 * Throws `PurgeError` when the photos could not be removed — the rows are then
 * left untouched, and the caller can tell the user that nothing was lost.
 */
export async function purgeSession(
  db: DbClient,
  sessionId: string,
  store: PhotoStore = getPhotoStore(),
): Promise<PurgeResult> {
  let photos = 0;

  try {
    photos = await removePhotos(db, sessionId, store);
  } catch (err) {
    throw new PurgeError(
      `Could not remove the photos of session "${sessionId}": ${
        err instanceof Error ? err.message : 'unknown error'
      }`,
      err,
    );
  }

  await db.deleteSession(sessionId);

  return { session_id: sessionId, photos_deleted: photos, session_deleted: true };
}

/**
 * Removes every session created before the retention cutoff.
 *
 * One failing session does not stop the sweep: the others are still worth
 * deleting, and the failure is reported so it can be looked at.
 */
export async function purgeExpiredSessions(
  db: DbClient,
  days: number,
  store: PhotoStore = getPhotoStore(),
  now: Date = new Date(),
): Promise<ExpiredPurgeResult> {
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const ids = await db.listSessionIdsCreatedBefore(cutoff);

  const result: ExpiredPurgeResult = { sessions_deleted: 0, photos_deleted: 0, failures: [] };

  for (const id of ids) {
    try {
      const purged = await purgeSession(db, id, store);
      result.sessions_deleted += 1;
      result.photos_deleted += purged.photos_deleted;
    } catch (err) {
      result.failures.push({
        session_id: id,
        error: err instanceof Error ? err.message : 'unknown error',
      });
    }
  }

  return result;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Removes the photos of a session.
 *
 * A store that can delete a whole folder does it in one call. One that cannot
 * falls back to the image rows — the database still knows every photo of the
 * session, so the files can be removed one by one.
 */
async function removePhotos(
  db: DbClient,
  sessionId: string,
  store: PhotoStore,
): Promise<number> {
  if (store.removeSession) return store.removeSession(sessionId);

  const images = await db.listImages(sessionId);
  let removed = 0;
  for (const image of images) {
    await store.remove(image.storage_path);
    removed += 1;
  }
  return removed;
}
