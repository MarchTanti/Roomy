/**
 * Supabase Auth.
 *
 * When the app runs on Supabase, the accounts live in Supabase's own auth
 * system — password hashing, confirmation emails and all of it are handled
 * there. This adapter only translates: Supabase's answers into the app's
 * `AuthResult`, and the account into the `users` table the rest of the app
 * reads.
 *
 * The anon key is used, not the service-role key. The service role would
 * bypass every rule Supabase enforces, and this code runs on the server where
 * it buys nothing: the point of the anon key here is that Supabase applies its
 * own rate limiting and confirmation rules to the sign-in attempt.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { DbClient, User } from '@/lib/db/types';
import { readEnv } from '@/lib/env';

import { toAuthUser } from './local';
import {
  authFailure,
  authProviderUnavailable,
  authSuccess,
  isValidEmail,
  normaliseEmail,
  passwordProblem,
  type AuthClient,
  type AuthResult,
} from './types';

/**
 * True when the message means "Supabase Auth is not switched on".
 *
 * A project can have a database and no auth, and the messages Supabase sends
 * for that case have changed over the years — so this looks for the words
 * rather than one exact sentence.
 */
export function isAuthNotEnabled(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('signups not allowed') ||
    m.includes('signup not allowed') ||
    m.includes('not enabled') ||
    m.includes('not configured') ||
    m.includes('auth api') ||
    m.includes('email logins are disabled') ||
    m.includes('email signups are disabled') ||
    m.includes('provider is not enabled')
  );
}

export class SupabaseAuth implements AuthClient {
  readonly mode = 'supabase' as const;

  constructor(
    private readonly db: DbClient,
    private readonly client: SupabaseClient,
  ) {}

  /** Builds the client from the environment. Throws when a key is missing. */
  static fromEnv(db: DbClient): SupabaseAuth {
    const url = readEnv('SUPABASE_URL');
    const anonKey = readEnv('SUPABASE_ANON_KEY');
    if (!url || !anonKey) {
      throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are needed for Supabase Auth');
    }
    const client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return new SupabaseAuth(db, client);
  }

  async register(email: string, password: string): Promise<AuthResult> {
    const address = normaliseEmail(email);
    if (!isValidEmail(address)) return authFailure('อีเมลนี้ไม่ถูกต้อง');
    const weak = passwordProblem(password);
    if (weak) return authFailure(weak);

    let data: { user: { id: string; email?: string | null } | null; session: unknown };
    try {
      const result = await this.client.auth.signUp({ email: address, password });
      if (result.error) return this.explain(result.error.message, 'register');
      data = {
        user: result.data.user as { id: string; email?: string | null } | null,
        session: result.data.session,
      };
    } catch (err) {
      return authProviderUnavailable();
    }

    if (!data.user) return authFailure('สมัครสมาชิกไม่สำเร็จ ลองใหม่อีกครั้ง');

    // No session means Supabase is waiting for the email to be confirmed.
    if (!data.session) {
      return authFailure('สมัครสมาชิกแล้ว — กรุณาเปิดอีเมลและกดยืนยันก่อนเข้าสู่ระบบ', {
        needsEmailConfirmation: true,
      });
    }

    return this.finish(data.user.id, data.user.email ?? address);
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const address = normaliseEmail(email);

    let user: { id: string; email?: string | null } | null;
    try {
      const result = await this.client.auth.signInWithPassword({ email: address, password });
      if (result.error) return this.explain(result.error.message, 'login');
      user = result.data.user as { id: string; email?: string | null } | null;
    } catch {
      return authProviderUnavailable();
    }

    if (!user) return authFailure('ไม่พบบัญชีนี้ หรืออีเมลกับรหัสผ่านไม่ถูกต้อง');

    return this.finish(user.id, user.email ?? address);
  }

  /**
   * Mirrors the Supabase account into our `users` table.
   *
   * The table is what the rest of the app reads: it owns the chat sessions, and
   * it is the one place that says who an account is.
   */
  private async finish(providerId: string, email: string): Promise<AuthResult> {
    const existing = await this.db.getUserByProvider('supabase', providerId);
    if (existing) return authSuccess(toAuthUser(existing));

    const byEmail = await this.db.getUserByEmail(email);
    if (byEmail) {
      // The same address already exists as a local account. Two accounts for
      // one person is worse than saying so.
      return authFailure('อีเมลนี้มีบัญชีอยู่แล้วในระบบอื่น กรุณาใช้ช่องทางเดิมเพื่อเข้าสู่ระบบ');
    }

    const created = await this.db.createUser({
      email,
      display_name: email.split('@')[0] ?? email,
      provider: 'supabase',
      provider_id: providerId,
    });
    if (!created) {
      const raced = await this.db.getUserByProvider('supabase', providerId);
      if (raced) return authSuccess(toAuthUser(raced));
      return authFailure('สมัครสมาชิกไม่สำเร็จ ลองใหม่อีกครั้ง');
    }

    return authSuccess(toAuthUser(created as User));
  }

  /** Turns Supabase's English into something a person can act on. */
  private explain(message: string, action: 'register' | 'login'): AuthResult {
    const m = message.toLowerCase();

    if (isAuthNotEnabled(m)) return authProviderUnavailable();

    if (m.includes('already registered') || m.includes('already been registered')) {
      return authFailure('อีเมลนี้ถูกใช้สมัครไว้แล้ว');
    }
    if (m.includes('invalid login credentials')) {
      return authFailure('ไม่พบบัญชีนี้ หรืออีเมลกับรหัสผ่านไม่ถูกต้อง');
    }
    if (m.includes('email not confirmed')) {
      return authFailure('กรุณายืนยันอีเมลก่อนเข้าสู่ระบบ', { needsEmailConfirmation: true });
    }
    if (m.includes('password')) {
      return authFailure('รหัสผ่านไม่ผ่านเกณฑ์ของระบบ (อย่างน้อย 8 ตัวอักษร)');
    }
    if (m.includes('rate limit') || m.includes('too many')) {
      return authFailure('ลองบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่');
    }

    return authFailure(
      action === 'register' ? 'สมัครสมาชิกไม่สำเร็จ ลองใหม่อีกครั้ง' : 'เข้าสู่ระบบไม่สำเร็จ ลองใหม่อีกครั้ง',
    );
  }
}
