/**
 * The image provider interface.
 *
 * The same shape as the LLM provider: the route asks for a picture and never
 * learns which service drew it. Swapping the image backend is one file plus
 * one line in `index.ts`.
 *
 * There is one method, `render`, and it covers both jobs the app has:
 *
 *   - **placing a piece** — a room photo to edit, plus the piece's own
 *     picture, and the picture comes back with the piece in the room;
 *   - **designing a room** — a brief, plus the pictures of the catalogue
 *     pieces the room has to have, and sometimes a room photo to restyle.
 *
 * The difference is only whether there is a picture to start from. A render
 * with no base picture is drawn from the prompt alone; one with a base
 * picture is an edit of it. The prompt says which, and the pictures travel in
 * the order the prompt describes: the base picture first, then the
 * references.
 */

import type { ReferenceImage } from './reference';

export interface ImageRequest {
  /**
   * The picture to start from.
   *
   * The room photo, when the user has one: the render is then an edit of that
   * room. Absent, the picture is created from the prompt alone.
   */
  baseImage?: ReferenceImage | null;
  /**
   * The catalogue pictures of the pieces, oldest first.
   *
   * They are what makes the thing in the picture the thing in the card: the
   * model copies the item instead of drawing one that merely fits the
   * description. The prompt says which is which. An empty list is normal —
   * a piece whose row has no picture is described in words instead.
   */
  referenceImages: readonly ReferenceImage[];
  /**
   * The instruction, built from the catalogue rows and the user's own words.
   * The provider gets it verbatim — it is the app's wording, not the model's.
   */
  prompt: string;
  /**
   * The shape of the picture, when the caller cares.
   *
   * "4:3", "1:1" and the rest, as the provider understands them. Left unset,
   * the provider picks the shape for itself — which is what the placement
   * route wants, since it is editing a photo that already has a shape.
   */
  aspectRatio?: string;
}

export interface ImageResult {
  bytes: Buffer;
  contentType: string;
  width: number;
  height: number;
}

export interface ImageProvider {
  readonly id: string;
  render(request: ImageRequest): Promise<ImageResult>;
}

export type ImageFailure = 'timeout' | 'provider' | 'no_image';

export class ImageError extends Error {
  constructor(
    message: string,
    readonly reason: ImageFailure = 'provider',
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ImageError';
  }
}
