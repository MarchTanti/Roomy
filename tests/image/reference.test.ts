/**
 * The catalogue's own picture of the piece, as a reference for the model.
 *
 * The rule this file exists to protect: the model is sent the *actual* item
 * whenever the catalogue has a picture of it, and a source the server will
 * not follow is refused rather than fetched.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveProductReference } from '@/lib/image/reference';

let publicDir: string;

beforeEach(async () => {
  publicDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roomy-public-'));
  process.env.ROOMY_PUBLIC_DIR = publicDir;
  await fs.mkdir(path.join(publicDir, 'product-images'), { recursive: true });
});

afterEach(() => {
  delete process.env.ROOMY_PUBLIC_DIR;
});

/** A small drawing of a sofa, standing in for a catalogue picture. */
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
  <rect width="640" height="480" fill="#ffffff"/>
  <rect x="100" y="200" width="440" height="160" rx="20" fill="#a7abb0"/>
</svg>`;

describe('the product reference', () => {
  it('reads the catalogue picture out of the public folder', async () => {
    await fs.writeFile(path.join(publicDir, 'product-images', 'sofa-1.svg'), SVG);

    const reference = await resolveProductReference('/product-images/sofa-1.svg');

    expect(reference).not.toBeNull();
    expect(reference!.mimeType).toBe('image/png');
    const meta = await sharp(reference!.bytes).metadata();
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(480);
  });

  it('sends a drawing as a picture, because the model takes no SVG', async () => {
    await fs.writeFile(path.join(publicDir, 'product-images', 'sofa-1.svg'), SVG);

    const reference = await resolveProductReference('/product-images/sofa-1.svg');

    expect(reference!.mimeType).toBe('image/png');
    expect(reference!.bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('re-encodes a photograph as JPEG and keeps it small', async () => {
    const photo = await sharp({
      create: { width: 2400, height: 1800, channels: 3, background: { r: 200, g: 180, b: 160 } },
    })
      .jpeg()
      .toBuffer();
    await fs.writeFile(path.join(publicDir, 'product-images', 'sofa-1.jpg'), photo);

    const reference = await resolveProductReference('/product-images/sofa-1.jpg');

    expect(reference!.mimeType).toBe('image/jpeg');
    const meta = await sharp(reference!.bytes).metadata();
    expect(meta.width).toBe(1024);
    expect(meta.height).toBe(768);
  });

  it('goes without a picture when the file is not there', async () => {
    const reference = await resolveProductReference('/product-images/missing.svg');

    expect(reference).toBeNull();
  });

  it('goes without a picture when the row has none', async () => {
    expect(await resolveProductReference('')).toBeNull();
    expect(await resolveProductReference(null)).toBeNull();
    expect(await resolveProductReference(undefined)).toBeNull();
  });

  it('refuses a path that points outside the catalogue folder', async () => {
    await fs.writeFile(path.join(publicDir, 'secret.svg'), SVG);

    expect(await resolveProductReference('/product-images/../secret.svg')).toBeNull();
    expect(await resolveProductReference('/roomyai-icon.png')).toBeNull();
  });

  it('refuses a plain http address', async () => {
    expect(await resolveProductReference('http://example.test/sofa.jpg')).toBeNull();
  });

  it('refuses an address that points at the machine itself', async () => {
    expect(await resolveProductReference('https://localhost/sofa.jpg')).toBeNull();
    expect(await resolveProductReference('https://127.0.0.1/sofa.jpg')).toBeNull();
    expect(await resolveProductReference('https://192.168.1.10/sofa.jpg')).toBeNull();
  });
});
