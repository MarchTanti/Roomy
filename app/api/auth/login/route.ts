import { getDb } from '@/lib/db';
import { signIn } from '@/lib/auth';
import { authCookieHeader } from '@/lib/auth/cookie';
import { authErrorResponse, readCredentials } from '@/lib/auth/http';

/**
 * Signs an existing account in.
 *
 * Like registering, the chat session in the browser is handed to the account
 * when nobody owns it yet — so signing in halfway through a conversation does
 * not lose that conversation.
 */
export async function POST(request: Request) {
  const { email, password, sessionId } = await readCredentials(request);

  try {
    const outcome = await signIn(email, password);
    if (!outcome.ok || !outcome.user || !outcome.token) {
      return Response.json({ error: outcome.error ?? 'เข้าสู่ระบบไม่สำเร็จ' }, { status: 401 });
    }

    if (sessionId) {
      const db = getDb();
      const session = await db.getSession(sessionId);
      if (session && (!session.user_id || session.user_id === outcome.user.id)) {
        await db.attachSessionToUser(sessionId, outcome.user.id);
      }
    }

    return Response.json(
      { user: outcome.user },
      { headers: { 'Set-Cookie': authCookieHeader(outcome.token) } },
    );
  } catch (error) {
    return authErrorResponse(error, 'เข้าสู่ระบบไม่สำเร็จ ลองใหม่อีกครั้ง');
  }
}
