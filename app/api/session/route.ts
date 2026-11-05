/**
 * Session lifecycle.
 *
 *   POST   /api/session   → create a session
 *   GET    /api/session   → read one (?session_id=)
 *   PATCH  /api/session   → update the measurement fields of one
 *   DELETE /api/session   → delete one, including its messages and images
 *
 * PATCH exists for the area picker: the user drags a footprint and a
 * reference line on their room photo, and those three fields
 * (`selected_area`, `reference_line`, `reference_cm`) are what `checkFit`
 * turns into centimetres. It is a merge, not a replace — the browser holds its
 * own copy of the session state, so a full-object write would let a stale copy
 * undo a measurement the user just made.
 *
 * DELETE removes the photos from storage *and* the rows from the database — see
 * `lib/session/purge.ts`. The rows are kept if the photos cannot be removed,
 * so a storage failure never leaves the user with a session that looks deleted
 * but is not.
 */

import { z } from 'zod';

import { resolveUserByToken } from '@/lib/auth';
import { readAuthToken } from '@/lib/auth/cookie';
import { getDb } from '@/lib/db';
import type { SessionState } from '@/lib/db/types';
import { activeLlm } from '@/lib/llm';
import { MissingEnvError, settings } from '@/lib/env';
import { purgeSession, PurgeError } from '@/lib/session/purge';
import { mayActOnSession } from '@/lib/session/ownership';
import { toTranscript } from '@/lib/session/transcript';
import { getPhotoStore } from '@/lib/storage/store';
import { HOUR_MS, peek, sessionKey } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const CreateBody = z.object({}).passthrough();

/** How many chat turns the session has left in the current hour. */
function chatTurnsLeft(sessionId: string): number {
  return peek({
    key: sessionKey(sessionId),
    limit: settings.chatTurnsPerHour(),
    windowMs: HOUR_MS,
  }).remaining;
}

/** The id of the signed-in account, or null for a guest. */
async function currentUserId(request: Request): Promise<string | null> {
  const user = await resolveUserByToken(await readAuthToken(request));
  return user?.id ?? null;
}

/** A position on the photo, as a fraction of its width or height. */
const Unit = z.number().finite().min(0).max(1);

/** Extents have to be real: a zero-sized box divides by zero downstream. */
const Extent = z.number().finite().gt(0).max(1);

/**
 * Strict on purpose. A typo like `reference_cm2` would otherwise be dropped
 * silently and the user would be left wondering why the measurement never
 * arrived.
 */
const PatchBody = z
  .object({
    session_id: z.string().uuid(),
    selected_area: z.object({ x: Unit, y: Unit, w: Extent, h: Extent }).strict().nullish(),
    reference_line: z.object({ x1: Unit, y1: Unit, x2: Unit, y2: Unit }).strict().nullish(),
    reference_cm: z.number().finite().positive().max(10_000).nullish(),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  try {
    // Reject a stray body early rather than silently ignoring it.
    const body: unknown = await request.json().catch(() => ({}));
    const parsed = CreateBody.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: 'invalid_body' }, { status: 400 });
    }

    // A signed-in person's session belongs to them, so it shows up in their
    // history. A guest gets a session with no owner.
    const session = await getDb().createSession(await currentUserId(request));

    return Response.json(
      {
        session_id: session.id,
        created_at: session.created_at,
        state: session.state,
        image_quota_left: session.image_quota_left,
        chat_turns_left: chatTurnsLeft(session.id),
        llm: activeLlm(),
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET(request: Request): Promise<Response> {
  const sessionId = new URL(request.url).searchParams.get('session_id');
  if (!sessionId) {
    return Response.json({ error: 'missing_session_id' }, { status: 400 });
  }

  try {
    const db = getDb();
    const session = await db.getSession(sessionId);
    if (!session) return Response.json({ error: 'session_not_found' }, { status: 404 });

    // A session with an owner is that account's. A session without one is a
    // guest's, and the id is the only key to it — the way it has always been.
    if (!(await mayActOnSession(session, request))) {
      return Response.json({ error: 'session_forbidden' }, { status: 403 });
    }

    const messages = await db.listMessages(session.id);

    return Response.json({
      session_id: session.id,
      created_at: session.created_at,
      state: session.state,
      image_quota_left: session.image_quota_left,
      chat_turns_left: chatTurnsLeft(session.id),
      messages: toTranscript(messages),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = PatchBody.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        error: 'invalid_body',
        issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), problem: i.message })),
      },
      { status: 400 },
    );
  }

  try {
    const session = await getDb().getSession(parsed.data.session_id);
    if (!session) return Response.json({ error: 'session_not_found' }, { status: 404 });
    if (!(await mayActOnSession(session, request))) {
      return Response.json({ error: 'session_forbidden' }, { status: 403 });
    }

    // Only the keys that were actually sent. `null` clears a field on purpose;
    // an absent key is not a request to change anything.
    const next: SessionState = { ...session.state };
    if (parsed.data.selected_area !== undefined) next.selected_area = parsed.data.selected_area ?? null;
    if (parsed.data.reference_line !== undefined) {
      next.reference_line = parsed.data.reference_line ?? null;
    }
    if (parsed.data.reference_cm !== undefined) next.reference_cm = parsed.data.reference_cm ?? null;

    await getDb().updateSessionState(parsed.data.session_id, next);

    return Response.json({ session_id: session.id, state: next });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const sessionId = new URL(request.url).searchParams.get('session_id');
  if (!sessionId) {
    return Response.json({ error: 'missing_session_id' }, { status: 400 });
  }

  try {
    const existing = await getDb().getSession(sessionId);
    if (!existing) return Response.json({ error: 'session_not_found' }, { status: 404 });
    if (!(await mayActOnSession(existing, request))) {
      return Response.json({ error: 'session_forbidden' }, { status: 403 });
    }

    // The photos go first: a deleted session whose room photo is still in the
    // bucket is not a deletion.
    const purged = await purgeSession(getDb(), sessionId, getPhotoStore());

    return Response.json({
      deleted: true,
      session_id: sessionId,
      photos_deleted: purged.photos_deleted,
    });
  } catch (err) {
    if (err instanceof PurgeError) {
      // The rows are still there — nothing was lost, and the user can try
      // again. Say so instead of pretending the session is gone.
      return Response.json(
        { error: 'purge_failed', session_id: sessionId, message: err.message },
        { status: 500 },
      );
    }
    return errorResponse(err);
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof MissingEnvError) {
    // Never echo the value, only which key is missing — and the message says
    // what to do about it.
    return Response.json(
      { error: 'server_not_configured', key: err.key, message: err.message },
      { status: 503 },
    );
  }
  const message = err instanceof Error ? err.message : 'unexpected error';
  return Response.json({ error: 'server_error', message }, { status: 500 });
}