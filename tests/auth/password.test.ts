import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from '@/lib/auth/password';

/**
 * Password hashing.
 *
 * The rule the rest of the app leans on: the password itself is never stored,
 * and a wrong password is refused without ever saying which half was wrong.
 */

describe('hashPassword', () => {
  it('gives a different hash every time', async () => {
    const first = await hashPassword('correct horse battery staple');
    const second = await hashPassword('correct horse battery staple');
    expect(first).not.toBe(second);
  });

  it('never contains the password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).not.toContain('correct horse');
  });

  it('says what it is, so an old row keeps verifying', async () => {
    const hash = await hashPassword('correct horse battery staple');
    const parts = hash.split('$');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('scrypt');
    expect(parts[1]).not.toBe('');
    expect(parts[2]).not.toBe('');
  });
});

describe('verifyPassword', () => {
  it('accepts the right password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('refuses the wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('Correct horse battery staple', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
    expect(await verifyPassword('correct horse battery stapl', hash)).toBe(false);
  });

  it('refuses anything that is not one of our hashes', async () => {
    expect(await verifyPassword('x', null)).toBe(false);
    expect(await verifyPassword('x', undefined)).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'plaintext')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$aa$bb')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$$')).toBe(false);
    // Not hex: the salt decodes to nothing, so there is nothing to check.
    expect(await verifyPassword('x', 'scrypt$zz$zz')).toBe(false);
  });
});
