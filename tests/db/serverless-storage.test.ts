/**
 * A server that cannot keep a session — and says which setting is missing.
 *
 * The local adapter writes JSON files. A serverless instance keeps its files
 * read-only apart from `/tmp`, and `/tmp` is thrown away with the instance, so
 * a session written there would be gone before anyone came back. The failure
 * that reaches the person using the site has to name the fix, not repeat
 * "permission denied" from the filesystem.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { NoWritableStorageError } from '@/lib/env';

const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'roomy-storage-'));
process.env.ROOMY_DATA_DIR = DATA_DIR;
delete process.env.DB_ADAPTER;
delete process.env.GEMINI_API_KEY;
delete process.env.VERCEL;

let getDb: () => unknown;
let resetDb: () => void;
let canKeepLocalSessions: () => Promise<boolean>;

beforeAll(async () => {
  ({ getDb, resetDb, canKeepLocalSessions } = await import('@/lib/db'));
});

beforeEach(() => {
  resetDb();
  delete process.env.VERCEL;
  delete process.env.DB_ADAPTER;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

afterEach(() => {
  delete process.env.VERCEL;
  delete process.env.DB_ADAPTER;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

describe('the database on a serverless deployment', () => {
  it('names DB_ADAPTER when the local adapter would be used', () => {
    process.env.VERCEL = '1';

    let thrown: unknown;
    try {
      getDb();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(NoWritableStorageError);
    expect((thrown as Error).message).toContain('DB_ADAPTER=supabase');
  });

  it('names the Supabase keys when DB_ADAPTER is set but they are not', () => {
    process.env.VERCEL = '1';
    process.env.DB_ADAPTER = 'supabase';

    let thrown: unknown;
    try {
      getDb();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(NoWritableStorageError);
    expect((thrown as Error).message).toContain('SUPABASE_URL');
  });

  it('uses Supabase when it is asked for and the keys are there', () => {
    process.env.VERCEL = '1';
    process.env.DB_ADAPTER = 'supabase';
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'a-service-role-key';

    expect(() => getDb()).not.toThrow();
  });

  it('leaves a machine you control alone', () => {
    // No VERCEL: the local adapter is exactly right on a laptop.
    expect(() => getDb()).not.toThrow();
  });

  it('knows a serverless instance cannot keep a file, even in /tmp', async () => {
    // The filesystem here is writable, and on Vercel `/tmp` is writable too —
    // but it goes away with the instance, so a session written there is lost.
    process.env.VERCEL = '1';
    expect(await canKeepLocalSessions()).toBe(false);
  });

  it('knows a machine can keep a file', async () => {
    expect(await canKeepLocalSessions()).toBe(true);
  });
});

describe('the local adapter on a filesystem that cannot be written', () => {
  it('says the storage cannot be kept, rather than repeating "permission denied"', async (ctx) => {
    const locked = path.join(DATA_DIR, 'locked');
    await fs.mkdir(locked, { recursive: true });
    await fs.chmod(locked, 0o500);

    // A probe first: running as root, a directory cannot be locked down, and
    // there is nothing to assert.
    const probe = path.join(locked, 'probe');
    try {
      await fs.writeFile(probe, 'x', 'utf8');
      ctx.skip();
    } catch {
      // The filesystem refuses writes, which is the case under test.
    }

    vi.resetModules();
    process.env.ROOMY_DATA_DIR = path.join(locked, 'data');
    const local = await import('@/lib/db/local');
    // The registry was reset, so this is the same class the fresh module
    // graph throws — not the one imported at the top of the file.
    const env = await import('@/lib/env');

    expect(await local.canStoreLocally()).toBe(false);

    let thrown: unknown;
    try {
      await local.createLocalDbClient().createSession();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(env.NoWritableStorageError);
    expect((thrown as Error).message).toContain('DB_ADAPTER=supabase');

    await fs.chmod(locked, 0o700);
  });

  it('can keep files when the filesystem allows it', async () => {
    vi.resetModules();
    process.env.ROOMY_DATA_DIR = path.join(DATA_DIR, 'writable');
    const local = await import('@/lib/db/local');

    expect(await local.canStoreLocally()).toBe(true);
  });
});
