/**
 * Reading HomePro's own catalogue.
 *
 * The shop publishes a category sitemap, and every category page is rendered
 * on the server: the products, their prices, their stock and their pictures
 * are all in the HTML. Each product page then carries a JSON-LD block and a
 * specification table with the sizes in centimetres.
 *
 * homepro.co.th/robots.txt keeps crawlers out of `/search`, so this reads
 * the category pages and the product pages, and nothing else.
 */

import { fetchGzipDocument, fetchText } from './http';
import { translateColour, translateMaterial } from './thai';
import type { Candidate, CatalogCategory, ReadResult } from './types';

const CATEGORY_SITEMAP = 'https://www.homepro.co.th/sitemap-categories.xml.gz';

/** The category families worth walking: furniture, lighting, and TV. */
const CATEGORY_FAMILIES = ['FUR', 'LIG', 'TVA'];

/**
 * Which of our categories a HomePro product belongs to, judged by the
 * category the shop prints on its own listing.
 *
 * Only the last part of the path is read: it is the shop's own narrowest
 * name for the thing, while the parts above it are families ("Lamps & Light
 * Bulbs") that every lamp in the shop belongs to. The shop names its
 * categories in the plural — "Beds", "Dining Chairs", "Low Cabinets" — so
 * every word is matched with its "s" as well, and the first rule that
 * matches wins.
 */
const RULES: { category: CatalogCategory; match: RegExp; skip?: RegExp }[] = [
  { category: 'sofa', match: /\bsofas?\b/i, skip: /\b(cover\w*|cushion\w*|accessor\w*|spare\w*)\b/i },
  {
    category: 'armchair',
    match: /\b(recliners?|relax chairs?|massage chairs?|bean bags?|armchairs?|accent chairs?)\b/i,
    skip: /\b(cover\w*|cushion\w*|accessor\w*|spare\w*|massage)\b/i,
  },
  {
    category: 'lamp',
    match: /\b(lamps?|chandeliers?|pendant lights?)\b/i,
    skip: /\b(bulb\w*|fitting\w*|holder\w*|strip|street|solar|garden|outdoor|spotlight\w*|downlight\w*|track)\b/i,
  },
  { category: 'tv_stand', match: /\btv stands?\b|\btv cabinets?\b/i },
  {
    category: 'bed',
    match: /\bbeds?\b/i,
    skip: /\b(cover\w*|mattress\w*|bedside|nightstand\w*|headboard\w*|children\w*)\b/i,
  },
  {
    category: 'cabinet',
    match: /\b(cabinets?|wardrobes?|lockers?)\b/i,
    skip: /\b(lighting|light\w*|children\w*|altar)\b/i,
  },
  {
    category: 'dresser',
    match: /\b(chests? of drawers?|dressers?|dressing tables?|drawers?)\b/i,
    skip: /\b(cabinets?|slide\w*)\b/i,
  },
  {
    category: 'desk',
    match: /\bdesks?\b/i,
    skip: /\b(chair\w*|partition\w*|accessor\w*|riser|tray|stand|children\w*)\b/i,
  },
  {
    category: 'chair',
    match: /\b(chairs?|stools?)\b/i,
    skip: /\b(pad\w*|cushion\w*|accessor\w*|footrest\w*|bar stool\w*|children\w*|massage)\b/i,
  },
  {
    category: 'table',
    match: /\btables?\b/i,
    skip: /\b(cover\w*|dressing|clock\w*|set\b|sets\b|children\w*)\b/i,
  },
  { category: 'shelf', match: /\b(shelves|shelving|bookcases?)\b/i, skip: /\b(bracket\w*|upright\w*)\b/i },
  { category: 'rug', match: /\b(rugs?|carpets?)\b/i, skip: /\b(cover\w*|cutting)\b/i },
];

interface JsonLd {
  '@type'?: string;
  name?: string;
  sku?: string;
  image?: string[] | { contentUrl?: string }[];
  description?: string;
  brand?: { name?: string } | string;
  offers?: { price?: string | number; priceCurrency?: string; availability?: string };
}

/** The JSON-LD product block on a product page. */
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
      // Not JSON — keep looking.
    }
  }
  return null;
}

/**
 * The specification table: a label and a value, per row.
 *
 * The rows are marked `pdp-FT_<KEY>`, and the key is the name of the field —
 * `WIDTH`, `DEPTH`, `HEIGHT`, `MATERIAL`, `COLOR`, `COLORGROUP`, `BRAND`.
 */
export function readSpecifications(html: string): Map<string, string> {
  const rows = new Map<string, string>();
  const section = html.slice(html.indexOf('id="product-specification"'));
  const pattern = /<tr class="pdp-FT_([A-Z0-9_]+)"[^>]*>([\s\S]*?)<\/tr>/g;

  for (const match of section.matchAll(pattern)) {
    const key = match[1];
    const cells = [...match[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) =>
      cell[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').trim(),
    );
    const value = cells[1]?.replace(/\s+/g, ' ').trim();
    if (value) rows.set(key, value);
  }
  return rows;
}

/** The number in "88" or "80.5". */
function number(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Which of our categories a product path belongs to. */
export function categorise(path: string): CatalogCategory | null {
  const segments = path.split('/').map((segment) => segment.trim()).filter(Boolean);
  const leaf = segments[segments.length - 1] ?? path;

  for (const rule of RULES) {
    if (!rule.match.test(leaf)) continue;
    if (rule.skip?.test(leaf)) continue;
    return rule.category;
  }
  return null;
}

/** The category pages worth reading, taken from the shop's category sitemap. */
export async function categoryCodes(): Promise<string[]> {
  const xml = await fetchGzipDocument(CATEGORY_SITEMAP);
  const codes = new Set<string>();
  for (const match of xml.matchAll(/\/c\/([A-Z0-9]+)</g)) {
    const code = match[1];
    const family = CATEGORY_FAMILIES.find((name) => code.startsWith(name));
    if (!family) continue;
    if (code.length !== family.length + 4) continue;
    codes.add(code);
  }
  return [...codes].sort();
}

/** One product on a category page. */
interface PlpItem {
  id: string;
  name_th: string;
  name_en: string;
  price: number | null;
  path: string;
  brand: string;
  stock: number;
  image: string | null;
}

/** Reads the products on a category page. */
export function parsePlp(html: string): PlpItem[] {
  const items: PlpItem[] = [];
  const cards = html.split('class="product-plp-card').slice(1);

  for (const card of cards) {
    const id = card.match(/id="product-(\d+)"/)?.[1];
    if (!id) continue;
    const value = (key: string): string | undefined =>
      card.match(new RegExp(`id="${key}-${id}" value="([^"]*)"`))?.[1];
    const path = value('gtmCategoryAll') ?? '';
    const price = number(value('gtmPrice'));
    const stock = number(value('gtmAvailability')) ?? 0;
    const image = card.match(/background-image:\s*url\(['"]?([^'")]+)['"]?\)/)?.[1] ?? null;

    items.push({
      id,
      name_th: (value('gtmName') ?? '').trim(),
      name_en: (value('gtmNameEN') ?? '').trim(),
      price,
      path,
      brand: (value('gtmBrand') ?? '').trim(),
      stock,
      image,
    });
  }
  return items;
}

/** Every product the category pages list, classified. */
export async function candidates(
  stopWhen?: (found: Map<CatalogCategory, number>) => boolean,
): Promise<Candidate[]> {
  const codes = await categoryCodes();
  console.log(`  homepro: ${codes.length} category pages`);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const counts = new Map<CatalogCategory, number>();

  for (const code of codes) {
    const html = await fetchText(`https://www.homepro.co.th/c/${code}`);
    for (const item of parsePlp(html)) {
      if (seen.has(item.id)) continue;
      const category = categorise(item.path);
      if (!category) continue;
      seen.add(item.id);
      counts.set(category, (counts.get(category) ?? 0) + 1);
      candidates.push({
        source: 'homepro',
        category,
        url: `https://www.homepro.co.th/p/${item.id}`,
        image_url: item.image,
        external_id: item.id,
        name_th: item.name_th,
        name_en: item.name_en,
        price_thb: item.price,
        in_stock: item.stock > 0,
        brand: item.brand,
      });
    }
    if (stopWhen?.(counts)) break;
  }
  return candidates;
}

/** The picture, at the size HomePro serves it. */
function biggestImage(url: string): string {
  return url.replace('/447x447/', '/1000x1000/');
}

/** Reads a product page for the numbers the catalogue row needs. */
export async function readProduct(candidate: Candidate): Promise<ReadResult> {
  const html = await fetchText(candidate.url);
  const product = readJsonLd(html);
  const specifications = readSpecifications(html);

  const offer = product?.offers ?? {};
  const price =
    typeof offer.price === 'string' ? number(offer.price) : number(String(offer.price ?? '')) ?? candidate.price_thb;
  if (!price || price <= 0) return { ok: false, reason: 'no price' };

  const width = number(specifications.get('WIDTH'));
  const depth = number(specifications.get('DEPTH'));
  const height = number(specifications.get('HEIGHT'));
  if (!width || !depth || !height) {
    const missing = [
      width ? null : 'width',
      depth ? null : 'depth',
      height ? null : 'height',
    ].filter(Boolean);
    return { ok: false, reason: `no ${missing.join(' or ')}` };
  }

  const images = Array.isArray(product?.image) ? product.image : [];
  const first = images[0];
  const imageUrl = typeof first === 'string' ? first : first?.contentUrl;
  const image = imageUrl ? biggestImage(imageUrl) : candidate.image_url;
  if (!image) return { ok: false, reason: 'no picture' };

  const title = html.match(/<title>([^<]*)<\/title>/)?.[1]?.trim();
  const nameTh = candidate.name_th || title || candidate.name_en;
  const nameEn = candidate.name_en || product?.name || '';

  return {
    ok: true,
    product: {
      source: 'homepro',
      source_url: candidate.url,
      name_th: nameTh,
      name_en: nameEn,
      category: candidate.category,
      color: translateColour(specifications.get('COLOR') ?? specifications.get('COLORGROUP')),
      material: translateMaterial(specifications.get('MATERIAL')),
      price_thb: price,
      width_cm: width,
      depth_cm: depth,
      height_cm: height,
      image_url: image,
      in_stock: candidate.in_stock,
      external_id: product?.sku ?? candidate.external_id,
    },
  };
}
