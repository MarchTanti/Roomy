/**
 * Image generation.
 *
 *   POST /api/generate   { session_id, product_id, placement, instruction? }
 *
 *   → 201 { image_id, url, expires_at, job_id, width, height, image_quota_left,
 *           product, space, fit }
 *
 * The flow, and why it is in this order:
 *
 *   1. Refuse a request that carries no prompt. A placement is made for a
 *      request the user wrote — the sentence they typed in the chat — and
 *      without one there is nothing to place.
 *   2. Resolve the session and the product. Both come from the database, and
 *      the product's dimensions are never taken from the request — the spec is
 *      explicit that sizes come from the rows, not from anything a client (or
 *      a model) says.
 *   3. Require a room photo. There is nothing to edit without one.
 *   4. Measure the space, if the user measured one on the photo. The same
 *      scale rule as the fit check, so the number in the prompt is the number
 *      the fit check used.
 *   5. Read the catalogue's own picture of the piece, when there is one. The
 *      model copies from it, so the thing in the room is the thing in the
 *      card and not a lookalike. No picture is no problem: the piece is
 *      described in words instead.
 *   6. Take one unit of the image quota — atomically, before the expensive
 *      call. The quota is what bounds how many images a session can cost.
 *   7. Record a job, call the image provider, wait for the picture.
 *   8. Store it and link it to the session.
 *
 * The request waits for the result. A generation takes seconds, not
 * milliseconds, so this is deliberately the one route that is not a chat turn:
 * the caller gets the picture or an error, never a job id to poll.
 *
 * A failed generation still costs one unit of quota. The alternative — giving
 * the unit back — needs a second atomic database operation and a migration on
 * the Supabase side, and a session that can be pushed over its cap by failing
 * calls is worse than one that spends a unit on an attempt that did not work.
 */

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { getDb } from '@/lib/db';
import type { DbClient, SessionState } from '@/lib/db/types';
import { MissingEnvError } from '@/lib/env';
import {
  areaToSpace,
  deriveScale,
  evaluateFit,
  fitToJson,
  spaceToJson,
  type FitSpace,
} from '@/lib/fit';
import { buildImagePrompt } from '@/lib/image/prompt';
import { getImageProvider, ImageError } from '@/lib/image';
import { markArea } from '@/lib/image/mark-area';
import { resolveProductReference } from '@/lib/image/reference';
import { mayActOnSession } from '@/lib/session/ownership';
import { getPhotoStore, readDimensions } from '@/lib/storage';

export const dynamic = 'force-dynamic';
/** A generation is slower than a chat turn; the platform needs to know. */
export const maxDuration = 120;

const GenerateBody = z
  .object({
    session_id: z.string().uuid(),
    product_id: z.string().min(1),
    /**
     * What the user asked for, in their own words.
     *
     * The sentence they wrote in the chat that asked for this piece. It is
     * required: a placement is never made for a request nobody wrote, and the
     * picture follows this sentence rather than the app's guess.
     */
    placement: z.string().trim().min(1).max(300).optional(),
    /**
     * The change the user asked for, in their own words.
     *
     * Present → this request is another version of the same piece. Absent →
     * the first version, or a re-roll of one that already exists.
     */
    instruction: z.string().trim().min(1).max(300).optional(),
    /**
     * The changes already applied in the earlier versions of this same piece.
     *
     * The client sends them back because the server keeps the pictures, not
     * the requests that produced them: without the earlier requests, "make it
     * even smaller" has nothing to be smaller than.
     */
    previous_instructions: z.array(z.string().trim().min(1).max(300)).max(5).optional(),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = GenerateBody.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_body', issues: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }
  const { session_id: sessionId, product_id: productId } = parsed.data;

  // A placement is made for a request the user wrote. The client sends the
  // sentence they typed in the chat that asked for this piece; a later version
  // of the same piece also carries the change they asked for. Without one of
  // the two there is nothing to place — the picture would be the app's guess —
  // so the request is refused here, before any work and before the quota is
  // touched.
  if (!parsed.data.placement && !parsed.data.instruction) {
    return Response.json(
      {
        error: 'no_placement_prompt',
        message: 'ยังไม่มีคำขอของคุณ พิมพ์บอกว่าอยากได้ห้องแบบไหนก่อน แล้วผมจะวางให้ดู',
      },
      { status: 400 },
    );
  }

  try {
    const db = getDb();

    const session = await db.getSession(sessionId);
    if (!session) return Response.json({ error: 'session_not_found' }, { status: 404 });
    if (!(await mayActOnSession(session, request))) {
      return Response.json({ error: 'session_forbidden' }, { status: 403 });
    }

    const product = await db.getProduct(productId);
    if (!product) return Response.json({ error: 'product_not_found' }, { status: 404 });

    const roomImageId = session.state.room_image_id;
    if (!roomImageId) {
      return Response.json(
        { error: 'no_room_photo', message: 'ยังไม่มีรูปห้อง กรุณาอัปโหลดรูปห้องก่อน' },
        { status: 409 },
      );
    }

    const roomRecord = await db.getImage(roomImageId);
    if (!roomRecord) {
      return Response.json({ error: 'room_photo_not_found' }, { status: 409 });
    }

    // Resolved before anything is spent: a server with no API key configured
    // should say so, not take a unit of the user's quota and then fail.
    const provider = getImageProvider();

    // --- the room photo and the space ------------------------------------
    const store = getPhotoStore();
    let roomBytes: Buffer;
    try {
      roomBytes = await store.get(roomRecord.storage_path, sessionId);
    } catch (err) {
      console.error('[api/generate] cannot read the room photo:', err instanceof Error ? err.message : err);
      return Response.json({ error: 'room_photo_unreadable' }, { status: 409 });
    }

    const space = await measuredSpace(session.state, roomBytes);
    const area = session.state.selected_area;

    // The catalogue's own picture of the piece, when there is one. The model
    // copies from it, so the thing in the room is the thing in the card and
    // not a sofa that merely fits the description. It is read before the
    // quota is touched: a picture that cannot be read must not cost the user
    // a unit, and the generation goes on without it either way.
    const reference = await resolveProductReference(product.image_url);

    // --- quota -----------------------------------------------------------
    // Taken before the generation call, and atomically: two requests at once
    // must not both see the last unit.
    const quota = await db.consumeImageQuota(sessionId);
    if (!quota.ok) {
      return Response.json(
        {
          error: 'image_quota_exhausted',
          image_quota_left: 0,
          message: 'โควตารูปที่สร้างของเซสชันนี้หมดแล้ว เริ่มเซสชันใหม่เพื่อสร้างรูปเพิ่มได้',
        },
        { status: 429 },
      );
    }

    // --- the job ---------------------------------------------------------
    // Which version of this piece in this room this is. The chain is per
    // session and product, so a new product starts a new chain and every
    // re-roll of the same piece continues the one before it.
    const version = await nextVersionNumber(db, sessionId, product.id);

    const job = await db.createJob({
      session_id: sessionId,
      room_image_id: roomImageId,
      product_id: product.id,
      // The column is NOT NULL, so a job without a measured area records the
      // whole photo: "anywhere in this room" rather than a spot nobody chose.
      area: area ?? { x: 0, y: 0, w: 1, h: 1 },
    });
    await db.updateJob(job.id, { status: 'running' });

    try {
      // The change requests, oldest first. The user's words go into the prompt
      // as data — the template says so, and the template is ours.
      const instructions = [
        ...(parsed.data.previous_instructions ?? []),
        ...(parsed.data.instruction ? [parsed.data.instruction] : []),
      ];

      const prompt = buildImagePrompt({
        product,
        space,
        roomAnalysis: session.state.room_analysis,
        hasReference: reference !== null,
        placement: parsed.data.placement,
        instructions,
      });

      // The marker goes on the copy that leaves the server. The stored room
      // photo is never touched.
      const marked = area ? await markArea(roomBytes, area) : roomBytes;

      const result = await provider.render({
        baseImage: { bytes: marked, mimeType: 'image/jpeg' },
        referenceImages: reference ? [reference] : [],
        prompt,
      });

      const stored = await store.put(sessionId, result.bytes, { imageId: randomUUID() });
      const record = await db.addImage({
        session_id: sessionId,
        kind: 'generated',
        storage_path: stored.path,
        product_id: product.id,
        area,
      });
      await db.updateJob(job.id, { status: 'done', result_image_id: record.id });

      await db.updateSessionState(sessionId, {
        ...session.state,
        selected_product_id: product.id,
        generated_image_ids: [...session.state.generated_image_ids, record.id].slice(-12),
      });

      // --- serve ---------------------------------------------------------
      let url: string | null = null;
      let expiresAt: string | null = null;
      if (store.sign) {
        try {
          const signed = await store.sign(stored.path);
          url = signed.url;
          expiresAt = signed.expiresAt.toISOString();
        } catch (err) {
          console.error('[api/generate] sign failed:', err instanceof Error ? err.message : err);
        }
      }

      const fit = space ? evaluateFit(product, space) : null;

      return Response.json(
        {
          image_id: record.id,
          url,
          expires_at: expiresAt,
          job_id: job.id,
          width: stored.width,
          height: stored.height,
          image_quota_left: quota.left,
          /** Which version of this piece this is: 1 for the first one. */
          version,
          /** The change requests that produced it, oldest first. */
          instructions,
          product: {
            id: product.id,
            name_th: product.name_th,
            width_cm: product.width_cm,
            depth_cm: product.depth_cm,
            height_cm: product.height_cm,
            price_thb: product.price_thb,
          },
          space: space ? spaceToJson(space) : null,
          fit: fit ? fitToJson(fit) : null,
        },
        { status: 201 },
      );
    } catch (err) {
      await db.updateJob(job.id, {
        status: 'failed',
        error: err instanceof Error ? err.message : 'generation failed',
      });

      if (err instanceof ImageError) {
        const timeout = err.reason === 'timeout';
        return Response.json(
          {
            error: timeout ? 'generation_timeout' : 'generation_failed',
            message: timeout
              ? 'ใช้เวลานานเกินไปในการสร้างรูป ลองใหม่อีกครั้ง'
              : 'สร้างรูปไม่สำเร็จ ลองใหม่อีกครั้ง',
            job_id: job.id,
          },
          { status: timeout ? 504 : 502 },
        );
      }

      console.error('[api/generate] failed:', err instanceof Error ? err.stack : err);
      return Response.json(
        { error: 'generation_failed', message: 'สร้างรูปไม่สำเร็จ', job_id: job.id },
        { status: 500 },
      );
    }
  } catch (err) {
    if (err instanceof MissingEnvError) {
      return Response.json(
        { error: 'server_not_configured', key: err.key, message: err.message },
        { status: 503 },
      );
    }
    console.error('[api/generate] failed:', err instanceof Error ? err.stack : err);
    return Response.json({ error: 'generation_failed' }, { status: 500 });
  }
}

/**
 * The space the user measured on the photo, in centimetres.
 *
 * The same scale rule as the fit check, so the prompt and the fit verdict
 * cannot disagree about the size of the gap. Null when nothing was measured —
 * the picture is still worth making, the model is just asked to choose a spot.
 */
async function measuredSpace(state: SessionState, roomBytes: Buffer): Promise<FitSpace | null> {
  const { selected_area: area, reference_line: line, reference_cm: referenceCm } = state;
  if (!area || !line || referenceCm === null) return null;

  const { width, height } = await readDimensions(roomBytes);
  const scale = deriveScale(line, referenceCm, width / height);
  if (!scale) return null;
  return areaToSpace(area, scale);
}

/**
 * Which version of this piece in this room comes next.
 *
 * The chain is the pictures of one product in one session, in the order they
 * were made. No extra column is needed for it: the images table already knows
 * the product and the time.
 */
async function nextVersionNumber(db: DbClient, sessionId: string, productId: string): Promise<number> {
  const images = await db.listImages(sessionId);
  const made = images.filter((image) => image.kind === 'generated' && image.product_id === productId);
  return made.length + 1;
}
