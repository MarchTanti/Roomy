/**
 * Deleting a session: the photos and the rows, together or not at all.
 *
 * These are the tests for the promise the privacy bar makes — "delete
 * everything" has to actually delete everything. So they run against the real
 * local adapter and the real local photo store: the assertions are about files
 * on disk and rows in the database, not about a return value.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DbClient } from '@/lib/db/types';
import type { PhotoStore } from '@/lib/storage/store';

// lib/db/local.ts snapshots ROOMY_DATA_DIR at import time, so the assignment
// and every import that reaches the DB have to happen dynamically, in this
// order.
const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'roomy-purge-'));
process.env.ROOMY_DATA_DIR = DATA_DIR;
delete process.env.DB_ADAPTER;
delete process.env.GEMINI_API_KEY;

let getDb: () => DbClient;
let resetDb: () => void;
let purgeSession: (db: DbClient, id: string, store?: PhotoStore) => Promise<{ photos_deleted: number }>;
let purgeExpiredSessions: (
  db: DbClient,
  days: number,
  store?: PhotoStore,
  now?: Date,
) => Promise<{ sessions_deleted: number; photos_deleted: number; failures: { session_id: string }[] }>;
let PurgeError: new (message: string, cause?: unknown) => Error;
let getPhotoStore: () => PhotoStore;

beforeAll(async () => {
  ({ getDb, resetDb } = await import('@/lib/db'));
  ({ purgeSession, purgeExpiredSessions, PurgeError } = await import('@/lib/session/purge'));
  ({ getPhotoStore } = await import('@/lib/storage/store'));
});

beforeEach(() => {
  resetDb();
});

/** A session with `count` photos on disk. */
async function sessionWithPhotos(count: number): Promise<string> {
  const db = getDb();
  const session = await db.createSession();
  for (let i = 0; i < count; i += 1) {
    const imageId = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
    await db.addImage({
      session_id: session.id,
      kind: 'room',
      storage_path: `${session.id}/${imageId}.jpg`,
    });
    const dir = path.join(DATA_DIR, 'uploads', session.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${imageId}.jpg`), 'bytes');
  }
  return session.id;
}

function uploadsDir(sessionId: string): string {
  return path.join(DATA_DIR, 'uploads', sessionId);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

describe('purgeSession', () => {
  it('removes the photos and the rows', async () => {
    const db = getDb();
    const sessionId = await sessionWithPhotos(2);

    const result = await purgeSession(db, sessionId);

    expect(result.photos_deleted).toBe(2);
    expect(await exists(uploadsDir(sessionId))).toBe(false);
    expect(await db.getSession(sessionId)).toBeNull();
    expect(await db.listImages(sessionId)).toEqual([]);
    expect(await db.listMessages(sessionId)).toEqual([]);
  });

  it('removes the messages of the session too', async () => {
    const db = getDb();
    const sessionId = await sessionWithPhotos(0);
    await db.addMessage(sessionId, { role: 'user', content: { role: 'user', parts: [] } });

    await purgeSession(db, sessionId);

    expect(await db.listMessages(sessionId)).toEqual([]);
  });

  it('leaves other sessions alone', async () => {
    const db = getDb();
    const mine = await sessionWithPhotos(1);
    const theirs = await sessionWithPhotos(1);

    await purgeSession(db, mine);

    expect(await exists(uploadsDir(theirs))).toBe(true);
    expect(await db.getSession(theirs)).not.toBeNull();
  });

  it('keeps the rows when the photos cannot be removed', async () => {
    // The order matters: photos first, rows second. A storage failure must
    // not leave a session that looks deleted but is not.
    const db = getDb();
    const sessionId = await sessionWithPhotos(1);

    const brokenStore: PhotoStore = {
      id: 'local',
      async put() {
        throw new Error('not used');
      },
      async get() {
        throw new Error('not used');
      },
      async remove() {
        throw new Error('not used');
      },
      async removeSession() {
        throw new Error('bucket is down');
      },
    };

    await expect(purgeSession(db, sessionId, brokenStore)).rejects.toBeInstanceOf(PurgeError);

    // The rows are still there — nothing was lost, and the user can retry.
    expect(await db.getSession(sessionId)).not.toBeNull();
    expect(await exists(uploadsDir(sessionId))).toBe(true);
  });

  it('falls back to the image rows when the store cannot delete a folder', async () => {
    const db = getDb();
    const sessionId = await sessionWithPhotos(2);

    const removed: string[] = [];
    const singleFileStore: PhotoStore = {
      id: 'local',
      async put() {
        throw new Error('not used');
      },
      async get() {
        throw new Error('not used');
      },
      async remove(storagePath) {
        removed.push(storagePath);
      },
    };

    const result = await purgeSession(db, sessionId, singleFileStore);

    expect(result.photos_deleted).toBe(2);
    expect(removed).toHaveLength(2);
    expect(removed.every((p) => p.startsWith(`${sessionId}/`))).toBe(true);
    expect(await db.getSession(sessionId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('purgeExpiredSessions', () => {
  /** Rewrites the sessions file so one session looks older than the cutoff. */
  async function ageSession(sessionId: string, days: number): Promise<void> {
    const file = path.join(DATA_DIR, 'sessions.json');
    const rows = JSON.parse(await fs.readFile(file, 'utf8')) as { id: string; created_at: string }[];
    const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    for (const row of rows) {
      if (row.id === sessionId) row.created_at = when;
    }
    await fs.writeFile(file, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  }

  it('deletes only the sessions older than the cutoff', async () => {
    const db = getDb();
    const old = await sessionWithPhotos(1);
    const fresh = await sessionWithPhotos(1);
    await ageSession(old, 30);

    const result = await purgeExpiredSessions(db, 7, getPhotoStore());

    expect(result.sessions_deleted).toBe(1);
    expect(result.photos_deleted).toBe(1);
    expect(result.failures).toEqual([]);
    expect(await db.getSession(old)).toBeNull();
    expect(await exists(uploadsDir(old))).toBe(false);
    expect(await db.getSession(fresh)).not.toBeNull();
    expect(await exists(uploadsDir(fresh))).toBe(true);
  });

  it('deletes nothing when every session is younger than the cutoff', async () => {
    const db = getDb();
    const sessionId = await sessionWithPhotos(1);

    const result = await purgeExpiredSessions(db, 7, getPhotoStore());

    expect(result.sessions_deleted).toBe(0);
    expect(await db.getSession(sessionId)).not.toBeNull();
  });

  it('keeps going when one session fails, and reports it', async () => {
    const db = getDb();
    const broken = await sessionWithPhotos(1);
    const good = await sessionWithPhotos(1);
    await ageSession(broken, 30);
    await ageSession(good, 30);

    // Only one session's folder is unreachable — the sweep has to get past it
    // and delete the other one.
    const flakyStore: PhotoStore = {
      id: 'local',
      async put() {
        throw new Error('not used');
      },
      async get() {
        throw new Error('not used');
      },
      async remove() {
        throw new Error('not used');
      },
      async removeSession(sessionId: string) {
        if (sessionId === broken) throw new Error('bucket is down');
        return 0;
      },
    };

    const result = await purgeExpiredSessions(db, 7, flakyStore);

    expect(result.sessions_deleted).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].session_id).toBe(broken);
    // The other session still went.
    expect(await db.getSession(good)).toBeNull();
    // And the failed one is still there, to be retried.
    expect(await db.getSession(broken)).not.toBeNull();
  });
});
