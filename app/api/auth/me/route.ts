import { resolveUserByToken } from '@/lib/auth';
import { readAuthToken } from '@/lib/auth/cookie';

/**
 * Who is signed in.
 *
 * The page asks this on load and after every sign-in, so it always answers
 * with the truth rather than with what the browser thinks.
 */
export async function GET(request: Request) {
  const user = await resolveUserByToken(await readAuthToken(request));
  return Response.json({ user });
}
