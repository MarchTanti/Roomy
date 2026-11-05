/**
 * `POST /api/cleanup` — the retention sweep, called by hand.
 * `GET  /api/cleanup` — the same sweep, called by Vercel Cron.
 *
 * Two things are being tested here. First, the guard: the endpoint deletes
 * everything older than the cutoff, so it must be unusable without the
 * secret, and it must stay unusable while the secret is unset. Second, the
 * sweep itself: it removes the old sessions and leaves the new ones alone.
 *
 * The GET entry is the one Vercel Cron uses: Vercel invokes a cron path with
 * a GET, and sends `Authorization: Bearer <CRON_SECRET>` back.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DbClient } from '@/lib/db/types';

const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'roomy-cleanup-'));
process.env.ROOMY_DATA_DIR = DATA_DIR;
delete process.env.DB_ADAPTER;
delete process.env.GEMINI_API_KEY;

const SECRET = 'a-test-secret';

type RouteHandler = (request: Request) => Promise<Response>;

let POST: RouteHandler;
let GET: RouteHandler;
let getDb: () => DbClient;
let resetDb: () => void;

beforeAll(async () => {
  ({ POST, GET } = await import('@/app/api/cleanup/route'));
  ({ getDb, resetDb } = await import('@/lib/db'));
});

beforeEach(() => {
  resetDb();
  process.env.CLEANUP_SECRET = SECRET;
  process.env.RETENTION_DAYS = '7';
});

afterEach(() => {
  delete process.env.CLEANUP_SECRET;
  delete process.env.CRON_SECRET;
  delete process.env.RETENTION_DAYS;
});

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/cleanup', { method: 'POST', headers });
}

/** The same route, reached the way Vercel Cron reaches it. */
function getRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/cleanup', { method: 'GET', headers });
}

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

async function newSessionId(): Promise<string> {
  const db = getDb();
  return (await db.createSession()).id;
}

// ---------------------------------------------------------------------------

describe('POST /api/cleanup — the guard', () => {
  it('is off when no secret is configured', async () => {
    // An open "delete everything older than N days" endpoint is not a thing
    // to leave on the internet.
    delete process.env.CLEANUP_SECRET;

    const res = await POST(request());

    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('cleanup_not_configured');
  });

  it('401s without a token', async () => {
    const res = await POST(request());
    expect(res.status).toBe(401);
  });

  it('401s with the wrong token', async () => {
    const res = await POST(request({ Authorization: `Bearer not-the-secret` }));
    expect(res.status).toBe(401);
  });

  it('401s with the right token in the wrong shape', async () => {
    // The token has to be a bearer token, not a query parameter.
    const res = await POST(request({ 'X-Cleanup-Secret': SECRET }));
    expect(res.status).toBe(401);
  });

  it('never echoes the secret', async () => {
    const res = await POST(request({ Authorization: 'Bearer nope' }));
    expect(await res.text()).not.toContain(SECRET);
  });
});

describe('POST /api/cleanup — the sweep', () => {
  it('deletes the expired sessions and keeps the rest', async () => {
    const db = getDb();
    const old = await newSessionId();
    const fresh = await newSessionId();
    await ageSession(old, 30);

    const res = await POST(request({ Authorization: `Bearer ${SECRET}` }));

    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      retention_days: number;
      sessions_deleted: number;
      photos_deleted: number;
    };
    expect(body.ok).toBe(true);
    expect(body.retention_days).toBe(7);
    expect(body.sessions_deleted).toBe(1);

    expect(await db.getSession(old)).toBeNull();
    expect(await db.getSession(fresh)).not.toBeNull();
  });

  it('deletes nothing when every session is inside the window', async () => {
    const db = getDb();
    const sessionId = await newSessionId();

    const res = await POST(request({ Authorization: `Bearer ${SECRET}` }));
    const body = (await res.json()) as { sessions_deleted: number };

    expect(body.sessions_deleted).toBe(0);
    expect(await db.getSession(sessionId)).not.toBeNull();
  });

  it('honours a different retention window', async () => {
    const db = getDb();
    const sessionId = await newSessionId();
    await ageSession(sessionId, 3);
    process.env.RETENTION_DAYS = '1';

    const res = await POST(request({ Authorization: `Bearer ${SECRET}` }));
    const body = (await res.json()) as { sessions_deleted: number; retention_days: number };

    expect(body.retention_days).toBe(1);
    expect(body.sessions_deleted).toBe(1);
    expect(await db.getSession(sessionId)).toBeNull();
  });
});

describe('GET /api/cleanup — the cron entry', () => {
  it('is off when no secret is configured', async () => {
    delete process.env.CLEANUP_SECRET;
    delete process.env.CRON_SECRET;

    const res = await GET(getRequest());

    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('cleanup_not_configured');
  });

  it('401s without a token', async () => {
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
  });

  it('401s with the wrong token', async () => {
    const res = await GET(getRequest({ Authorization: 'Bearer not-the-secret' }));
    expect(res.status).toBe(401);
  });

  it('runs the sweep and reports what it removed', async () => {
    const db = getDb();
    const old = await newSessionId();
    const fresh = await newSessionId();
    await ageSession(old, 30);

    const res = await GET(getRequest({ Authorization: `Bearer ${SECRET}` }));

    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      retention_days: number;
      sessions_deleted: number;
    };
    expect(body.ok).toBe(true);
    expect(body.retention_days).toBe(7);
    expect(body.sessions_deleted).toBe(1);

    expect(await db.getSession(old)).toBeNull();
    expect(await db.getSession(fresh)).not.toBeNull();
  });

  it('takes CRON_SECRET when CLEANUP_SECRET is unset', async () => {
    // Vercel sends the value of CRON_SECRET back on every cron request, so a
    // deployment needs one variable, not two that have to be kept in step.
    delete process.env.CLEANUP_SECRET;
    process.env.CRON_SECRET = 'the-cron-secret';

    const res = await GET(getRequest({ Authorization: 'Bearer the-cron-secret' }));

    expect(res.status, await res.clone().text()).toBe(200);
  });

  it('never echoes the secret', async () => {
    const res = await GET(getRequest({ Authorization: 'Bearer nope' }));
    expect(await res.text()).not.toContain(SECRET);
  });
});
