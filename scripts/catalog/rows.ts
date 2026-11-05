/**
 * The catalogue row.
 *
 * Everything here is the shop's own information except the style tags and
 * the id. The shops do not publish a style, so the tags are ours: a small
 * vocabulary the app already offers, assigned per category. The id is ours
 * too, so it can be read at a glance.
 */

import type { Product } from '../../lib/db/types';
import type { CatalogCategory, FetchedProduct } from './types';

/** The style vocabulary the app offers, and what each category leans towards. */
const STYLES: Record<CatalogCategory, string[]> = {
  sofa: ['modern', 'scandinavian'],
  armchair: ['modern', 'scandinavian'],
  table: ['scandinavian', 'minimalist'],
  chair: ['modern', 'industrial'],
  shelf: ['industrial', 'loft'],
  lamp: ['minimalist', 'modern'],
  bed: ['scandinavian', 'modern'],
  desk: ['modern', 'minimalist'],
  cabinet: ['modern', 'scandinavian'],
  rug: ['modern', 'japandi'],
  tv_stand: ['modern', 'minimalist'],
  dresser: ['scandinavian', 'modern'],
};

/** "VRETSTORP 3-seat sofa bed" → "vretstorp". */
function seriesOf(nameEn: string): string {
  const first = nameEn.trim().split(/\s+/)[0] ?? 'item';
  return first.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** The shop's own id, with the punctuation taken out: "494.433.03" → "49443303". */
function plainId(externalId: string): string {
  return externalId.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/**
 * The row id: the shop, the category, and something that identifies the piece.
 *
 * IKEA identifies a piece by its series and its article number; HomePro by
 * its product id.
 */
export function rowId(product: FetchedProduct): string {
  if (product.source === 'homepro') {
    return `homepro-${product.category}-${plainId(product.external_id)}`;
  }
  return `ikea-${product.category}-${seriesOf(product.name_en)}-${plainId(product.external_id)}`;
}

/** Turns a fetched product into a catalogue row. */
export function buildRow(product: FetchedProduct, imageUrl: string): Product {
  return {
    id: rowId(product),
    source: product.source,
    source_url: product.source_url,
    name_th: product.name_th.trim(),
    name_en: product.name_en.trim(),
    category: product.category,
    style_tags: STYLES[product.category],
    color: product.color,
    material: product.material,
    price_thb: Math.round(product.price_thb),
    width_cm: product.width_cm,
    depth_cm: product.depth_cm,
    height_cm: product.height_cm,
    image_url: imageUrl,
    in_stock: product.in_stock,
  };
}
