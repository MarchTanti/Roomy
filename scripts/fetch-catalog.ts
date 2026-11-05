/**
 * Rebuild the catalogue from the shops' own catalogues.
 *
 *   npm run fetch:catalog                 # writes data/catalog.fetched.json
 *   npm run fetch:catalog -- --refresh    # asks the shops again
 *   npm run fetch:catalog -- --out data/catalog.seed.json   # replaces the seed
 *
 * What it does, in order:
 *
 *   1. walks IKEA's Thailand product sitemaps and HomePro's category pages
 *      to find the pieces we want, by category;
 *   2. opens each product page and reads the real numbers — price in baht,
 *      width, depth, height, colour, material, stock;
 *   3. downloads the picture and keeps it under public/product-images/;
 *   4. writes the catalogue, and a sources file beside it, so it is always
 *      clear where every row came from.
 *
 * By default it writes a new file and leaves `data/catalog.seed.json` alone;
 * replacing that file is a deliberate act (`--out`).
 *
 * Nothing here writes to the database. Seeding the database is a separate
 * step (`npm run seed`), and that one is the user's to run.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { candidates as ikeaCandidates, readProduct as readIkeaProduct } from './catalog/ikea';
import { candidates as homeproCandidates, readProduct as readHomeproProduct } from './catalog/homepro';
import { saveProductImage } from './catalog/images';
import { buildRow, rowId } from './catalog/rows';
import { CATEGORIES, type Candidate, type CatalogCategory, type CatalogSource } from './catalog/types';
import type { Product } from '../lib/db/types';

/**
 * How many pieces of each kind the catalogue holds, and where they come from.
 *
 * The split is a preference, not a rule: when one shop cannot fill its share,
 * the other one makes up the difference, so the catalogue keeps its size.
 */
const TARGETS: Record<CatalogCategory, { count: number; ikea: number; homepro: number }> = {
  sofa: { count: 5, ikea: 3, homepro: 2 },
  armchair: { count: 4, ikea: 2, homepro: 2 },
  table: { count: 6, ikea: 4, homepro: 2 },
  chair: { count: 3, ikea: 1, homepro: 2 },
  shelf: { count: 4, ikea: 3, homepro: 1 },
  lamp: { count: 4, ikea: 3, homepro: 1 },
  bed: { count: 4, ikea: 3, homepro: 1 },
  desk: { count: 3, ikea: 2, homepro: 1 },
  cabinet: { count: 3, ikea: 2, homepro: 1 },
  rug: { count: 2, ikea: 1, homepro: 1 },
  tv_stand: { count: 2, ikea: 1, homepro: 1 },
  dresser: { count: 2, ikea: 2, homepro: 0 },
};

interface Provenance {
  id: string;
  source: CatalogSource;
  source_url: string;
  picture_from: string;
  fetched_at: string;
}

/** Where the catalogue is written. The old seed file is left alone by default. */
function outputPath(): string {
  const flag = process.argv.indexOf('--out');
  if (flag >= 0 && process.argv[flag + 1]) return process.argv[flag + 1];
  return 'data/catalog.fetched.json';
}

/** How many candidates of each kind we still want. */
function wanted(): Map<CatalogCategory, number> {
  return new Map(CATEGORIES.map((category) => [category, TARGETS[category].count * 2]));
}

interface Built {
  row: Product;
  provenance: Provenance;
}

/** Reads one candidate and turns it into a row, picture included. */
async function buildRowFor(candidate: Candidate): Promise<Built | { reason: string }> {
  const read = candidate.source === 'ikea' ? await readIkeaProduct(candidate) : await readHomeproProduct(candidate);
  if (!read.ok) return { reason: read.reason };

  const product = read.product;
  const id = rowId(product);
  const picture = await saveProductImage(id, product.image_url);
  if (!picture) return { reason: 'the picture could not be downloaded' };

  return {
    row: buildRow(product, picture.url),
    provenance: {
      id,
      source: product.source,
      source_url: product.source_url,
      picture_from: picture.from,
      fetched_at: new Date().toISOString(),
    },
  };
}

/** The candidates of one shop and one kind, in the order the shop lists them. */
function pool(candidates: Candidate[], source: CatalogSource, category: CatalogCategory): Candidate[] {
  return candidates.filter((candidate) => candidate.source === source && candidate.category === category);
}

/**
 * Which model a candidate is.
 *
 * IKEA names a piece after its series ("VISKAFORS"); HomePro after its brand
 * ("FURDINI"). Two pieces of the same model are the same piece in two
 * colours, so the catalogue takes one of each model before it takes a second.
 */
function modelOf(candidate: Candidate): string {
  if (candidate.brand) return candidate.brand.toLowerCase();
  return (candidate.name_en.trim().split(/\s+/)[0] ?? '').toLowerCase();
}

/**
 * The next piece to try, from a shop's list for one kind.
 *
 * A model already in the catalogue is passed over while a model that is not
 * in it is still waiting further down the list, so the pieces end up as
 * different from each other as the shop's range allows.
 */
function nextCandidate(
  candidates: Candidate[],
  source: CatalogSource,
  category: CatalogCategory,
  used: Set<string>,
  taken: Set<string>,
): Candidate | undefined {
  const list = pool(candidates, source, category).filter((candidate) => !taken.has(candidate.url));

  const fresh = list.find((candidate) => !used.has(modelOf(candidate)));
  if (fresh) return fresh;

  return list.find((candidate) => !taken.has(modelOf(candidate)));
}

async function main(): Promise<void> {
  console.log('reading the catalogues…');

  const need = wanted();
  const ikea = await ikeaCandidates((found) =>
    CATEGORIES.every((category) => (found.get(category) ?? 0) >= need.get(category)!),
  );
  console.log(`  ikea: ${ikea.length} candidates`);

  const homepro = await homeproCandidates((found) =>
    CATEGORIES.every((category) => (found.get(category) ?? 0) >= need.get(category)!),
  );
  console.log(`  homepro: ${homepro.length} candidates`);

  const candidates = [...ikea, ...homepro];
  const rows: Product[] = [];
  const provenance: Provenance[] = [];
  const tried = new Set<string>();
  const models = new Map<CatalogCategory, Set<string>>();

  for (const category of CATEGORIES) {
    const target = TARGETS[category];
    const used = models.get(category) ?? new Set<string>();
    models.set(category, used);
    const taken = new Set<string>();
    let held = 0;

    // First each shop fills its own share; then the other one makes up the
    // difference if a shop cannot fill its share.
    for (const source of ['ikea', 'homepro'] as CatalogSource[]) {
      const quota = target[source];
      let filled = 0;

      while (filled < quota) {
        const candidate = nextCandidate(candidates, source, category, used, taken);
        if (!candidate) break;
        taken.add(candidate.url);
        tried.add(candidate.url);

        const built = await buildRowFor(candidate);
        if ('reason' in built) {
          console.log(`  skipped ${candidate.name_en} — ${built.reason}`);
          continue;
        }
        rows.push(built.row);
        provenance.push(built.provenance);
        used.add(modelOf(candidate));
        filled += 1;
        held += 1;
        console.log(
          `  ${built.row.name_en} — THB ${built.row.price_thb.toLocaleString('en-US')} — ` +
            `${built.row.width_cm}×${built.row.depth_cm}×${built.row.height_cm} cm`,
        );
      }
    }

    // Whatever is still missing is taken from whichever shop still has pieces
    // of this kind that have not been tried yet.
    while (held < target.count) {
      let candidate: Candidate | undefined;
      for (const source of ['ikea', 'homepro'] as CatalogSource[]) {
        candidate = nextCandidate(candidates, source, category, used, taken);
        if (candidate) break;
      }
      if (!candidate) break;
      taken.add(candidate.url);
      tried.add(candidate.url);

      const built = await buildRowFor(candidate);
      if ('reason' in built) {
        console.log(`  skipped ${candidate.name_en} — ${built.reason}`);
        continue;
      }
      rows.push(built.row);
      provenance.push(built.provenance);
      used.add(modelOf(candidate));
      held += 1;
      console.log(
        `  ${built.row.name_en} — THB ${built.row.price_thb.toLocaleString('en-US')} — ` +
          `${built.row.width_cm}×${built.row.depth_cm}×${built.row.height_cm} cm`,
      );
    }

    if (held < target.count) {
      console.log(`  ${category}: ${held} of ${target.count}`);
    }
  }

  const missing = CATEGORIES.filter((category) => {
    const held = rows.filter((row) => row.category === category).length;
    return held < TARGETS[category].count;
  });
  if (missing.length > 0) {
    console.log(`\ncategories short of their target: ${missing.join(', ')}`);
  }

  rows.sort((a, b) => a.category.localeCompare(b.category) || a.price_thb - b.price_thb);

  const out = outputPath();
  const seedPath = path.join(process.cwd(), out);
  await fs.writeFile(seedPath, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  console.log(`\n✓ ${rows.length} products written to ${out}`);

  const sourcePath = seedPath.replace(/\.json$/, '.sources.json');
  await fs.writeFile(sourcePath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  console.log(`✓ ${provenance.length} sources recorded in ${path.basename(sourcePath)}`);

  console.log('\nNext: npm run seed   (that one writes to the database — it is yours to run)');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
