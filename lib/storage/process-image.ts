/**
 * Image pre-processing for uploads.
 *
 * The spec requires "Strip EXIF metadata (including location) on upload" before
 * anything else touches the bytes. This module runs the input buffer through
 * sharp and returns a sanitised JPEG that:
 *
 *   - has no EXIF, no GPS, no ICC profile, no XMP
 *   - has a long edge no greater than `settings.uploadLongEdgePx()` (default 1536)
 *   - is re-encoded as JPEG with a sensible quality
 *
 * It is a pure function over `Buffer`s and contains no I/O, so it can be unit
 * tested without any network.
 */

import sharp, { type Metadata as SharpMetadata } from 'sharp';

import { settings } from '../env';

export type ProcessedContentType = 'image/jpeg';

export interface ProcessedImage {
  buffer: Buffer;
  bytes: number;
  contentType: ProcessedContentType;
  width: number;
  height: number;
}

export interface ProcessOptions {
  /** Override the long-edge target. Defaults to settings.uploadLongEdgePx(). */
  longEdgePx?: number;
  /** JPEG quality 1..100. Default 82. */
  quality?: number;
}

const ALLOWED_INPUT_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export class ImageProcessingError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ImageProcessingError';
  }
}

/**
 * Run the input through sharp: auto-orient, drop all metadata, resize,
 * re-encode as JPEG.
 *
 * Throws `ImageProcessingError` for unsupported content types or unreadable
 * input. The returned `buffer` is safe to upload to the private bucket.
 */
export async function processUpload(
  input: Buffer,
  originalContentType: string | undefined,
  opts: ProcessOptions = {},
): Promise<ProcessedImage> {
  if (!Buffer.isBuffer(input)) throw new ImageProcessingError('Input is not a Buffer');
  if (input.length === 0) throw new ImageProcessingError('Empty input buffer');

  const declared = originalContentType?.trim().toLowerCase();
  if (declared && !ALLOWED_INPUT_TYPES.has(declared)) {
    throw new ImageProcessingError(`Unsupported content type: ${declared}`);
  }

  const longEdge = opts.longEdgePx ?? settings.uploadLongEdgePx();
  const quality = opts.quality ?? 82;

  // First decode to inspect the source dimensions — this also throws if the
  // bytes are not actually an image.
  let probe: SharpMetadata;
  try {
    probe = await sharp(input, { failOn: 'none' }).metadata();
  } catch (err) {
    throw new ImageProcessingError('Input is not a readable image', err);
  }
  if (!probe.width || !probe.height) {
    throw new ImageProcessingError('Image has no readable dimensions');
  }

  // The pipeline:
  //   1. `.rotate()` — auto-orient using EXIF orientation, then drop the tag.
  //      Without an explicit angle, this is sharp's standard EXIF-strip path.
  //   2. `.resize({ inside, withoutEnlargement })` — never grow past the cap.
  //   3. `.jpeg(...)` — re-encode as JPEG. We never call `.withMetadata(...)`,
  //      so sharp's default EXIF strip stays in effect.
  const out = await sharp(input, { failOn: 'none' })
    .rotate()
    .resize({
      width: longEdge,
      height: longEdge,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality, mozjpeg: true, progressive: true })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: out.data,
    bytes: out.data.length,
    contentType: 'image/jpeg',
    width: out.info.width,
    height: out.info.height,
  };
}

/**
 * Defence-in-depth: re-reads the output buffer and confirms there is no
 * EXIF / GPS / XMP segment left. Useful from the smoke test, and as a final
 * assert at upload time.
 */
export async function assertNoExif(buffer: Buffer): Promise<void> {
  const meta = await sharp(buffer).metadata();
  if (meta.exif) throw new ImageProcessingError('EXIF segment still present in output');
  if (meta.icc) throw new ImageProcessingError('ICC profile still present in output');
  if (meta.xmp) throw new ImageProcessingError('XMP segment still present in output');
}

/** Convenience helper: best-effort pixel dimensions without re-encoding. */
export async function readDimensions(buffer: Buffer): Promise<{ width: number; height: number }> {
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) throw new ImageProcessingError('Cannot read image dimensions');
  return { width: meta.width, height: meta.height };
}
