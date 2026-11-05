/**
 * One-off probe. Confirms the image model accepts the piece's own picture as
 * a second image and still answers with a picture.
 *
 *   npx tsx scripts/probe-image.ts
 *
 * Makes one real image call. It writes nothing to the database and sends no
 * user data: the "room" is a drawing made here, and the piece is the
 * catalogue's own picture. The result is written to `/tmp/roomy-probe-image.png`
 * so it can be looked at.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

import { buildImagePrompt } from '../lib/image/prompt';
import { createGeminiImageProvider } from '../lib/image/gemini';
import { resolveProductReference } from '../lib/image/reference';
import { loadEnvLocal } from './_load-env';
import type { Product } from '../lib/db/types';

loadEnvLocal();

/** A room to put something in: a wall, a floor, and a window. */
async function room(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="700">
    <rect width="900" height="700" fill="#efe9e1"/>
    <rect y="430" width="900" height="270" fill="#c9b79b"/>
    <rect x="90" y="90" width="260" height="300" fill="#cfe3f2" stroke="#9db8cc" stroke-width="8"/>
    <path d="M220 90v300M90 240h260" stroke="#9db8cc" stroke-width="6"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

/**
 * The piece to try the picture with: the first sofa of the catalogue that has
 * a picture on disk. Falls back to the seed file, so the probe still works
 * whichever catalogue is in place.
 */
async function pickProduct(): Promise<Product> {
  for (const file of ['data/catalog.fetched.json', 'data/catalog.seed.json']) {
    const raw = await fs.readFile(path.join(process.cwd(), file), 'utf8').catch(() => null);
    if (!raw) continue;
    const rows = JSON.parse(raw) as Product[];
    const sofa = rows.find((row) => row.category === 'sofa' && row.image_url.startsWith('/product-images/'));
    if (sofa) return sofa;
  }
  throw new Error('no sofa with a picture found in the catalogue');
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    console.error('GEMINI_API_KEY not set in .env.local');
    process.exit(1);
  }

  const product = await pickProduct();
  const reference = await resolveProductReference(product.image_url);
  console.log('piece:', product.name_en, product.image_url);
  console.log('reference:', reference ? `${reference.mimeType}, ${reference.bytes.length} bytes` : 'none');

  const provider = createGeminiImageProvider(apiKey);
  const prompt = buildImagePrompt({
    product: { ...product, id: 'probe' },
    space: { width_cm: 220, depth_cm: 120, height_cm: null },
    roomAnalysis: null,
    hasReference: reference !== null,
  });

  const result = await provider.render({
    baseImage: { bytes: await room(), mimeType: 'image/jpeg' },
    referenceImages: reference ? [reference] : [],
    prompt,
  });

  await fs.writeFile('/tmp/roomy-probe-image.png', result.bytes);
  console.log('wrote /tmp/roomy-probe-image.png', result.width, 'x', result.height, result.contentType);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
