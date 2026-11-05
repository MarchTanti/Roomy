import { resolveUserByToken } from '@/lib/auth';
import { readAuthToken } from '@/lib/auth/cookie';
import { getDb } from '@/lib/db';
import { transcriptTitle } from '@/lib/session/transcript';

/**
 * The signed-in person's conversations.
 *
 * This is the log the account was for: every chat session that belongs to
 * this person, newest first, with the first thing they said as its title.
 */
export async function GET(request: Request) {
  const user = await resolveUserByToken(await readAuthToken(request));
  if (!user) {
    return Response.json({ error: 'ยังไม่ได้เข้าสู่ระบบ' }, { status: 401 });
  }

  const db = getDb();
  const sessions = await db.listSessionsForUser(user.id, 50);

  const items = await Promise.all(
    sessions.map(async (session) => {
      const messages = await db.listMessages(session.id);
      return {
        id: session.id,
        created_at: session.created_at,
        title: transcriptTitle(messages, 'บทสนทนาใหม่'),
        message_count: messages.length,
        image_quota_left: session.image_quota_left,
      };
    }),
  );

  return Response.json({ user, sessions: items });
}
