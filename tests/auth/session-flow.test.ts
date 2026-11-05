import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import type { DbClient } from '@/lib/db/types';

/**
 * The whole sign-in round trip, against the real local adapter.
 *
 * The token is minted, stored hashed, and looked up again — and the row in
 * the database never holds the token itself.
 */

// lib/db/local.ts snapshots ROOMY_DATA_DIR at import time, so the assignment
// and every import that reaches the DB have to happen dynamically, in this
// order.
const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'roomy-auth-'));
process.env.ROOMY_DATA_DIR = DATA_DIR;
delete process.env.DB_ADAPTER;
delete process.env.AUTH_MODE;

let getDb: () => DbClient;
let signUp: (email: string, password: string) => Promise<{ ok: boolean; user: { email: string } | null; error: string | null; token: string | null }>;
let signIn: (email: string, password: string) => Promise<{ ok: boolean; user: { email: string } | null; error: string | null; token: string | null }>;
let resolveUserByToken: (token: string | null | undefined) => Promise<{ email: string } | null>;
let endSession: (token: string | null | undefined) => Promise<void>;

beforeAll(async () => {
  ({ getDb } = await import('@/lib/db'));
  ({ signUp, signIn, resolveUserByToken, endSession } = await import('@/lib/auth'));
});

describe('the sign-in round trip', () => {
  it('registers, and the token that comes back signs the person in', async () => {
    const created = await signUp('roomy@example.com', 'a good password');
    expect(created.ok).toBe(true);
    expect(created.token).toBeTruthy();

    const user = await resolveUserByToken(created.token);
    expect(user?.email).toBe('roomy@example.com');
  });

  it('never writes the token into the database', async () => {
    const created = await signUp('another@example.com', 'a good password');
    const rows = await getDb().getAuthSessionByTokenHash(
      (await import('@/lib/auth/tokens')).hashToken(created.token as string),
    );
    expect(rows).toBeTruthy();
    // The hash is there; the token is not.
    expect(JSON.stringify(rows)).not.toContain(created.token as string);
  });

  it('signs in again with the right password', async () => {
    await signUp('third@example.com', 'a good password');
    const result = await signIn('third@example.com', 'a good password');
    expect(result.ok).toBe(true);
    expect(result.token).toBeTruthy();
    expect((await resolveUserByToken(result.token))?.email).toBe('third@example.com');
  });

  it('does not sign in with the wrong password', async () => {
    await signUp('fourth@example.com', 'a good password');
    const result = await signIn('fourth@example.com', 'the wrong password');
    expect(result.ok).toBe(false);
    expect(result.token).toBeNull();
  });

  it('stops the token working once the session is ended', async () => {
    const created = await signUp('fifth@example.com', 'a good password');
    expect(await resolveUserByToken(created.token)).toBeTruthy();

    await endSession(created.token);
    expect(await resolveUserByToken(created.token)).toBeNull();
  });

  it('signs nobody in without a token', async () => {
    expect(await resolveUserByToken(null)).toBeNull();
    expect(await resolveUserByToken(undefined)).toBeNull();
    expect(await resolveUserByToken('')).toBeNull();
  });

  it('signs nobody in for a token it has never seen', async () => {
    expect(await resolveUserByToken('made-up-token')).toBeNull();
  });
});
