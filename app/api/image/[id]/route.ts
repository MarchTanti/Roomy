/**
 * Serves one stored photo.
 *
 *   GET /api/image/[id]
 *
 * Two reasons this exists rather than handing the browser a bucket URL:
 *
 *   - The local photo store has no signing key, so there is no URL to hand out.
 *   - It keeps ownership checking in one place. The id alone is not authority —
 *     the row is looked up and matched against the session the caller names.
 *
 * With the Supabase store it 302s to the signed URL, which expires in an hour
 * per the spec. With the local store it streams the bytes and says so in a
 * header, because a `Cache-Control: private` response is not the same promise as
 * a one-hour signed URL and the client should not pretend otherwise.
 */

import { getDb } from '@/lib/db';
import { mayActOnSession } from '@/lib/session/ownership';
import { getPhotoStore, PhotoStoreError } from '@/lib/storage';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;

  const sessionId = new URL(request.url).searchParams.get('session_id');
  if (!sessionId) {
    return Response.json({ error: 'missing_session_id' }, { status: 400 });
  }

  const record = await getDb().getImage(id);
  if (!record) {
    return Response.json({ error: 'image_not_found' }, { status: 404 });
  }
  if (record.session_id !== sessionId) {
    // 404 rather than 403: confirming a photo exists in some other session is
    // itself information the caller is not entitled to.
    return Response.json({ error: 'image_not_found' }, { status: 404 });
  }

  // The photo belongs to a session, and a session with an owner belongs to an
  // account. The row is looked up, so the picture is not served on the strength
  // of the session id alone.
  const session = await getDb().getSession(record.session_id);
  if (!session || !(await mayActOnSession(session, request))) {
    return Response.json({ error: 'image_not_found' }, { status: 404 });
  }

  const store = getPhotoStore();

  if (store.sign) {
    const signed = await store.sign(record.storage_path);
    return Response.redirect(signed.url, 302);
  }

  let bytes: Buffer;
  try {
    bytes = await store.get(record.storage_path, record.session_id);
  } catch (err) {
    if (err instanceof PhotoStoreError) {
      return Response.json({ error: 'image_unreadable', message: err.message }, { status: 500 });
    }
    throw err;
  }

  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(bytes.length),
      'Cache-Control': 'private, max-age=3600',
      // Marks that the server streamed the bytes instead of redirecting to a
      // signed URL, so the client can skip re-signing.
      'X-Roomy-Direct': '1',
    },
  });
}