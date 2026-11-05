/**
 * The retention sweep.
 *
 *   POST /api/cleanup   Authorization: Bearer <CLEANUP_SECRET>
 *
 * Deletes every session — and its photos — that is older than
 * `RETENTION_DAYS` days. This is the "scheduled 7-day cleanup" of the spec:
 * nothing about a user's room photo should outlive the session by more than a
 * week.
 *
 * The endpoint is **off** unless `CLEANUP_SECRET` is set. With no secret there
 * is nothing to compare the token against, and an open "delete everything
 * older than N days" endpoint is not a thing to leave on the internet.
 *
 * The token is compared in constant time, so the secret cannot be recovered by
 * timing the response.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import { getDb } from '@/lib/db';
import { settings } from '@/lib/env';
import { purgeExpiredSessions } from '@/lib/session/purge';
import { getPhotoStore } from '@/lib/storage/store';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const secret = settings.cleanupSecret();
  if (!secret) {
    return Response.json(
      { error: 'cleanup_not_configured', message: 'CLEANUP_SECRET is not set — the sweep is off' },
      { status: 503 },
    );
  }

  if (!authorized(request, secret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const days = settings.retentionDays();
    const result = await purgeExpiredSessions(getDb(), days, getPhotoStore());

    return Response.json({
      ok: true,
      retention_days: days,
      sessions_deleted: result.sessions_deleted,
      photos_deleted: result.photos_deleted,
      // A session that could not be purged is reported, not hidden: the next
      // run tries it again.
      failures: result.failures,
    });
  } catch (err) {
    return Response.json(
      {
        error: 'cleanup_failed',
        message: err instanceof Error ? err.message : 'unexpected error',
      },
      { status: 500 },
    );
  }
}

/**
 * True when the request carries the right bearer token.
 *
 * Both sides are hashed first, so the comparison is over two 32-byte buffers
 * whatever the length of the token — and the length of the secret cannot leak
 * through the time the answer takes.
 */
function authorized(request: Request, secret: string): boolean {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  const given = createHash('sha256').update(token).digest();
  const expected = createHash('sha256').update(secret).digest();
  return timingSafeEqual(given, expected);
}
