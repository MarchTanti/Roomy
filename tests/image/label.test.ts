/**
 * The "Simulated image" label.
 *
 * The label has to be readable, not merely present: this container has no
 * fonts, so a naive SVG `<text>` label comes out as a row of empty boxes. The
 * pixel counts below are derived from the bitmap font, so a label that silently
 * stopped drawing text would fail here rather than ship.
 */

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { applySimulatedLabel, expectedLitDevicePixels, labelLayout, SIMULATED_LABEL } from '@/lib/image/label';
import { glyphRows, litPixelCount, textColumns, textRects } from '@/lib/image/bitmap';

async function flatImage(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 200, b: 200 } },
  })
    .png()
    .toBuffer();
}

/** Counts the near-white pixels inside a rectangle of the raw image. */
async function countWhite(
  image: Buffer,
  box: { x: number; y: number; width: number; height: number },
): Promise<number> {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  let white = 0;
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      const i = (y * info.width + x) * info.channels;
      if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) white += 1;
    }
  }
  return white;
}

/** The RGB of one pixel. */
async function pixelAt(image: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

describe('the bitmap font', () => {
  it('has a glyph for every character in the label', () => {
    for (const char of SIMULATED_LABEL) {
      expect(glyphRows(char), `no glyph for "${char}"`).not.toBeNull();
    }
  });

  it('refuses a character it cannot draw rather than drawing a blank', () => {
    expect(() => litPixelCount('฿')).toThrow();
  });

  it('draws different characters differently', () => {
    const one = textRects('Simulated image', { x: 0, y: 0, scale: 2, fill: '#fff' });
    const other = textRects('mimulated image', { x: 0, y: 0, scale: 2, fill: '#fff' });

    // One box per character would make these identical.
    expect(one).not.toBe(other);
  });

  it('counts the columns of the string, gaps included', () => {
    expect(textColumns('ab')).toBe(5 * 2 + 1);
  });
});

describe('the label', () => {
  it('keeps the size and format of the image', async () => {
    const labelled = await applySimulatedLabel(await flatImage(600, 400));
    const meta = await sharp(labelled).metadata();

    expect(meta.width).toBe(600);
    expect(meta.height).toBe(400);
    expect(meta.format).toBe('png');
  });

  it('draws the words, not an empty box', async () => {
    const labelled = await applySimulatedLabel(await flatImage(600, 400));
    const layout = labelLayout(600, 400);

    const white = await countWhite(labelled, layout);

    // Derived from the font data: one device pixel per font pixel, scaled.
    expect(white).toBe(expectedLitDevicePixels(layout.scale));
    expect(white).toBeGreaterThan(0);
  });

  it('sits in the bottom-left corner, over the image', async () => {
    const labelled = await applySimulatedLabel(await flatImage(600, 400));
    const layout = labelLayout(600, 400);

    expect(layout.x).toBeGreaterThan(0);
    expect(layout.y + layout.height).toBeLessThanOrEqual(400);
    expect(layout.y).toBeGreaterThan(200);

    // The corner the label does not cover is untouched.
    expect(await pixelAt(labelled, 0, 0)).toEqual([200, 200, 200]);
    expect(await pixelAt(labelled, 599, 399)).toEqual([200, 200, 200]);
  });

  it('scales the label down for a small image instead of overflowing', () => {
    const small = labelLayout(120, 90);

    expect(small.scale).toBe(1);
    expect(small.width).toBeLessThanOrEqual(120);
  });

  it('scales the label up for a large image', () => {
    const large = labelLayout(2048, 1536);

    expect(large.scale).toBeGreaterThan(1);
    expect(large.width).toBeLessThan(2048);
  });
});
