/**
 * `DELETE /api/session` — the "delete everything" button.
 *
 * The button in the privacy bar promises that the room photo goes too, so the
 * test checks the filesystem and not just the response. The storage-failure
 * case matters as much: a session that looks deleted but is not would be
 * worse than one that visibly failed.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DbClient } from '@/lib/db/types';
import type { PhotoStore } from '@/lib/storage/store';

const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'roomy-session-delete-'));
process.env.ROOMY_DATA_DIR = DATA_DIR;
delete process.env.DB_ADAPTER;
delete process.env.GEMINI_API_KEY;

type RouteHandler = (request: Request) => Promise<Response>;

let DELETE: RouteHandler;
let POST: RouteHandler;
let GET: RouteHandler;
let getDb: () => DbClient;
let resetDb: () => void;
let setPhotoStoreForTesting: (store: PhotoStore | null) => void;
let resetPhotoStore: () => void;

beforeAll(async () => {
  ({ DELETE, POST, GET } = await import('@/app/api/session/route'));
  ({ getDb, resetDb } = await import('@/lib/db'));
  ({ setPhotoStoreForTesting, resetPhotoStore } = await import('@/lib/storage/store'));
});

beforeEach(() => {
  resetDb();
  resetPhotoStore();
  setPhotoStoreForTesting(null);
});

async function newSessionId(): Promise<string> {
  const res = await POST(new Request('http://localhost/api/session', { method: 'POST' }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { session_id: string }).session_id;
}

/** A session with one photo on disk. */
async function sessionWithPhoto(): Promise<string> {
  const db = getDb();
  const sessionId = await newSessionId();
  const imageId = '00000000-0000-4000-8000-000000000099';
  await db.addImage({
    session_id: sessionId,
    kind: 'room',
    storage_path: `${sessionId}/${imageId}.jpg`,
  });
  const dir = path.join(DATA_DIR, 'uploads', sessionId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${imageId}.jpg`), 'bytes');
  return sessionId;
}

function deleteRequest(sessionId: string): Request {
  return new Request(`http://localhost/api/session?session_id=${sessionId}`, { method: 'DELETE' });
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

describe('DELETE /api/session', () => {
  it('deletes the session, its photos and its messages', async () => {
    const db = getDb();
    const sessionId = await sessionWithPhoto();
    await db.addMessage(sessionId, { role: 'user', content: { role: 'user', parts: [] } });

    const res = await DELETE(deleteRequest(sessionId));

    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { deleted: boolean; photos_deleted: number };
    expect(body.deleted).toBe(true);
    expect(body.photos_deleted).toBe(1);

    expect(await db.getSession(sessionId)).toBeNull();
    expect(await db.listMessages(sessionId)).toEqual([]);
    expect(await exists(path.join(DATA_DIR, 'uploads', sessionId))).toBe(false);
  });

  it('404s an unknown session', async () => {
    const res = await DELETE(deleteRequest('00000000-0000-4000-8000-000000000000'));
    expect(res.status).toBe(404);
  });

  it('400s a missing session id', async () => {
    const res = await DELETE(new Request('http://localhost/api/session', { method: 'DELETE' }));
    expect(res.status).toBe(400);
  });

  it('keeps the session when the photos cannot be removed', async () => {
    // The order is photos first, rows second — so a storage failure leaves a
    // session the user can delete again, not a half-deleted one.
    const db = getDb();
    const sessionId = await sessionWithPhoto();

    setPhotoStoreForTesting({
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
    });

    const res = await DELETE(deleteRequest(sessionId));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; session_id: string };
    expect(body.error).toBe('purge_failed');
    expect(body.session_id).toBe(sessionId);

    expect(await db.getSession(sessionId)).not.toBeNull();
    expect(await exists(path.join(DATA_DIR, 'uploads', sessionId))).toBe(true);
  });
});

describe('GET /api/session', () => {
  it('reports how many chat turns are left', async () => {
    const sessionId = await newSessionId();

    const res = await GET(new Request(`http://localhost/api/session?session_id=${sessionId}`));
    const body = (await res.json()) as { chat_turns_left: number };

    // A fresh session has the whole hour's budget.
    expect(body.chat_turns_left).toBe(20);
  });
});
