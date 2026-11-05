/**
 * Drawing a room.
 *
 * The same pipeline the placement route uses, with one difference: there is no
 * single product to place, so the picture is of a whole room and the job row
 * points at no product at all.
 *
 * The order is the one the placement route uses, and for the same reasons:
 *
 *   1. Read the room photo, when the user has one. The design is then a
 *      restyling of *their* room; without one, the room is drawn from the
 *      brief.
 *   2. Read the catalogue's own picture of each piece. The model copies from
 *      them, so the thing in the picture is the thing in the card.
 *   3. Take one unit of the image quota, atomically, before the expensive
 *      call.
 *   4. Record the job, call the image provider, wait for the picture.
 *   5. Store it and link it to the session.
 *
 * A failed drawing still costs one unit of quota, exactly as a failed
 * placement does: giving the unit back needs a second atomic database
 * operation and a migration, and a session that can be pushed over its cap by
 * failing calls is worse than one that spent a unit on an attempt that did not
 * work.
 */

import { randomUUID } from 'node:crypto';

import { getImageProvider, ImageError } from '../image';
import { resolveProductReference, type ReferenceImage } from '../image/reference';
import { getPhotoStore } from '../storage';
import type { DbClient, RoomBrief, Session } from '../db/types';
import { buildRoomRenderPrompt, type PromptPiece } from './prompt';
import type { ResolvedPiece } from './brief';

export interface RoomRenderInput {
  db: DbClient;
  session: Session;
  brief: RoomBrief;
  pieces: ResolvedPiece[];
}

export interface RoomRenderResult {
  image_id: string;
  job_id: string;
  /** The signed URL, when the store can make one. */
  url: string | null;
  expires_at: string | null;
  width: number;
  height: number;
  image_quota_left: number;
}

/**
 * Draws the room and stores the picture.
 *
 * Throws an `ImageError` when the model cannot do it, so the caller can tell
 * a timeout from a refusal.
 */
export async function renderRoom(input: RoomRenderInput): Promise<RoomRenderResult> {
  const { db, session, brief, pieces } = input;
  const store = getPhotoStore();

  // --- the room photo ----------------------------------------------------
  // The user's own room, when they have uploaded one. Without it the room is
  // drawn from the brief alone, which is what the user asked for when they
  // have no photo to give.
  let baseImage: ReferenceImage | null = null;
  const roomImageId = session.state.room_image_id;
  if (roomImageId) {
    const record = await db.getImage(roomImageId);
    if (record) {
      try {
        const bytes = await store.get(record.storage_path, record.session_id);
        baseImage = { bytes, mimeType: 'image/jpeg' };
      } catch (err) {
        // A photo that cannot be read is not a reason to refuse the design:
        // the room is drawn from the brief instead.
        console.error(
          '[design] cannot read the room photo:',
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // --- the catalogue's pictures ------------------------------------------
  // One picture per piece, in the order the pieces are listed. A piece whose
  // row has no picture is described in words instead.
  const referenceImages: ReferenceImage[] = [];
  const promptPieces: PromptPiece[] = [];
  for (const piece of pieces) {
    const reference = await resolveProductReference(piece.image_url);
    if (reference) {
      referenceImages.push(reference);
      promptPieces.push({ ...piece, picture_number: referenceImages.length });
    } else {
      promptPieces.push({ ...piece, picture_number: null });
    }
  }

  const prompt = buildRoomRenderPrompt({
    brief,
    pieces: promptPieces,
    hasBaseImage: baseImage !== null,
  });

  // --- quota --------------------------------------------------------------
  // Taken before the generation call, and atomically: two requests at once
  // must not both see the last unit.
  const quota = await db.consumeImageQuota(session.id);
  if (!quota.ok) {
    throw new ImageError(
      'โควตารูปของเซสชันนี้หมดแล้ว',
      'provider',
    );
  }

  // --- the job -----------------------------------------------------------
  // No product: the picture is of a room, not of one piece.
  const job = await db.createJob({
    session_id: session.id,
    room_image_id: roomImageId,
    product_id: null,
    // The column is NOT NULL, so a design without a measured area records the
    // whole room: "everywhere in this room" rather than a spot nobody chose.
    area: { x: 0, y: 0, w: 1, h: 1 },
  });
  await db.updateJob(job.id, { status: 'running' });

  try {
    const provider = getImageProvider();
    const result = await provider.render({ baseImage, referenceImages, prompt });

    const stored = await store.put(session.id, result.bytes, { imageId: randomUUID() });
    const record = await db.addImage({
      session_id: session.id,
      kind: 'generated',
      storage_path: stored.path,
      product_id: null,
      area: null,
    });
    await db.updateJob(job.id, { status: 'done', result_image_id: record.id });

    let url: string | null = null;
    let expiresAt: string | null = null;
    if (store.sign) {
      try {
        const signed = await store.sign(stored.path);
        url = signed.url;
        expiresAt = signed.expiresAt.toISOString();
      } catch (err) {
        console.error('[design] sign failed:', err instanceof Error ? err.message : err);
      }
    }

    return {
      image_id: record.id,
      job_id: job.id,
      url,
      expires_at: expiresAt,
      width: stored.width,
      height: stored.height,
      image_quota_left: quota.left,
    };
  } catch (err) {
    await db.updateJob(job.id, {
      status: 'failed',
      error: err instanceof Error ? err.message : 'generation failed',
    });
    throw err;
  }
}
