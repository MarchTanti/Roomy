/**
 * Draw a picture for any product that does not have one. `npm run images`
 *
 * Every product in `data/catalog.seed.json` gets an illustration of its own
 * shape, written to `public/product-images/<id>.svg` — unless it already has
 * a picture of the real thing, which is left alone.
 *
 * This script reads the seed file and writes files — it never opens the
 * database. The catalogue rows already point at these file names, so the
 * pictures can be redrawn at any time without touching a single row.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { buildProductSvg, type ArtProduct } from './product-art';

interface SeedRow extends ArtProduct {
  image_url: string;
}

async function main(): Promise<void> {
  const seedPath = path.join(process.cwd(), 'data', 'catalog.seed.json');
  const raw = await fs.readFile(seedPath, 'utf8');
  const rows = JSON.parse(raw) as SeedRow[];

  const directory = path.join(process.cwd(), 'public', 'product-images');
  const existing = await fs.readdir(directory).catch(() => [] as string[]);

  let written = 0;
  let kept = 0;
  for (const row of rows) {
    // Only rows that point at a local picture get one drawn.
    if (!row.image_url.startsWith('/product-images/')) continue;

    // A picture of the real piece is worth more than a drawing of it.
    const hasPicture = existing.some(
      (name) => name === `${row.id}.jpg` || name === `${row.id}.png` || name === `${row.id}.jpeg`,
    );
    if (hasPicture) {
      kept += 1;
      continue;
    }

    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${row.id}.svg`), buildProductSvg(row), 'utf8');
    written += 1;
  }

  console.log(`✓ ${written} product pictures drawn under public/product-images/`);
  console.log(`  (${kept} products already had a picture of the real piece — those were kept)`);
  console.log('  (the catalogue rows are unchanged — they already point at these files)');
}

main().catch((err) => {
  console.error('drawing the product pictures failed:', err);
  process.exit(1);
});
