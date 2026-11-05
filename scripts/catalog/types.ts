/**
 * The shapes the fetch pipeline passes around.
 *
 * The catalogue row itself (`Product` in lib/db/types.ts) is what the app
 * reads. `FetchedProduct` is the same thing one step earlier: the numbers are
 * real, but the picture is still a URL on somebody else's server and the row
 * has no id yet. `buildRow` turns one into the other.
 */

/** The categories the app can place, in the order they appear in the seed file. */
export const CATEGORIES = [
  'sofa',
  'armchair',
  'table',
  'chair',
  'shelf',
  'lamp',
  'bed',
  'desk',
  'cabinet',
  'rug',
  'tv_stand',
  'dresser',
] as const;

export type CatalogCategory = (typeof CATEGORIES)[number];

export type CatalogSource = 'ikea' | 'homepro';

/** A product as it comes off the shop's page, before it becomes a row. */
export interface FetchedProduct {
  source: CatalogSource;
  /** The real product page on the shop's site. */
  source_url: string;
  name_th: string;
  name_en: string;
  category: CatalogCategory;
  color: string | null;
  material: string | null;
  price_thb: number;
  width_cm: number;
  depth_cm: number;
  height_cm: number;
  /** Where the picture is, before we download it. */
  image_url: string;
  in_stock: boolean;
  /** The shop's own id: IKEA's article number, HomePro's product id. */
  external_id: string;
}

/** A candidate seen on a listing page, before its detail page has been read. */
export interface Candidate {
  source: CatalogSource;
  category: CatalogCategory;
  /** The detail page to read for the real numbers. */
  url: string;
  /** The picture to download, if the listing already showed one. */
  image_url: string | null;
  /** The shop's own id. */
  external_id: string;
  name_th: string;
  name_en: string;
  price_thb: number | null;
  in_stock: boolean;
  /** The brand, where the shop publishes one. It tells one model from another. */
  brand: string;
}

/** What came of reading a product page: the piece, or the reason there isn't one. */
export type ReadResult = { ok: true; product: FetchedProduct } | { ok: false; reason: string };
