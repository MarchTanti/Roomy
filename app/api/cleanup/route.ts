/**
 * The retention sweep.
 *
 *   POST /api/cleanup   Authorization: Bearer <secret>   — called by hand
 *   GET  /api/cleanup   Authorization: Bearer <secret>   — called by Vercel Cron
 *
 * Deletes every session — and its photos — that is older than
 * `RETENTION_DAYS` days. This is the "scheduled 7-day cleanup" of the spec:
 * nothing about a user's room photo should outlive the session by more than a
 * week.
 *
 * Vercel invokes a cron path with a **GET**, and sends the value of
 * `CRON_SECRET` back as the bearer token. `CLEANUP_SECRET` is the same idea
 * under our own name; either one switches the sweep on, so a deployment sets
 * one variable rather than two that have to match.
 *
 * The endpoint is **off** unless one of them is set. With no secret there
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

/** The cron entry point. Vercel Cron always calls a path with a GET. */
export async function GET(request: Request): Promise<Response> {
  return sweep(request);
}

/** The same sweep, triggered by hand. */
export async function POST(request: Request): Promise<Response> {
  return sweep(request);
}

async function sweep(request: Request): Promise<Response> {
  const secrets = settings.cleanupSecrets();
  if (secrets.length === 0) {
    return Response.json(
      { error: 'cleanup_not_configured', message: 'CLEANUP_SECRET is not set — the sweep is off' },
      { status: 503 },
    );
  }

  if (!authorized(request, secrets)) {
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
function authorized(request: Request, secrets: string[]): boolean {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  const given = createHash('sha256').update(token).digest();
  return secrets.some((secret) => {
    const expected = createHash('sha256').update(secret).digest();
    return timingSafeEqual(given, expected);
  });
}
