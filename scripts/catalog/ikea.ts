/**
 * Reading IKEA's own catalogue.
 *
 * Two places, both of them things IKEA publishes for machines:
 *
 *   - `https://www.ikea.com/sitemaps/sitemap.xml` points at one product
 *     sitemap per shop. The Thailand one lists every product page, with the
 *     pictures that go with it.
 *   - every product page carries a JSON-LD block with the product's own
 *     numbers: price in baht, width, depth, height, colour, material, and
 *     the article number, plus a JSON payload with the dimensions in full.
 *
 * Both are allowed by ikea.com/robots.txt — the rules there are about search
 * results and filtered listings, not about product pages.
 */

import { fetchDocument, fetchText } from './http';
import { translateColour, translateMaterial } from './thai';
import type { Candidate, CatalogCategory, ReadResult } from './types';

const SITEMAP_INDEX = 'https://www.ikea.com/sitemaps/sitemap.xml';

/**
 * Which IKEA product is which of our categories.
 *
 * The order matters: the first rule that matches the product's name in the
 * URL wins, so the specific ones come before the general ones. The names are
 * matched word by word — "vegetable" is not a "table", and "bedside" is not a
 * "bed".
 */
const RULES: { category: CatalogCategory; match: RegExp; skip?: RegExp }[] = [
  { category: 'armchair', match: /\b(armchairs?|chairs? with armrests?)\b/, skip: /\b(cover|sleeve|cushion|protector|outdoor)\b/ },
  { category: 'sofa', match: /\bsofas?\b/, skip: /\b(cover|sleeve|cushion|protector|replacement|outdoor)\b/ },
  { category: 'lamp', match: /\b(lamps?|pendants?|chandeliers?)\b/, skip: /\b(cover|shade|bulb|fitting|candle\w*|holder)\b/ },
  { category: 'tv_stand', match: /\b(tv stands?|tv benches?|tv units?|tv storage|tv cabinets?|tv tables?)\b/ },
  { category: 'bed', match: /\bbeds?\b/, skip: /\b(cover|mattress|bedside|nightstand|headboard|bolster|sheet|duvet|pillow|pet|dog|cat)\b/ },
  { category: 'chair', match: /\bchairs?\b/, skip: /\b(cover|rocking|pad|outdoor)\b/ },
  { category: 'desk', match: /\bdesks?\b/, skip: /\b(cover|chair|organiser|organizer|desk tops?)\b/ },
  { category: 'dresser', match: /\b(chests? of drawers?|dressers?)\b/, skip: /\bcover\b/ },
  { category: 'cabinet', match: /\b(cabinets?|sideboards?|cupboards?|wardrobes?)\b/, skip: /\b(cover|lighting)\b/ },
  { category: 'table', match: /\btables?\b/, skip: /\b(cover|nightstand|dressing|outdoor)\b/ },
  { category: 'shelf', match: /\b(shelves|shelving|bookcases?)\b/, skip: /\b(shower|bracket|upright)\b/ },
  { category: 'rug', match: /\b(rugs?|carpets?)\b/, skip: /\b(cover|cutting)\b/ },
];

interface JsonLd {
  '@type'?: string;
  name?: string;
  sku?: string;
  mpn?: string;
  category?: string;
  color?: string;
  material?: string;
  width?: string;
  depth?: string;
  height?: string;
  image?: { contentUrl?: string }[] | string;
  url?: string;
  offers?: { price?: string | number; priceCurrency?: string; availability?: string };
}

/** Reads the JSON-LD product block out of a product page. */
export function readJsonLd(html: string): JsonLd | null {
  const blocks = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g) ?? [];
  for (const block of blocks) {
    const inner = block.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
    try {
      const parsed = JSON.parse(inner) as JsonLd | JsonLd[];
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      const product = entries.find((entry) => entry?.['@type'] === 'Product');
      if (product) return product;
    } catch {
      // A block that is not JSON is not our problem; keep looking.
    }
  }
  return null;
}

/** Every object in a parsed JSON tree. */
export function* walk(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) yield* walk(item);
    return;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    yield record;
    for (const item of Object.values(record)) yield* walk(item);
  }
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/** One measurement on the page: a name and the value it was given. */
export interface Measurement {
  name: string;
  value: number;
}

/** The units IKEA measures in, and how many centimetres each one is. */
const UNITS: { unit: string; centimetres: number }[] = [
  { unit: 'มม.', centimetres: 0.1 },
  { unit: 'ซม.', centimetres: 1 },
  { unit: 'ม.', centimetres: 100 },
  { unit: 'mm', centimetres: 0.1 },
  { unit: 'cm', centimetres: 1 },
  { unit: 'm', centimetres: 100 },
];

/**
 * The length in centimetres that a measurement reads "88 ซม." or "1.8 ม.".
 *
 * A measurement in any other unit — kilos, watts, square metres — is not a
 * length, and is left out.
 */
export function centimetres(measure: string): number | null {
  const match = measure.match(/^\s*(\d+(?:[.,]\d+)?)\s*(.*?)\s*$/);
  if (!match) return null;

  const value = Number.parseFloat(match[1].replace(',', '.'));
  if (!Number.isFinite(value)) return null;

  const unit = match[2].toLowerCase();
  const known = UNITS.find((candidate) => candidate.unit.toLowerCase() === unit);
  if (!known) return null;

  const result = value * known.centimetres;
  return result > 0 ? Math.round(result * 10) / 10 : null;
}

/**
 * Every measurement on the page, in centimetres.
 *
 * The page carries two sets: the piece's own dimensions in Thai, and the
 * measurements of the box it arrives in, in English. Only the Thai ones
 * describe the piece, so only those are read.
 */
export function readMeasurements(html: string): Measurement[] {
  const found: Measurement[] = [];
  const seen = new Set<string>();
  const blocks = html.match(/<script type="text\/hydrate"[^>]*>([\s\S]*?)<\/script>/g) ?? [];

  for (const block of blocks) {
    const inner = block.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
    let parsed: unknown;
    try {
      parsed = JSON.parse(inner);
    } catch {
      continue;
    }
    for (const entry of walk(parsed)) {
      const measurements = entry['measurements'];
      if (!Array.isArray(measurements)) continue;
      for (const measurement of measurements) {
        const row = measurement as { name?: string; measure?: string };
        if (!row.name || !row.measure) continue;
        if (!/[฀-๿]/.test(row.name)) continue; // the box, not the piece
        const value = centimetres(row.measure);
        if (value === null) continue;
        const key = `${row.name}=${value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ name: row.name, value });
      }
    }
  }
  return found;
}

/** The measurement with this exact name — the largest one, if there are several. */
function exact(measurements: Measurement[], name: string): number | null {
  const values = measurements.filter((row) => row.name === name).map((row) => row.value);
  return values.length === 0 ? null : Math.max(...values);
}

/**
 * The widest circle on the page — a lamp's shade, a round table's top.
 *
 * A lamp measures both its shade and the plate it hangs from; the shade is
 * the piece itself, so that one wins. Otherwise the largest circle is the
 * piece: a coffee table's top, not its column.
 */
function diameter(measurements: Measurement[]): number | null {
  const shades = measurements
    .filter((row) => row.name.includes('โป๊ะโคม'))
    .map((row) => row.value);
  if (shades.length > 0) return Math.max(...shades);

  const plain = measurements
    .filter((row) => row.name === 'เส้นผ่านศูนย์กลาง')
    .map((row) => row.value);
  if (plain.length > 0) return Math.max(...plain);

  const circles = measurements
    .filter((row) => row.name.includes('เส้นผ่านศูนย์'))
    .map((row) => row.value);
  return circles.length === 0 ? null : Math.max(...circles);
}

/** The width of the piece. */
export function pickWidth(measurements: Measurement[]): number | null {
  return (
    exact(measurements, 'ความกว้าง') ??
    exact(measurements, 'โต๊ะกว้าง') ??
    exact(measurements, 'ความกว้างเตียง') ??
    diameter(measurements)
  );
}

/** The depth of the piece — how far it reaches from the wall. */
export function pickDepth(measurements: Measurement[]): number | null {
  return (
    exact(measurements, 'ความลึก') ??
    exact(measurements, 'โต๊ะลึก') ??
    exact(measurements, 'ความลึกสูงสุด') ??
    exact(measurements, 'ความลึกต่ำสุด') ??
    exact(measurements, 'ความลึกเมื่อปรับเป็นเตียง') ??
    exact(measurements, 'ความยาว') ??
    exact(measurements, 'ความยาวเตียง') ??
    diameter(measurements)
  );
}

/** The height of the piece. */
export function pickHeight(measurements: Measurement[]): number | null {
  return (
    exact(measurements, 'ความสูง') ??
    exact(measurements, 'โต๊ะสูง') ??
    exact(measurements, 'ความสูงสูงสุด') ??
    exact(measurements, 'ความสูงต่ำสุด') ??
    exact(measurements, 'ความสูงเตียง') ??
    exact(measurements, 'ความสูงจากพื้นถึงเตียง') ??
    exact(measurements, 'ความหนา')
  );
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Which of our categories a product page belongs to, judged by its URL. */
export function categorise(slug: string): CatalogCategory | null {
  const words = ` ${slug.replace(/-/g, ' ')} `;
  for (const rule of RULES) {
    if (!rule.match.test(words)) continue;
    if (rule.skip?.test(words)) continue;
    return rule.category;
  }
  return null;
}

/**
 * The English name, from the URL.
 *
 * "vretstorp-3-seat-sofa-bed-kilanda-light-beige-s59491237" →
 * "VRETSTORP 3-seat sofa bed kilanda light beige".
 */
export function englishNameFromSlug(slug: string): string {
  const cleaned = slug.replace(/-s?\d{6,8}$/, '');
  const words = cleaned.split('-').filter(Boolean);
  if (words.length === 0) return slug;
  const [series, ...rest] = words;
  const description = rest
    .join(' ')
    .replace(/(\d)-(\d)/g, '$1.$2')
    .replace(/(\d+) seat/g, '$1-seat');
  return description ? `${series.toUpperCase()} ${description}` : series.toUpperCase();
}

/** The item number in the URL: the digits at the end of it. */
export function itemNumberOf(slug: string): string {
  return slug.match(/(\d{6,8})$/)?.[1] ?? '';
}

/**
 * The product's own entry on the page, found by its item number.
 *
 * A page also carries the products it recommends, and those have names and
 * item numbers of their own; only the entry that matches the item number in
 * the URL describes the piece being looked at.
 */
function itemEntry(html: string, itemNo: string): Record<string, unknown> | null {
  if (!itemNo) return null;
  const blocks = html.match(/<script type="text\/hydrate"[^>]*>([\s\S]*?)<\/script>/g) ?? [];

  for (const block of blocks) {
    const inner = block.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
    let parsed: unknown;
    try {
      parsed = JSON.parse(inner);
    } catch {
      continue;
    }
    for (const entry of walk(parsed)) {
      if (entry['itemNo'] !== itemNo) continue;
      if (typeof entry['name'] === 'string' && typeof entry['typeName'] === 'string') return entry;
    }
  }
  return null;
}

/** The product's name in Thai: its name, and the kind of thing it is. */
function thaiName(html: string, itemNo: string, fallback: string): string {
  const entry = itemEntry(html, itemNo);
  const name = typeof entry?.['name'] === 'string' ? entry['name'] : '';
  const typeName = typeof entry?.['typeName'] === 'string' ? entry['typeName'] : '';
  const joined = `${name} ${typeName}`.trim();
  return joined || fallback;
}

/** IKEA's colour word, translated. */
function colour(th: string | undefined): string | null {
  return translateColour(th);
}

/** IKEA's material word, translated. */
function material(th: string | undefined): string | null {
  return translateMaterial(th);
}

/** The Thailand product sitemaps, found through the sitemap index. */
export async function productSitemaps(): Promise<string[]> {
  const index = await fetchDocument(SITEMAP_INDEX);
  const found = index.match(/https:\/\/www\.ikea\.com\/sitemaps\/prod-th-TH_\d+\.xml/g) ?? [];
  return [...new Set(found)];
}

/**
 * Every IKEA product in Thailand, read out of the product sitemaps.
 *
 * The callback is asked after each sitemap, so the walk stops as soon as
 * there is enough to choose from.
 */
export async function listProducts(
  afterSitemap?: (count: number) => boolean,
): Promise<{ url: string; slug: string; image: string | null }[]> {
  const sitemaps = await productSitemaps();
  const products: { url: string; slug: string; image: string | null }[] = [];

  for (const sitemap of sitemaps) {
    const xml = await fetchDocument(sitemap);
    const entries = xml.match(/<url>[\s\S]*?<\/url>/g) ?? [];
    for (const entry of entries) {
      const loc = entry.match(/<loc>(https:\/\/www\.ikea\.com\/th\/th\/p\/[^<]+)<\/loc>/)?.[1];
      if (!loc) continue;
      const slug = loc.replace(/^https:\/\/www\.ikea\.com\/th\/th\/p\//, '').replace(/\/$/, '');
      const image = entry.match(/<image:loc>([^<]+)<\/image:loc>/)?.[1] ?? null;
      products.push({ url: loc, slug, image });
    }
    if (afterSitemap?.(products.length)) break;
  }
  return products;
}

/**
 * The candidates: IKEA products whose URL says what kind of thing they are.
 *
 * One model comes in many colours, and the catalogue wants different models
 * rather than different colours, so at most three of a model's colours are
 * kept.
 */
export async function candidates(
  stopWhen?: (found: Map<CatalogCategory, number>) => boolean,
): Promise<Candidate[]> {
  const byCategory = new Map<CatalogCategory, Candidate[]>();
  const counts = new Map<CatalogCategory, number>();
  const perModel = new Map<string, number>();

  const products = await listProducts(() => {
    for (const [category, list] of byCategory) counts.set(category, list.length);
    return stopWhen?.(counts) ?? false;
  });

  for (const product of products) {
    const category = categorise(product.slug);
    if (!category) continue;
    const list = byCategory.get(category) ?? [];
    if (list.length >= 60) continue;

    const model = englishNameFromSlug(product.slug).split(' ')[0] ?? '';
    const modelKey = `${category}:${model}`;
    const seen = perModel.get(modelKey) ?? 0;
    if (seen >= 3) continue;
    perModel.set(modelKey, seen + 1);

    list.push({
      source: 'ikea',
      category,
      url: product.url,
      image_url: product.image,
      external_id: itemNumberOf(product.slug),
      name_th: '',
      name_en: englishNameFromSlug(product.slug),
      price_thb: null,
      in_stock: true,
      brand: '',
    });
    byCategory.set(category, list);
  }

  return [...byCategory.values()].flat();
}

/** Reads a product page for the numbers the catalogue row needs. */
export async function readProduct(candidate: Candidate): Promise<ReadResult> {
  const html = await fetchText(candidate.url);
  const product = readJsonLd(html);
  if (!product) return { ok: false, reason: 'no product block on the page' };

  const offer = product.offers ?? {};
  const price = typeof offer.price === 'string' ? Number.parseFloat(offer.price) : offer.price;
  if (price === undefined || !Number.isFinite(price) || price <= 0) return { ok: false, reason: 'no price' };
  if (offer.priceCurrency && offer.priceCurrency !== 'THB') return { ok: false, reason: 'priced in another currency' };

  const measurements = readMeasurements(html);
  const width = centimetres(product.width ?? '') ?? pickWidth(measurements);
  const depth = centimetres(product.depth ?? '') ?? pickDepth(measurements);
  const height = centimetres(product.height ?? '') ?? pickHeight(measurements);
  if (!width || !depth || !height) {
    const missing = [
      width ? null : 'width',
      depth ? null : 'depth',
      height ? null : 'height',
    ].filter(Boolean);
    return { ok: false, reason: `no ${missing.join(' or ')}` };
  }

  const images = Array.isArray(product.image) ? product.image : [];
  const image = images[0]?.contentUrl ?? candidate.image_url;
  if (!image) return { ok: false, reason: 'no picture' };

  const inStock = offer.availability ? offer.availability.endsWith('InStock') : candidate.in_stock;
  const itemNo = itemNumberOf(new URL(candidate.url).pathname);

  return {
    ok: true,
    product: {
      source: 'ikea',
      source_url: product.url ?? candidate.url,
      name_th: thaiName(html, itemNo, product.name ?? candidate.name_en),
      name_en: candidate.name_en,
      category: candidate.category,
      color: colour(product.color),
      material: material(product.material),
      price_thb: price,
      width_cm: width,
      depth_cm: depth,
      height_cm: height,
      image_url: image,
      in_stock: inStock,
      external_id: product.sku ?? product.mpn ?? itemNo,
    },
  };
}
