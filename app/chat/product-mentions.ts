/**
 * Matching a product to the sentence that names it.
 *
 * When the model recommends a piece of furniture, it writes the piece's own
 * name — the string the catalogue holds. This module finds those names in an
 * answer, so the picture of the piece can be put next to the words.
 *
 * It is deliberately separate from the renderer: this is the part with a rule
 * in it, and a rule belongs where it can be tested on its own.
 */

/** The little we need to know about a product to show it. */
export interface ProductImageRef {
  id: string;
  name_th: string;
  name_en: string;
  image_url: string;
  price_thb: number;
}

/**
 * Words that name a category rather than a product.
 *
 * "sofa" is in half the product names, so matching on it would attach the
 * picture of an arbitrary sofa to every sentence that mentions a sofa.
 */
const CATEGORY_WORDS = new Set([
  'sofa',
  'armchair',
  'table',
  'desk',
  'chair',
  'shelf',
  'cabinet',
  'dresser',
  'bed',
  'lamp',
  'rug',
  'stand',
  'seat',
  'seater',
  'piece',
  'pack',
  'โซฟา',
  'โต๊ะ',
  'โตะ',
  'เก้าอี้',
  'เก้าอี',
  'ชั้น',
  'ตู้',
  'เตียง',
  'โคม',
  'พรม',
  'ที่นั่ง',
  'ชิ้น',
  'ตัว',
]);

/**
 * Splits a name into the words worth looking for.
 *
 * A word that starts with a digit is a size, not a name — "3-seat" belongs to
 * every three-seater in the catalogue, so it identifies nothing.
 */
export function nameTerms(name: string): string[] {
  return name
    .split(/[\s/()-]+/)
    .map((word) => word.trim())
    .filter(
      (word) =>
        word.length >= 4 && !/^\d/.test(word) && !CATEGORY_WORDS.has(word.toLowerCase()),
    );
}

/** Lower case, with the spaces squeezed out of the way. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The products an answer names.
 *
 * A product is named in one of two ways:
 *
 *   - **By its whole name.** "โซฟาลินเนส 3 ที่นั่ง" is that product and no
 *     other, so a match on the full name is certain.
 *   - **By a word only it has.** A name like "คัทจ้า" belongs to one piece
 *     in the catalogue. But "HEMNES" belongs to a sofa, a shelf, a desk and a
 *     chest — so a word that more than one product in the set claims proves
 *     nothing, and is not enough to put a picture on the page.
 *
 * The second rule is why the picture of the wrong sofa never turns up next to
 * a sentence about a different one.
 */
export function findMentionedProducts(
  text: string,
  products: readonly ProductImageRef[],
): ProductImageRef[] {
  const haystack = normalise(text);
  if (!haystack) return [];

  // The words each product claims, and how many products claim each word.
  const termsOf = new Map<string, string[]>();
  const claims = new Map<string, number>();

  for (const product of products) {
    const terms = [...new Set([...nameTerms(product.name_th), ...nameTerms(product.name_en)])];
    termsOf.set(product.id, terms);
    for (const term of terms) {
      claims.set(term.toLowerCase(), (claims.get(term.toLowerCase()) ?? 0) + 1);
    }
  }

  const found: ProductImageRef[] = [];

  for (const product of products) {
    const whole = [product.name_th, product.name_en]
      .map(normalise)
      .filter((name) => name.length >= 4);

    const byName = whole.some((name) => haystack.includes(name));
    const byWord = (termsOf.get(product.id) ?? []).some((term) => {
      const key = term.toLowerCase();
      return claims.get(key) === 1 && haystack.includes(key);
    });

    if (byName || byWord) found.push(product);
  }

  return found;
}
