/**
 * `POST /api/session` — the first call the chat page makes.
 *
 * On a deployment that cannot store anything, this is where the problem shows
 * up first. The answer has to name the setting that is missing: a bare 500
 * with "permission denied" in it sends the person reading the log looking in
 * the wrong place.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'roomy-session-route-'));
process.env.ROOMY_DATA_DIR = DATA_DIR;
delete process.env.DB_ADAPTER;
delete process.env.GEMINI_API_KEY;
delete process.env.VERCEL;

let POST: (request: Request) => Promise<Response>;
let resetDb: () => void;

beforeAll(async () => {
  ({ POST } = await import('@/app/api/session/route'));
  ({ resetDb } = await import('@/lib/db'));
});

beforeEach(() => {
  resetDb();
  delete process.env.VERCEL;
  delete process.env.DB_ADAPTER;
});

afterEach(() => {
  delete process.env.VERCEL;
  delete process.env.DB_ADAPTER;
});

function request(): Request {
  return new Request('http://localhost/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}

describe('POST /api/session — on a deployment that cannot store a session', () => {
  it('answers 503 and names the setting to fix', async () => {
    process.env.VERCEL = '1';

    const res = await POST(request());
    const body = (await res.json()) as { error: string; key: string; message: string };

    expect(res.status).toBe(503);
    expect(body.error).toBe('server_not_configured');
    expect(body.key).toBe('DB_ADAPTER');
    expect(body.message).toContain('DB_ADAPTER=supabase');
  });

  it('creates a session on a machine that can keep one', async () => {
    const res = await POST(request());
    const body = (await res.json()) as { session_id: string };

    expect(res.status).toBe(201);
    expect(body.session_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
