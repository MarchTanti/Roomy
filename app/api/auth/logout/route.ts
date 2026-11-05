import { endSession } from '@/lib/auth';
import { clearAuthCookieHeader, readAuthToken } from '@/lib/auth/cookie';

/**
 * Signs out.
 *
 * The token is revoked in the database, not just dropped from the browser — a
 * copy of the cookie that someone kept would otherwise keep working until it
 * expired.
 */
export async function POST(request: Request) {
  // `endSession` never throws: a row that cannot be revoked still has to lose
  // its cookie, or the person stays "signed in" with a token that is dead.
  await endSession(await readAuthToken(request));
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': clearAuthCookieHeader() } });
}
