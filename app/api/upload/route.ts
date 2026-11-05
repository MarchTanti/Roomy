/**
 * Room photo upload.
 *
 *   POST /api/upload   multipart/form-data   { session_id, file }
 *
 *   → 201 { image_id, url, expires_at, analysis, image_quota_left }
 *
 * Flow:
 *   1. Resolve the session (404) and validate the file.
 *   2. Strip EXIF, resize and re-encode through sharp — before the bytes reach
 *      storage, so location data is never written in the first place.
 *   3. Store the photo, record it in `images`.
 *   4. Analyse it once, here, and write the result into session state.
 *
 * Uploads deliberately do **not** take a unit of `image_quota_left`. That quota
 * is the budget for generated images — the ones that cost a generation call and
 * are the reason the limit exists. Charging a user for looking at their own room
 * would spend that budget before they ever get a result.
 *
 * They are capped separately, at `ROOM_PHOTOS_PER_SESSION` (default 4), so one
 * session cannot fill the bucket. The cap counts room photos only; generated
 * images live in the same table under a different `kind` and are bounded by the
 * quota instead.
 *
 * Step 4 is the design point worth explaining. The spec keeps `room_image_id`
 * and `room_analysis` as two separate fields, which only makes sense if the
 * photo is analysed once and the *result* is what the model reads on later
 * turns. Doing it here rather than waiting for the model to call `analyzeRoom`
 * keeps a chat turn at one model step instead of two — and every extra step
 * costs the user four to five seconds of measured wall clock.
 *
 * A failed analysis is not a failed upload. The photo is already stored and the
 * user can still browse it, so the response says `analysis: null` and the
 * conversation carries on.
 */

import { z } from 'zod';

import { getDb } from '@/lib/db';
import type { RoomAnalysis } from '@/lib/db/types';
import { MissingEnvError, settings } from '@/lib/env';
import { getRoomAnalyzer } from '@/lib/llm';
import { mayActOnSession } from '@/lib/session/ownership';
import { getPhotoStore, ImageProcessingError } from '@/lib/storage';

export const dynamic = 'force-dynamic';
/** Vision round trips on a resized photo; generous but bounded. */
export const maxDuration = 60;

const SessionField = z.string().uuid();

/** Refuses the content types sharp will not open, before we buffer the body. */
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function POST(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { error: 'invalid_form', message: 'ส่งไฟล์แบบ multipart/form-data โดยมีฟิลด์ session_id และ file' },
      { status: 400 },
    );
  }

  const sessionId = SessionField.safeParse(form.get('session_id'));
  if (!sessionId.success) {
    return Response.json({ error: 'invalid_session_id' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return Response.json({ error: 'missing_file' }, { status: 400 });
  }
  if (file.size === 0) {
    return Response.json({ error: 'empty_file' }, { status: 400 });
  }

  const maxBytes = settings.maxUploadMb() * 1024 * 1024;
  if (file.size > maxBytes) {
    return Response.json(
      {
        error: 'file_too_large',
        max_mb: settings.maxUploadMb(),
        message: `ไฟล์ใหญ่เกินไป กรุณาเลือกไฟล์ที่ไม่เกิน ${settings.maxUploadMb()} MB`,
      },
      { status: 413 },
    );
  }

  const declaredType = (file.type || '').split(';')[0].trim().toLowerCase();
  if (declaredType && !ACCEPTED_TYPES.has(declaredType)) {
    return Response.json(
      { error: 'unsupported_type', accepted: [...ACCEPTED_TYPES] },
      { status: 415 },
    );
  }

  let db: ReturnType<typeof getDb>;
  let session: Awaited<ReturnType<ReturnType<typeof getDb>['getSession']>>;
  try {
    db = getDb();
    session = await db.getSession(sessionId.data);
  } catch (err) {
    if (err instanceof MissingEnvError) {
      return Response.json(
        { error: 'server_not_configured', key: err.key, message: err.message },
        { status: 503 },
      );
    }
    throw err;
  }
  if (!session) {
    return Response.json({ error: 'session_not_found' }, { status: 404 });
  }
  if (!(await mayActOnSession(session, request))) {
    return Response.json({ error: 'session_forbidden' }, { status: 403 });
  }

  // Counted before storing anything, so a session at the cap costs no storage
  // and no vision call.
  //
  // Room photos only: generated images share this table and are bounded by the
  // image quota, not here.
  const maxRoomPhotos = settings.roomPhotosPerSession();
  const roomPhotos = (await db.listImages(sessionId.data)).filter((img) => img.kind === 'room');
  if (roomPhotos.length >= maxRoomPhotos) {
    return Response.json(
      {
        error: 'room_photo_limit_reached',
        room_photos_uploaded: roomPhotos.length,
        room_photos_limit: maxRoomPhotos,
        message: `คุณอัปโหลดรูปห้องครบ ${maxRoomPhotos} รูปแล้ว เริ่มเซสชันใหม่เพื่ออัปโหลดเพิ่มได้`,
      },
      { status: 429 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const store = getPhotoStore();

  let uploaded: Awaited<ReturnType<typeof store.put>>;
  try {
    uploaded = await store.put(sessionId.data, buffer);
  } catch (err) {
    if (err instanceof ImageProcessingError) {
      return Response.json({ error: 'unreadable_image', message: err.message }, { status: 415 });
    }
    console.error('[api/upload] store failed:', err instanceof Error ? err.stack : err);
    return Response.json(
      { error: 'upload_failed', message: err instanceof Error ? err.message : 'อัปโหลดไม่สำเร็จ' },
      { status: 500 },
    );
  }

  const record = await db.addImage({
    session_id: sessionId.data,
    kind: 'room',
    storage_path: uploaded.path,
  });

  // --- analyse (best effort) ------------------------------------------------
  let analysis: RoomAnalysis | null = null;
  let analysisError: string | null = null;
  try {
    // The *processed* bytes, not the upload. The raw file still carries the
    // EXIF the pipeline just stripped, and those bytes leave the building here.
    analysis = await getRoomAnalyzer().analyze(uploaded.buffer.toString('base64'));
  } catch (err) {
    // The photo is stored and usable; only the description is missing.
    console.error('[api/upload] analysis failed:', err instanceof Error ? err.message : err);
    analysisError = err instanceof Error ? err.message : 'วิเคราะห์รูปห้องไม่สำเร็จ';
  }

  await db.updateSessionState(sessionId.data, {
    ...session.state,
    room_image_id: record.id,
    // A failed re-analysis must not leave a stale description pointing at the
    // photo the user just replaced.
    room_analysis: analysis,
    // Any measurement on the old photo measured the old room. Keeping it would
    // let checkFit answer confidently about a room the user has left.
    selected_area: null,
    reference_line: null,
    reference_cm: null,
  });

  // --- serve ----------------------------------------------------------------
  let url: string | null = null;
  let expiresAt: string | null = null;
  if (store.sign) {
    try {
      const signed = await store.sign(record.storage_path);
      url = signed.url;
      expiresAt = signed.expiresAt.toISOString();
    } catch (err) {
      console.error('[api/upload] sign failed:', err instanceof Error ? err.message : err);
    }
  }

  return Response.json(
    {
      image_id: record.id,
      url,
      expires_at: expiresAt,
      width: uploaded.width,
      height: uploaded.height,
      analysis,
      analysis_error: analysisError,
      // The generation budget, which an upload does not move.
      image_quota_left: session.image_quota_left,
      room_photos_uploaded: roomPhotos.length + 1,
      room_photos_limit: maxRoomPhotos,
    },
    { status: 201 },
  );
}