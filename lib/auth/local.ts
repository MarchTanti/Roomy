/**
 * Our own email + password accounts.
 *
 * This is the mode the app runs in when there is no Supabase project: the
 * accounts live in the same database as everything else, and the passwords are
 * hashed with scrypt (see `password.ts`).
 *
 * It is also the fallback when Supabase is the configured database but its own
 * Auth is not switched on — a project can have a database and no login, and
 * the app should still work.
 */

import type { DbClient, User } from '@/lib/db/types';

import { hashPassword, verifyPassword } from './password';
import {
  authFailure,
  authSuccess,
  isValidEmail,
  normaliseEmail,
  passwordProblem,
  type AuthClient,
  type AuthResult,
  type AuthUser,
} from './types';

/** The account as the rest of the app sees it. */
export function toAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    provider: user.provider,
    created_at: user.created_at,
  };
}

/** The name to greet someone by, when they never chose one. */
function defaultName(email: string): string {
  const [local] = email.split('@');
  return local ?? email;
}

export class LocalAuth implements AuthClient {
  readonly mode = 'local' as const;

  constructor(private readonly db: DbClient) {}

  async register(email: string, password: string): Promise<AuthResult> {
    const address = normaliseEmail(email);
    if (!isValidEmail(address)) {
      return authFailure('อีเมลนี้ไม่ถูกต้อง');
    }
    const weak = passwordProblem(password);
    if (weak) return authFailure(weak);

    const existing = await this.db.getUserByEmail(address);
    if (existing) return authFailure('อีเมลนี้ถูกใช้สมัครไว้แล้ว');

    const passwordHash = await hashPassword(password);
    const created = await this.db.createUser({
      email: address,
      display_name: defaultName(address),
      provider: 'local',
      password_hash: passwordHash,
    });
    if (!created) return authFailure('อีเมลนี้ถูกใช้สมัครไว้แล้ว');

    return authSuccess(toAuthUser(created));
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const address = normaliseEmail(email);
    const user = await this.db.getUserByEmail(address);

    // The same message either way: the page must not say which half was wrong.
    const denied = authFailure('ไม่พบบัญชีนี้ หรืออีเมลกับรหัสผ่านไม่ถูกต้อง');
    if (!user) return denied;

    if (user.provider !== 'local' || !user.password_hash) {
      // The account belongs to Supabase. Signing in here would check the wrong
      // password store, so it is refused rather than half-accepted.
      return authFailure('บัญชีนี้สมัครผ่านระบบยืนยันตัวตนของ Supabase กรุณาเข้าสู่ระบบผ่าน Supabase');
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return denied;

    return authSuccess(toAuthUser(user));
  }
}
