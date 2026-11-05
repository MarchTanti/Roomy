/**
 * The sign-in routes, over HTTP.
 *
 * The point of these tests is the cookie: it is httpOnly, it survives from
 * one request to the next, and it is the only thing that says who is signed
 * in. Everything else — the account row, the session history — hangs off it.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';

import type { DbClient } from '@/lib/db/types';
import type { PhotoStore } from '@/lib/storage';

const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'roomy-auth-routes-'));
process.env.ROOMY_DATA_DIR = DATA_DIR;
delete process.env.DB_ADAPTER;
delete process.env.GEMINI_API_KEY;
delete process.env.AUTH_MODE;

type RouteHandler = (request: Request) => Promise<Response>;
type RouteGet = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let register: RouteHandler;
let login: RouteHandler;
let logout: RouteHandler;
let me: RouteHandler;
let history: RouteHandler;
let sessionPost: RouteHandler;
let sessionGet: RouteHandler;
let imageGet: RouteGet;
let getDb: () => DbClient;
let getPhotoStore: () => PhotoStore;

beforeAll(async () => {
  ({ POST: register } = await import('@/app/api/auth/register/route'));
  ({ POST: login } = await import('@/app/api/auth/login/route'));
  ({ POST: logout } = await import('@/app/api/auth/logout/route'));
  ({ GET: me } = await import('@/app/api/auth/me/route'));
  ({ GET: history } = await import('@/app/api/history/route'));
  ({ POST: sessionPost, GET: sessionGet } = await import('@/app/api/session/route'));
  ({ GET: imageGet } = await import('@/app/api/image/[id]/route'));
  ({ getDb } = await import('@/lib/db'));
  ({ getPhotoStore } = await import('@/lib/storage'));
});

/** A request, with the cookie when there is one. */
function request(path: string, options: { method?: string; body?: unknown; token?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token) headers.cookie = `roomy_session=${options.token}`;

  return new Request(`http://localhost${path}`, {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

/** The token out of a `Set-Cookie` header. */
function tokenFrom(response: Response): string | null {
  const header = response.headers.get('set-cookie');
  if (!header) return null;
  const match = /roomy_session=([^;]*)/.exec(header);
  return match ? decodeURIComponent(match[1]) : null;
}

describe('register', () => {
  it('creates the account and hands back a cookie', async () => {
    const res = await register(
      request('/api/auth/register', { body: { email: 'roomy@example.com', password: 'a good password' } }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { email: string } };
    expect(body.user.email).toBe('roomy@example.com');

    const token = tokenFrom(res);
    expect(token).toBeTruthy();
    expect(res.headers.get('set-cookie')).toContain('HttpOnly');
  });

  it('refuses an address that is not an email', async () => {
    const res = await register(
      request('/api/auth/register', { body: { email: 'nope', password: 'a good password' } }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
  });

  it('refuses a password that is too short', async () => {
    const res = await register(
      request('/api/auth/register', { body: { email: 'short@example.com', password: 'abc' } }),
    );
    expect(res.status).toBe(400);
  });

  it('refuses the same address twice', async () => {
    const body = { email: 'twice@example.com', password: 'a good password' };
    expect((await register(request('/api/auth/register', { body }))).status).toBe(200);

    const again = await register(request('/api/auth/register', { body }));
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: string }).error).toContain('ถูกใช้สมัครไว้แล้ว');
  });
});

describe('login', () => {
  it('signs an existing account in', async () => {
    await register(
      request('/api/auth/register', { body: { email: 'in@example.com', password: 'a good password' } }),
    );

    const res = await login(
      request('/api/auth/login', { body: { email: 'in@example.com', password: 'a good password' } }),
    );

    expect(res.status).toBe(200);
    expect(tokenFrom(res)).toBeTruthy();
  });

  it('refuses the wrong password', async () => {
    await register(
      request('/api/auth/register', { body: { email: 'out@example.com', password: 'a good password' } }),
    );

    const res = await login(
      request('/api/auth/login', { body: { email: 'out@example.com', password: 'the wrong password' } }),
    );
    expect(res.status).toBe(401);
    expect(tokenFrom(res)).toBeNull();
  });
});

describe('me', () => {
  it('says who is signed in', async () => {
    const registered = await register(
      request('/api/auth/register', { body: { email: 'me@example.com', password: 'a good password' } }),
    );
    const token = tokenFrom(registered) as string;

    const res = await me(request('/api/auth/me', { token }));
    const body = (await res.json()) as { user: { email: string } | null };
    expect(body.user?.email).toBe('me@example.com');
  });

  it('says nobody is signed in without a cookie', async () => {
    const res = await me(request('/api/auth/me'));
    const body = (await res.json()) as { user: unknown };
    expect(body.user).toBeNull();
  });
});

describe('logout', () => {
  it('ends the session, so the token stops working', async () => {
    const registered = await register(
      request('/api/auth/register', { body: { email: 'bye@example.com', password: 'a good password' } }),
    );
    const token = tokenFrom(registered) as string;

    expect((await me(request('/api/auth/me', { token }))).status).toBe(200);
    expect(((await (await me(request('/api/auth/me', { token }))).json()) as { user: unknown }).user).not.toBeNull();

    const out = await logout(request('/api/auth/logout', { method: 'POST', token }));
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');

    const after = (await (await me(request('/api/auth/me', { token }))).json()) as { user: unknown };
    expect(after.user).toBeNull();
  });
});

describe('the history', () => {
  it('refuses an anonymous visitor', async () => {
    const res = await history(request('/api/history'));
    expect(res.status).toBe(401);
  });

  it('lists the conversations of the signed-in account', async () => {
    const registered = await register(
      request('/api/auth/register', { body: { email: 'hist@example.com', password: 'a good password' } }),
    );
    const token = tokenFrom(registered) as string;

    // A session created while signed in belongs to the account.
    const created = await sessionPost(request('/api/session', { method: 'POST', token }));
    const sessionId = ((await created.json()) as { session_id: string }).session_id;

    const db = getDb();
    await db.addMessage(sessionId, {
      role: 'user',
      content: { role: 'user', parts: [{ kind: 'text', text: 'ห้องนั่งเล่น 3×4 เมตร' }] },
    });

    const res = await history(request('/api/history', { token }));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { sessions: { id: string; title: string }[] };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe(sessionId);
    expect(body.sessions[0].title).toBe('ห้องนั่งเล่น 3×4 เมตร');
  });

  it('shows one account nothing of another account', async () => {
    const first = await register(
      request('/api/auth/register', { body: { email: 'one@example.com', password: 'a good password' } }),
    );
    const firstToken = tokenFrom(first) as string;
    await sessionPost(request('/api/session', { method: 'POST', token: firstToken }));

    const second = await register(
      request('/api/auth/register', { body: { email: 'two@example.com', password: 'a good password' } }),
    );
    const secondToken = tokenFrom(second) as string;

    const res = await history(request('/api/history', { token: secondToken }));
    const body = (await res.json()) as { sessions: unknown[] };
    expect(body.sessions).toHaveLength(0);
  });
});

describe('a session that belongs to an account', () => {
  it('is not open to anybody else', async () => {
    const owner = await register(
      request('/api/auth/register', { body: { email: 'owner@example.com', password: 'a good password' } }),
    );
    const ownerToken = tokenFrom(owner) as string;

    const created = await sessionPost(request('/api/session', { method: 'POST', token: ownerToken }));
    const sessionId = ((await created.json()) as { session_id: string }).session_id;

    // The owner may open it.
    const mine = await sessionGet(
      request(`/api/session?session_id=${sessionId}`, { token: ownerToken }),
    );
    expect(mine.status).toBe(200);

    // Nobody else may.
    const stranger = await sessionGet(request(`/api/session?session_id=${sessionId}`));
    expect(stranger.status).toBe(403);

    const other = await register(
      request('/api/auth/register', { body: { email: 'other@example.com', password: 'a good password' } }),
    );
    const otherToken = tokenFrom(other) as string;
    const theirs = await sessionGet(
      request(`/api/session?session_id=${sessionId}`, { token: otherToken }),
    );
    expect(theirs.status).toBe(403);
  });

  it('still opens for a guest session, because the id is the key', async () => {
    const created = await sessionPost(request('/api/session', { method: 'POST' }));
    const sessionId = ((await created.json()) as { session_id: string }).session_id;

    const res = await sessionGet(request(`/api/session?session_id=${sessionId}`));
    expect(res.status).toBe(200);
  });

  it('hands the guest session to the account when someone signs in', async () => {
    const created = await sessionPost(request('/api/session', { method: 'POST' }));
    const sessionId = ((await created.json()) as { session_id: string }).session_id;

    const registered = await register(
      request('/api/auth/register', {
        body: { email: 'claim@example.com', password: 'a good password', session_id: sessionId },
      }),
    );
    const token = tokenFrom(registered) as string;

    const db = getDb();
    const session = await db.getSession(sessionId);
    expect(session?.user_id).toBeTruthy();

    // And it is in the account's history now.
    const body = (await (await history(request('/api/history', { token }))).json()) as {
      sessions: { id: string }[];
    };
    expect(body.sessions.map((s) => s.id)).toContain(sessionId);
  });
});

describe('the photos of an owned session', () => {
  it('are served to the owner and to nobody else', async () => {
    const owner = await register(
      request('/api/auth/register', { body: { email: 'photo@example.com', password: 'a good password' } }),
    );
    const ownerToken = tokenFrom(owner) as string;

    const created = await sessionPost(request('/api/session', { method: 'POST', token: ownerToken }));
    const sessionId = ((await created.json()) as { session_id: string }).session_id;

    // A real photo in that session: the store and the database, not a stub.
    const jpeg = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 200, g: 180, b: 150 } },
    })
      .jpeg()
      .toBuffer();
    const stored = await getPhotoStore().put(sessionId, jpeg);
    const record = await getDb().addImage({
      session_id: sessionId,
      kind: 'room',
      storage_path: stored.path,
    });

    // The owner may see it.
    const mine = await imageGet(
      request(`/api/image/${record.id}?session_id=${sessionId}`, { token: ownerToken }),
      { params: Promise.resolve({ id: record.id }) },
    );
    expect(mine.status).toBe(200);
    expect(mine.headers.get('content-type')).toBe('image/jpeg');

    // A stranger may not — not even holding the session id, because a photo
    // that belongs to an account is not addressed by its session any more.
    const stranger = await imageGet(request(`/api/image/${record.id}?session_id=${sessionId}`), {
      params: Promise.resolve({ id: record.id }),
    });
    expect(stranger.status).toBe(404);

    // And neither may another account.
    const other = await register(
      request('/api/auth/register', { body: { email: 'photo-other@example.com', password: 'a good password' } }),
    );
    const otherToken = tokenFrom(other) as string;
    const theirs = await imageGet(
      request(`/api/image/${record.id}?session_id=${sessionId}`, { token: otherToken }),
      { params: Promise.resolve({ id: record.id }) },
    );
    expect(theirs.status).toBe(404);
  });
});
