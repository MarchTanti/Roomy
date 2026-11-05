/**
 * Seed the catalog. `npm run seed`
 *
 * Reads `data/catalog.seed.json`, validates each row, writes the product's
 * picture to `public/product-images/<id>.svg` for every product whose
 * `image_url` points at a local path, upserts the rows through the active
 * DbClient, drops any product the catalogue no longer lists, and finally
 * runs a test query to prove the catalog round-trips.
 *
 * The full set of accepted `npm run seed` exit codes:
 *   0 = all rows upserted and the test query returned >= 1 row
 *   1 = any validation error or write error
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { getDb } from '../lib/db';
import type { Product, ProductSource } from '../lib/db/types';
import { buildProductSvg } from './product-art';
import { loadEnvLocal } from './_load-env';

loadEnvLocal();

// ---------------------------------------------------------------------------
// Zod schema mirrors the `Product` type in lib/db/types.ts.
// Kept in this file so the seed stays self-contained.
// ---------------------------------------------------------------------------

const ProductSourceSchema = z.enum(['ikea', 'homepro', 'manual']) satisfies z.ZodType<ProductSource>;

const ProductSchema = z.object({
  id: z.string().min(1),
  source: ProductSourceSchema,
  source_url: z.string().url(),
  name_th: z.string().min(1),
  name_en: z.string().min(1),
  category: z.string().min(1),
  style_tags: z.array(z.string().min(1)).min(1),
  color: z.string().nullable(),
  material: z.string().nullable(),
  price_thb: z.number().nonnegative(),
  width_cm: z.number().positive(),
  depth_cm: z.number().positive(),
  height_cm: z.number().positive(),
  image_url: z.string().min(1),
  in_stock: z.boolean(),
});

const CatalogSchema = z.array(ProductSchema).min(30).max(50);

// ---------------------------------------------------------------------------
// Product images
// ---------------------------------------------------------------------------

/**
 * Makes sure a product has a picture on disk.
 *
 * A row that points at a picture we already have — the real photograph the
 * catalogue was fetched with — keeps it. A row without one gets a drawn
 * illustration, so a card is never empty.
 *
 * The file name is the product id, so the `image_url` a catalogue row already
 * holds stays valid — the picture changes, the row does not.
 *
 * Returns whether a picture was actually drawn.
 */
async function writeProductImage(product: Product): Promise<boolean> {
  // Only handle local picture paths. Real CDN URLs are left alone — the
  // catalogue can already name a product that we haven't drawn yet.
  if (!product.image_url.startsWith('/product-images/')) return false;

  const directory = path.join(process.cwd(), 'public', 'product-images');
  const existing = await fs.readdir(directory).catch(() => [] as string[]);
  const hasPicture = existing.some(
    (name) => name === `${product.id}.jpg` || name === `${product.id}.png` || name === `${product.id}.jpeg`,
  );
  if (hasPicture) return false;

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${product.id}.svg`), buildProductSvg(product), 'utf8');
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const seedPath = path.join(process.cwd(), 'data', 'catalog.seed.json');
  const raw = await fs.readFile(seedPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);

  const result = CatalogSchema.safeParse(parsed);
  if (!result.success) {
    console.error('catalog.seed.json failed validation:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
    process.exit(1);
  }

  const products: Product[] = result.data;
  console.log(`✓ ${products.length} products validated`);

  // 1. Write the product pictures first so the DB row's image_url is never
  //    pointing at a missing file.
  let imagesWritten = 0;
  for (const product of products) {
    if (await writeProductImage(product)) imagesWritten += 1;
  }
  console.log(
    imagesWritten === 0
      ? '✓ every product already has a picture — none drawn'
      : `✓ ${imagesWritten} product pictures drawn under public/product-images/`,
  );

  // 2. Upsert through the active adapter.
  const db = getDb();
  const inserted = await db.upsertProducts(products);
  console.log(`✓ upserted ${inserted} products via ${db.constructor?.name ?? 'DbClient'}`);

  // 3. Drop the products the catalogue no longer lists. The seed file is the
  //    catalogue, so a piece that has dropped out of it has to go — otherwise
  //    the bot keeps offering furniture whose picture the app no longer has.
  const removed = await db.deleteProductsExcept(products.map((product) => product.id));
  console.log(`✓ removed ${removed} products that are no longer in the catalogue`);

  const total = await db.countProducts();
  console.log(`✓ catalog now contains ${total} products`);

  // 3. Test query: cheapest in-stock sofa, then cheapest in-stock bed.
  const sofas = await db.searchProducts({ category: 'sofa', in_stock_only: true, limit: 3 });
  const beds = await db.searchProducts({ category: 'bed', limit: 2 });

  console.log('\nTest query — cheapest in-stock sofas:');
  if (sofas.length === 0) {
    console.error('  (no sofas returned — the seed is broken)');
    process.exit(1);
  }
  for (const s of sofas) {
    console.log(`  • ${s.name_en}  THB ${s.price_thb.toLocaleString('en-US')}  ${s.width_cm}×${s.depth_cm}×${s.height_cm} cm  tags=${s.style_tags.join(',')}`);
  }

  console.log('\nTest query — cheapest 2 beds:');
  for (const b of beds) {
    console.log(`  • ${b.name_en}  THB ${b.price_thb.toLocaleString('en-US')}`);
  }

  console.log('\nDone. `npm run dev` to start the app at http://localhost:3000');
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
