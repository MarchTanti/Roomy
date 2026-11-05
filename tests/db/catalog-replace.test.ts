/**
 * Replacing the catalogue — `deleteProductsExcept`.
 *
 * The seed file is the catalogue, not a set of patches. When it changes, the
 * pieces it no longer lists have to leave the database: the bot would keep
 * offering a sofa whose photograph the app no longer has, and the sweep in
 * `lib/results/catalogue-fit.ts` would judge furniture that is not there.
 *
 * These tests run against the real local adapter and the real files on disk,
 * because the assertions are about what is left in `products.json` — and about
 * the rows that point at a deleted product.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DbClient, Product } from '@/lib/db/types';

// lib/db/local.ts snapshots ROOMY_DATA_DIR into a module-level const at import
// time, and a static import is hoisted above anything in this body. These
// tests write real rows, so they need a data dir of their own.
const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'roomy-catalog-'));
process.env.ROOMY_DATA_DIR = DATA_DIR;
delete process.env.DB_ADAPTER;

let getDb: () => DbClient;
let resetDb: () => void;

beforeAll(async () => {
  ({ getDb, resetDb } = await import('@/lib/db'));
});

beforeEach(async () => {
  resetDb();
  // The collection lives in a file on disk, so it survives from one test to
  // the next. Each test starts from an empty catalogue.
  await fs.rm(path.join(DATA_DIR, 'products.json'), { force: true });
});

function product(id: string, overrides: Partial<Product> = {}): Product {
  return {
    id,
    source: 'manual',
    source_url: `https://example.test/${id}`,
    name_th: `สินค้า ${id}`,
    name_en: `Product ${id}`,
    category: 'sofa',
    style_tags: ['modern'],
    color: 'white',
    material: 'wood',
    price_thb: 1000,
    width_cm: 100,
    depth_cm: 50,
    height_cm: 80,
    image_url: `/product-images/${id}.svg`,
    in_stock: true,
    ...overrides,
  };
}

/** The product ids currently in the collection file. */
async function storedIds(): Promise<string[]> {
  const raw = await fs.readFile(path.join(DATA_DIR, 'products.json'), 'utf8');
  return (JSON.parse(raw) as Product[]).map((row) => row.id).sort();
}

describe('deleteProductsExcept', () => {
  it('removes the products that are not in the keep list', async () => {
    const db = getDb();
    await db.upsertProducts([product('old-a'), product('old-b'), product('keep')]);

    const removed = await db.deleteProductsExcept(['keep']);

    expect(removed).toBe(2);
    expect(await storedIds()).toEqual(['keep']);
  });

  it('leaves the catalogue alone when every id is kept', async () => {
    const db = getDb();
    await db.upsertProducts([product('a'), product('b')]);

    const removed = await db.deleteProductsExcept(['a', 'b']);

    expect(removed).toBe(0);
    expect(await storedIds()).toEqual(['a', 'b']);
  });

  it('is idempotent — a second run removes nothing', async () => {
    const db = getDb();
    await db.upsertProducts([product('old-a'), product('keep')]);

    await db.deleteProductsExcept(['keep']);
    const removed = await db.deleteProductsExcept(['keep']);

    expect(removed).toBe(0);
    expect(await storedIds()).toEqual(['keep']);
  });

  it('empties the catalogue when nothing is kept', async () => {
    const db = getDb();
    await db.upsertProducts([product('a'), product('b')]);

    const removed = await db.deleteProductsExcept([]);

    expect(removed).toBe(2);
    expect(await storedIds()).toEqual([]);
  });

  it('keeps a placed image but drops its reference to the deleted product', async () => {
    const db = getDb();
    await db.upsertProducts([product('gone'), product('stays')]);
    const session = await db.createSession();
    const image = await db.addImage({
      session_id: session.id,
      kind: 'generated',
      storage_path: `${session.id}/image.jpg`,
      product_id: 'gone',
    });

    await db.deleteProductsExcept(['stays']);

    const stored = await db.getImage(image.id);
    expect(stored).not.toBeNull();
    expect(stored?.product_id).toBeNull();
  });
});
