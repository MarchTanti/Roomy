/**
 * The "Simulated image" label.
 *
 * The spec asks for every generated image to carry it. It is burned into the
 * pixels here rather than asked of the image model: a model asked for a caption
 * may skip it, spell it differently, or write it somewhere unreadable, and a
 * missing disclaimer on a picture of someone's room is not a small thing.
 *
 * The text is drawn from the bitmap font in `bitmap.ts` — see the note there
 * for why a real font is not an option here.
 *
 * ---
 *
 * **The app does not burn the label in any more.** The owner asked for the
 * pictures without it (November 2026), so `/api/generate` and
 * `lib/design/render.ts` store the provider's bytes untouched. The module is
 * kept because the spec still asks for the label and because the project has
 * no version control to restore it from.
 *
 * To put the label back, wrap the bytes in those two places again:
 *
 * ```ts
 * const labelled = await applySimulatedLabel(result.bytes);
 * await store.put(sessionId, labelled, { imageId: randomUUID() });
 * ```
 *
 * The interface still says what it is: a picture of a room with a piece of
 * furniture drawn into it is a drawing, and the interface labels it as one
 * under the picture (`ภาพจำลอง` in `app/chat/product-cards.tsx`).
 */

import sharp from 'sharp';

import { GLYPH_HEIGHT, litPixelCount, textColumns, textRects } from './bitmap';

export const SIMULATED_LABEL = 'Simulated image';

/** Padding inside the label box, in device pixels. */
const PADDING = 6;
/** The label never grows past this many device pixels per font pixel. */
const MAX_SCALE = 6;
/** …and never shrinks below one. */
const MIN_SCALE = 1;

export interface LabelLayout {
  /** Top-left corner of the label box. */
  x: number;
  y: number;
  /** Size of the label box. */
  width: number;
  height: number;
  /** Device pixels per font pixel. */
  scale: number;
  /** Where the text starts inside the box. */
  textX: number;
  textY: number;
}

/**
 * Where the label goes and how big it is.
 *
 * Bottom-left, over the image, because that is the one corner that is never
 * the subject of a piece of furniture. The scale is chosen so the text fits
 * the image width, and clamped so the label stays legible without dominating
 * the picture.
 */
export function labelLayout(imageWidth: number, imageHeight: number): LabelLayout {
  const margin = Math.max(8, Math.round(Math.min(imageWidth, imageHeight) * 0.02));
  const available = Math.max(1, imageWidth - margin * 2);
  const columns = Math.max(1, textColumns(SIMULATED_LABEL));
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.floor(available / columns)));

  const width = columns * scale + PADDING * 2;
  const height = GLYPH_HEIGHT * scale + PADDING * 2;

  return {
    x: margin,
    y: Math.max(0, imageHeight - margin - height),
    width,
    height,
    scale,
    textX: margin + PADDING,
    textY: Math.max(0, imageHeight - margin - height) + PADDING,
  };
}

/**
 * Burns the label into the image.
 *
 * The output keeps the input's format and dimensions: a PNG in, a PNG out; a
 * JPEG in, a JPEG out. Anything that reads the image afterwards — the browser,
 * the stored copy — sees the same picture with a label on it.
 */
export async function applySimulatedLabel(input: Buffer): Promise<Buffer> {
  const meta = await sharp(input, { failOn: 'none' }).metadata();
  const width = meta.width;
  const height = meta.height;
  if (!width || !height) {
    throw new Error('Cannot label an image with no readable dimensions');
  }

  const layout = labelLayout(width, height);
  const svg = Buffer.from(
    `<svg width="${layout.width}" height="${layout.height}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="0" y="0" width="${layout.width}" height="${layout.height}" rx="4" fill="#000000" fill-opacity="0.72"/>` +
      textRects(SIMULATED_LABEL, {
        x: PADDING,
        y: PADDING,
        scale: layout.scale,
        fill: '#ffffff',
      }) +
      `</svg>`,
  );

  const pipeline = sharp(input, { failOn: 'none' }).composite([{ input: svg, left: layout.x, top: layout.y }]);

  // Keep the format the provider gave us; the storage layer re-encodes to
  // JPEG afterwards anyway.
  if (meta.format === 'png') return pipeline.png().toBuffer();
  if (meta.format === 'webp') return pipeline.webp().toBuffer();
  return pipeline.jpeg({ quality: 90 }).toBuffer();
}

/**
 * How many device pixels the lit glyphs cover.
 *
 * Exported for the test that proves the label is drawn and not just a black
 * box: the count is derived from the font data, so it cannot drift.
 */
export function expectedLitDevicePixels(scale: number): number {
  return litPixelCount(SIMULATED_LABEL) * scale * scale;
}
