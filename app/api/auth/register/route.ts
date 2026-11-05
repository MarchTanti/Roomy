import { getDb } from '@/lib/db';
import { signUp } from '@/lib/auth';
import { authCookieHeader } from '@/lib/auth/cookie';
import { authErrorResponse, readCredentials } from '@/lib/auth/http';

/**
 * Creates an account and signs the person in.
 *
 * The chat session in the browser is handed to the new account, so the
 * conversation that was already going is the first thing in their history.
 */
export async function POST(request: Request) {
  const { email, password, sessionId } = await readCredentials(request);

  try {
    const outcome = await signUp(email, password);
    if (!outcome.ok || !outcome.user || !outcome.token) {
      return Response.json({ error: outcome.error ?? 'สมัครสมาชิกไม่สำเร็จ' }, { status: 400 });
    }

    if (sessionId) {
      const db = getDb();
      const session = await db.getSession(sessionId);
      // Only take a session that has no owner yet, or one that is already
      // this account's. Someone else's session is left alone.
      if (session && (!session.user_id || session.user_id === outcome.user.id)) {
        await db.attachSessionToUser(sessionId, outcome.user.id);
      }
    }

    return Response.json(
      { user: outcome.user },
      { headers: { 'Set-Cookie': authCookieHeader(outcome.token) } },
    );
  } catch (error) {
    return authErrorResponse(error, 'สมัครสมาชิกไม่สำเร็จ ลองใหม่อีกครั้ง');
  }
}
