/**
 * `npm run seed` against the local adapter, with a catalogue that has rows the
 * seed file does not list.
 *
 * The point is the removal step: the seed file is the catalogue, so anything it
 * no longer names has to leave the database. This runs the real script — the
 * real validation, the real adapter — against a data directory of its own.
 *
 * `ROOMY_DATA_DIR` has to be set before `lib/db/local.ts` is imported, and the
 * script reads it through `process.env`, so both are done here, before the
 * import that pulls the script in.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'roomy-seed-'));
process.env.ROOMY_DATA_DIR = DATA_DIR;
delete process.env.DB_ADAPTER;

const SEED = path.join(process.cwd(), 'data', 'catalog.seed.json');

/** Runs `scripts/seed.ts` and returns what it printed. */
async function runSeed(): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout } = await promisify(execFile)('npx', ['tsx', 'scripts/seed.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, DB_ADAPTER: 'local', ROOMY_DATA_DIR: DATA_DIR },
  });
  return stdout;
}

async function storedProducts(): Promise<{ id: string; price_thb: number }[]> {
  const raw = await fs.readFile(path.join(DATA_DIR, 'products.json'), 'utf8');
  return JSON.parse(raw) as { id: string; price_thb: number }[];
}

afterAll(async () => {
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

describe('npm run seed', () => {
  it('loads the catalogue, then removes the rows the seed no longer lists', async () => {
    const first = await runSeed();
    expect(first).toContain('42 products validated');

    const rows = await storedProducts();
    expect(rows).toHaveLength(42);
    expect(new Set(rows.map((row) => row.id)).size).toBe(42);

    // A row from the earlier, hand-written catalogue — an id the seed file
    // does not have. The next run has to take it away.
    const stale = {
      id: 'ikea-sofa-katja-3',
      source: 'manual',
      source_url: 'https://example.test/katja',
      name_th: 'โซฟาคาตจา',
      name_en: 'KATJA 3-seat sofa',
      category: 'sofa',
      style_tags: ['scandinavian'],
      color: 'grey',
      material: 'fabric',
      price_thb: 12900,
      width_cm: 200,
      depth_cm: 90,
      height_cm: 80,
      image_url: '/product-images/ikea-sofa-katja-3.svg',
      in_stock: true,
    };
    await fs.writeFile(
      path.join(DATA_DIR, 'products.json'),
      `${JSON.stringify([...rows, stale], null, 2)}\n`,
      'utf8',
    );
    expect(await storedProducts()).toHaveLength(43);

    const second = await runSeed();
    expect(second).toContain('removed 1 products that are no longer in the catalogue');
    expect(second).toContain('catalog now contains 42 products');

    const after = await storedProducts();
    expect(after).toHaveLength(42);
    expect(after.map((row) => row.id)).not.toContain('ikea-sofa-katja-3');
  });

  it('is idempotent — a second run changes nothing', async () => {
    const output = await runSeed();
    expect(output).toContain('removed 0 products that are no longer in the catalogue');
    expect(await storedProducts()).toHaveLength(42);
  });
});
