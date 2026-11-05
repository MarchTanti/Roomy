/**
 * Who may act on a chat session.
 *
 * A session with an owner belongs to that account: only the account may read
 * it, change it, add a photo to it, generate a picture in it, or delete it.
 *
 * A session without an owner is a guest's, and its id is the only key to it —
 * the way it has always been. A guest never signs in, so there is no account
 * to compare against.
 */

import { resolveUserByToken } from '@/lib/auth';
import { readAuthToken } from '@/lib/auth/cookie';
import type { Session } from '@/lib/db/types';

/** Whether the requester may act on this session. */
export async function mayActOnSession(session: Session, request: Request): Promise<boolean> {
  if (!session.user_id) return true;

  const user = await resolveUserByToken(await readAuthToken(request));
  return user !== null && user.id === session.user_id;
}
