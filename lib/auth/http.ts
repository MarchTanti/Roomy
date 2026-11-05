/**
 * The bits the auth routes share.
 *
 * They live here rather than in a file inside `app/`, because a file in the
 * app folder is a page or a route, and this is neither.
 */

import { MissingTableError } from '@/lib/db/errors';

/**
 * What to say when the account tables are not there.
 *
 * The tables arrive with `supabase/migrations/0003_auth.sql`, which the owner
 * of the project applies in the SQL editor. Until then, signing in cannot
 * work — but the chat still does, as a guest.
 */
export const NOT_READY_MESSAGE =
  'ระบบบัญชียังไม่ได้เตรียมฐานข้อมูล — กรุณารันไฟล์ supabase/migrations/0003_auth.sql ใน Supabase SQL Editor ก่อน (แชทยังใช้ได้ตามปกติแบบไม่ต้องเข้าสู่ระบบ)';

/** Turns an exception into the response the page expects. */
export function authErrorResponse(error: unknown, fallback: string): Response {
  if (error instanceof MissingTableError) {
    return Response.json({ error: NOT_READY_MESSAGE }, { status: 503 });
  }
  return Response.json({ error: fallback }, { status: 500 });
}

export interface Credentials {
  email: string;
  password: string;
  /** The chat session to give to the account, when someone signs in mid-chat. */
  sessionId: string | null;
}

/** Reads the email, the password and the session id out of the body. */
export async function readCredentials(request: Request): Promise<Credentials> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null) {
    return { email: '', password: '', sessionId: null };
  }
  const record = body as Record<string, unknown>;
  return {
    email: typeof record.email === 'string' ? record.email : '',
    password: typeof record.password === 'string' ? record.password : '',
    sessionId: typeof record.session_id === 'string' ? record.session_id : null,
  };
}
