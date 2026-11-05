/**
 * The account types.
 *
 * Two things can hold an account: Supabase Auth (when the app runs on
 * Supabase) and our own email + password table (when it runs locally). Both
 * end up as the same `AuthUser`, so nothing above this layer has to care
 * which one is in use.
 */

/** Which system holds the accounts. */
export type AuthMode = 'local' | 'supabase';

export interface AuthUser {
  id: string;
  email: string;
  display_name: string | null;
  provider: AuthMode;
  created_at: string;
}

/**
 * What happened.
 *
 * `error` is written for the person using the page, not for a log file, so it
 * is safe to show as-is.
 */
export interface AuthResult {
  ok: boolean;
  user: AuthUser | null;
  error: string | null;
  /**
   * The provider could not be reached or is not switched on — not a wrong
   * password. The caller may try the other provider.
   */
  providerUnavailable: boolean;
  /** The account exists but the email address has not been confirmed. */
  needsEmailConfirmation: boolean;
}

/** The two things an account system has to be able to do. */
export interface AuthClient {
  readonly mode: AuthMode;
  register(email: string, password: string): Promise<AuthResult>;
  login(email: string, password: string): Promise<AuthResult>;
}

/** A result with nothing but an error message. */
export function authFailure(
  error: string,
  extra: Partial<AuthResult> = {},
): AuthResult {
  return {
    ok: false,
    user: null,
    error,
    providerUnavailable: false,
    needsEmailConfirmation: false,
    ...extra,
  };
}

/** A result that says the provider itself is not usable. */
export function authProviderUnavailable(): AuthResult {
  return authFailure('ระบบยืนยันตัวตนของผู้ให้บริการยังไม่พร้อมใช้งาน', {
    providerUnavailable: true,
  });
}

/** A result that says everything went well. */
export function authSuccess(user: AuthUser): AuthResult {
  return {
    ok: true,
    user,
    error: null,
    providerUnavailable: false,
    needsEmailConfirmation: false,
  };
}

/**
 * The email address, as we keep it.
 *
 * Lower case and trimmed: `Roomy@Example.com` and `roomy@example.com` are one
 * account, not two.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Whether the address looks like an email address at all. */
export function isValidEmail(email: string): boolean {
  const value = normaliseEmail(email);
  // Deliberately simple: one @, something on each side, a dot in the domain.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** The shortest password we accept. */
export const MIN_PASSWORD_LENGTH = 8;

/** The complaint about a password, or null when it is fine. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`;
  }
  if (password.length > 200) return 'รหัสผ่านยาวเกินไป';
  return null;
}
