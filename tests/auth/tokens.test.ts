import { describe, expect, it } from 'vitest';

import { expiryFromNow, hashToken, isLive, newSessionToken, SESSION_TTL_SECONDS } from '@/lib/auth/tokens';

/**
 * The signed-in token.
 *
 * Two properties matter: the token itself has to be unguessable, and the thing
 * that reaches the database must not be it.
 */

describe('newSessionToken', () => {
  it('is different every time', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => newSessionToken()));
    expect(tokens.size).toBe(100);
  });

  it('is long enough that guessing it is hopeless', () => {
    expect(newSessionToken().length).toBeGreaterThanOrEqual(40);
  });

  it('has no character that would need escaping in a cookie', () => {
    expect(newSessionToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('hashToken', () => {
  it('is the same for the same token', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
  });

  it('is not the token', () => {
    expect(hashToken('abc')).not.toContain('abc');
  });

  it('is different for a different token', () => {
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });
});

describe('expiryFromNow', () => {
  it('is in the future', () => {
    expect(isLive(expiryFromNow())).toBe(true);
  });

  it('is thirty days out', () => {
    const at = Date.parse(expiryFromNow());
    const days = (at - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(SESSION_TTL_SECONDS / 86_400 - 0.01);
    expect(days).toBeLessThanOrEqual(SESSION_TTL_SECONDS / 86_400);
  });
});

describe('isLive', () => {
  it('is false once the moment has passed', () => {
    expect(isLive(new Date(Date.now() - 1000).toISOString())).toBe(false);
  });

  it('is false for a date it cannot read', () => {
    expect(isLive('not a date')).toBe(false);
    expect(isLive('')).toBe(false);
  });
});
