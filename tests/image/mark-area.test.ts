/**
 * The marker drawn on the room photo.
 *
 * The area is normalised (0..1 per axis), so the test uses a region whose
 * position in pixels is known exactly — which is the whole point of the
 * overlay: the image model is told where to put the piece by being shown it.
 */

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { markArea } from '@/lib/image/mark-area';

async function flatImage(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 200, b: 200 } },
  })
    .png()
    .toBuffer();
}

async function pixelAt(image: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

describe('marking the target area', () => {
  it('keeps the size and format of the photo', async () => {
    const marked = await markArea(await flatImage(600, 400), { x: 0.1, y: 0.2, w: 0.5, h: 0.4 });
    const meta = await sharp(marked).metadata();

    expect(meta.width).toBe(600);
    expect(meta.height).toBe(400);
    expect(meta.format).toBe('png');
  });

  it('draws something inside the area', async () => {
    const plain = await flatImage(600, 400);
    const marked = await markArea(plain, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });

    // The middle of the region gets the orange wash.
    const middle = await pixelAt(marked, 300, 200);
    expect(middle).not.toEqual([200, 200, 200]);
    expect(middle[0]).toBeGreaterThan(middle[2]); // more red than blue
  });

  it('leaves the rest of the photo alone', async () => {
    const plain = await flatImage(600, 400);
    const marked = await markArea(plain, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });

    // Above and to the left of the region.
    expect(await pixelAt(marked, 10, 10)).toEqual([200, 200, 200]);
    expect(await pixelAt(marked, 590, 390)).toEqual([200, 200, 200]);
  });

  it('draws the outline on the edge of the region', async () => {
    const marked = await markArea(await flatImage(600, 400), { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });

    // The top edge of the region: y = 0.25 * 400 = 100.
    const edge = await pixelAt(marked, 300, 100);
    expect(edge).not.toEqual([200, 200, 200]);
  });
});
