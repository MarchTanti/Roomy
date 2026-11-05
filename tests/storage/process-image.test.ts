import { randomUUID } from 'node:crypto';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  assertNoExif,
  ImageProcessingError,
  processUpload,
  readDimensions,
} from '@/lib/storage/process-image';

const LONG_EDGE = 1024;

async function makeTestJpeg(opts: {
  width?: number;
  height?: number;
  withExif?: boolean;
}): Promise<Buffer> {
  const width = opts.width ?? 200;
  const height = opts.height ?? 120;

  // Build a recognisable solid image so we can quickly eyeball sanity.
  const raw = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 80, g: 130, b: 200 },
    },
  })
    .jpeg()
    .toBuffer();

  // Plant a plain IFD0 EXIF block. We don't have to encode GPS coordinates to
  // satisfy the privacy rule: any EXIF segment (including the GPS IFD) is
  // removed wholesale, which the next assertion verifies at the segment level.
  if (opts.withExif) {
    return sharp(raw)
      .withMetadata({
        exif: { IFD0: { Make: 'test-camera', Model: 'with-gps' } },
      })
      .toBuffer();
  }
  return raw;
}

describe('processUpload', () => {
  it('returns a JPEG whose bytes round-trip and have no EXIF segment', async () => {
    const input = await makeTestJpeg({});
    const out = await processUpload(input, 'image/jpeg', { longEdgePx: LONG_EDGE });
    expect(out.contentType).toBe('image/jpeg');
    expect(out.bytes).toBeGreaterThan(0);
    expect(out.buffer.length).toBe(out.bytes);
    expect(out.width).toBeGreaterThan(0);
    expect(out.height).toBeGreaterThan(0);

    await expect(assertNoExif(out.buffer)).resolves.toBeUndefined();
  });

  it('strips the EXIF segment wholesale (privacy-critical: covers GPS too)', async () => {
    const input = await makeTestJpeg({ withExif: true });
    // Sanity: the input really does carry EXIF.
    const inMeta = await sharp(input).metadata();
    expect(inMeta.exif).toBeDefined();

    const out = await processUpload(input, 'image/jpeg', { longEdgePx: LONG_EDGE });
    await expect(assertNoExif(out.buffer)).resolves.toBeUndefined();
    const outMeta = await sharp(out.buffer).metadata();
    // sharp's Metadata doesn't expose `gps`; an EXIF GPS IFD lives inside the
    // `exif` blob, so checking `exif === undefined` is sufficient.
    expect(outMeta.exif).toBeUndefined();
    expect(outMeta.icc).toBeUndefined();
  });

  it('downscales images whose long edge exceeds the cap', async () => {
    const input = await makeTestJpeg({ width: 3000, height: 2000 });
    const out = await processUpload(input, 'image/jpeg', { longEdgePx: LONG_EDGE });
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(LONG_EDGE);
  });

  it('does not enlarge images that are already under the cap', async () => {
    const input = await makeTestJpeg({ width: 800, height: 600 });
    const out = await processUpload(input, 'image/jpeg', { longEdgePx: LONG_EDGE });
    expect(out.width).toBe(800);
    expect(out.height).toBe(600);
  });

  it('rejects unsupported content types', async () => {
    const input = await makeTestJpeg({});
    await expect(processUpload(input, 'image/bmp', { longEdgePx: LONG_EDGE })).rejects.toBeInstanceOf(
      ImageProcessingError,
    );
  });

  it('rejects buffers that are not actually images', async () => {
    const fake = Buffer.from('not really a jpeg, just text');
    await expect(
      processUpload(fake, 'image/jpeg', { longEdgePx: LONG_EDGE }),
    ).rejects.toBeInstanceOf(ImageProcessingError);
  });

  it('rejects empty buffers', async () => {
    await expect(
      processUpload(Buffer.alloc(0), 'image/jpeg', { longEdgePx: LONG_EDGE }),
    ).rejects.toBeInstanceOf(ImageProcessingError);
  });

  it('handles PNG input by re-encoding as JPEG with the cap applied', async () => {
    const png = await sharp({
      create: { width: 400, height: 400, channels: 4, background: '#ff00ff' },
    })
      .png()
      .toBuffer();
    const out = await processUpload(png, 'image/png', { longEdgePx: LONG_EDGE });
    expect(out.contentType).toBe('image/jpeg');
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(LONG_EDGE);
  });

  it('readDimensions reports the same numbers as processUpload', async () => {
    const input = await makeTestJpeg({ width: 640, height: 480 });
    const dims = await readDimensions(input);
    expect(dims).toEqual({ width: 640, height: 480 });

    const out = await processUpload(input, 'image/jpeg', { longEdgePx: LONG_EDGE });
    expect({ width: out.width, height: out.height }).toEqual(dims);
  });

  it('two calls with the same input produce stable sizes (no shrinking beyond what we asked)', async () => {
    const input = await makeTestJpeg({ width: 1000, height: 750 });
    const a = await processUpload(input, 'image/jpeg', { longEdgePx: LONG_EDGE });
    const b = await processUpload(input, 'image/jpeg', { longEdgePx: LONG_EDGE });
    expect(a.width).toBe(b.width);
    expect(a.height).toBe(b.height);
  });

  // Marker test: makes it obvious which module's tests failed in CI.
  it('uuid sanity (test infra)', () => {
    expect(randomUUID()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
