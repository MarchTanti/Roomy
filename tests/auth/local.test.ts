import { describe, expect, it } from 'vitest';

import { LocalAuth } from '@/lib/auth/local';
import type { AuthProvider, DbClient, NewUser, User } from '@/lib/db/types';

/**
 * Our own accounts.
 *
 * The database is a stand-in here — what matters is the rule the adapter
 * applies, not how the row is stored.
 */

function fakeDb(): { db: DbClient; users: User[] } {
  const users: User[] = [];

  const db = {
    async createUser(input: NewUser) {
      const email = input.email.trim().toLowerCase();
      if (users.some((u) => u.email === email)) return null;
      const user: User = {
        id: `user-${users.length + 1}`,
        email,
        display_name: input.display_name ?? null,
        provider: input.provider,
        provider_id: input.provider_id ?? null,
        password_hash: input.password_hash ?? null,
        created_at: new Date().toISOString(),
      };
      users.push(user);
      return user;
    },
    async getUser(id: string) {
      return users.find((u) => u.id === id) ?? null;
    },
    async getUserByEmail(email: string) {
      const needle = email.trim().toLowerCase();
      return users.find((u) => u.email === needle) ?? null;
    },
    async getUserByProvider(provider: AuthProvider, providerId: string) {
      return users.find((u) => u.provider === provider && u.provider_id === providerId) ?? null;
    },
  } as unknown as DbClient;

  return { db, users };
}

describe('register', () => {
  it('creates the account and says who it is', async () => {
    const { db } = fakeDb();
    const result = await new LocalAuth(db).register('Roomy@Example.com', 'a good password');

    expect(result.ok).toBe(true);
    expect(result.user?.email).toBe('roomy@example.com');
    expect(result.error).toBeNull();
  });

  it('stores the email in lower case', async () => {
    const { db, users } = fakeDb();
    await new LocalAuth(db).register('Roomy@Example.com', 'a good password');
    expect(users[0].email).toBe('roomy@example.com');
  });

  it('never stores the password itself', async () => {
    const { db, users } = fakeDb();
    await new LocalAuth(db).register('roomy@example.com', 'a good password');

    expect(users[0].password_hash).not.toContain('a good password');
    expect(users[0].password_hash?.startsWith('scrypt$')).toBe(true);
  });

  it('refuses an email that is already taken', async () => {
    const { db } = fakeDb();
    const auth = new LocalAuth(db);
    await auth.register('roomy@example.com', 'a good password');

    const again = await auth.register('roomy@example.com', 'another password');
    expect(again.ok).toBe(false);
    expect(again.error).toBe('อีเมลนี้ถูกใช้สมัครไว้แล้ว');
  });

  it('refuses an address that is not an email', async () => {
    const { db } = fakeDb();
    const result = await new LocalAuth(db).register('not-an-email', 'a good password');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('อีเมลนี้ไม่ถูกต้อง');
  });

  it('refuses a password that is too short', async () => {
    const { db } = fakeDb();
    const result = await new LocalAuth(db).register('roomy@example.com', 'short');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('8');
  });
});

describe('login', () => {
  it('accepts the right password', async () => {
    const { db } = fakeDb();
    const auth = new LocalAuth(db);
    await auth.register('roomy@example.com', 'a good password');

    const result = await auth.login('roomy@example.com', 'a good password');
    expect(result.ok).toBe(true);
    expect(result.user?.email).toBe('roomy@example.com');
  });

  it('ignores the case of the email', async () => {
    const { db } = fakeDb();
    const auth = new LocalAuth(db);
    await auth.register('roomy@example.com', 'a good password');

    const result = await auth.login('ROOMY@EXAMPLE.COM', 'a good password');
    expect(result.ok).toBe(true);
  });

  it('refuses the wrong password', async () => {
    const { db } = fakeDb();
    const auth = new LocalAuth(db);
    await auth.register('roomy@example.com', 'a good password');

    const result = await auth.login('roomy@example.com', 'the wrong password');
    expect(result.ok).toBe(false);
  });

  it('says the same thing for an unknown email as for a wrong password', async () => {
    const { db } = fakeDb();
    const auth = new LocalAuth(db);
    await auth.register('roomy@example.com', 'a good password');

    const wrongPassword = await auth.login('roomy@example.com', 'the wrong password');
    const unknownEmail = await auth.login('nobody@example.com', 'a good password');

    expect(unknownEmail.error).toBe(wrongPassword.error);
  });

  it('refuses an account that belongs to Supabase', async () => {
    const { db, users } = fakeDb();
    users.push({
      id: 'user-9',
      email: 'roomy@example.com',
      display_name: 'roomy',
      provider: 'supabase',
      provider_id: 'abc',
      password_hash: null,
      created_at: new Date().toISOString(),
    });

    const result = await new LocalAuth(db).login('roomy@example.com', 'a good password');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Supabase');
  });
});
