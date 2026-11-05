/**
 * Marks the target area on the room photo.
 *
 * The area the user dragged is a rectangle in normalised photo coordinates.
 * An image model cannot be told "put it in the region from 20% to 60% of the
 * width" reliably — so we draw the region instead, and the prompt asks for the
 * marker to be removed from the result.
 *
 * The marked copy is what goes to the image provider. The stored room photo is
 * never modified.
 */

import sharp from 'sharp';

import type { Area } from '../db/types';

/** The marker colour. Orange reads clearly against most interiors. */
const MARKER_COLOR = '#ff7a00';

/**
 * Draws an outline (and a faint wash) around the area.
 *
 * The stroke width scales with the image so it stays visible on a phone photo
 * and does not swamp a small one.
 */
export async function markArea(input: Buffer, area: Area): Promise<Buffer> {
  const meta = await sharp(input, { failOn: 'none' }).metadata();
  const width = meta.width;
  const height = meta.height;
  if (!width || !height) {
    throw new Error('Cannot mark an image with no readable dimensions');
  }

  const left = Math.round(area.x * width);
  const top = Math.round(area.y * height);
  const boxWidth = Math.max(1, Math.round(area.w * width));
  const boxHeight = Math.max(1, Math.round(area.h * height));
  const stroke = Math.max(3, Math.round(Math.min(width, height) / 300));

  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="${left}" y="${top}" width="${boxWidth}" height="${boxHeight}" ` +
      `fill="${MARKER_COLOR}" fill-opacity="0.10" stroke="${MARKER_COLOR}" stroke-width="${stroke}"/>` +
      `</svg>`,
  );

  const pipeline = sharp(input, { failOn: 'none' }).composite([{ input: svg, left: 0, top: 0 }]);

  if (meta.format === 'png') return pipeline.png().toBuffer();
  if (meta.format === 'webp') return pipeline.webp().toBuffer();
  return pipeline.jpeg({ quality: 92 }).toBuffer();
}
