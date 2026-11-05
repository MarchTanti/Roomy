/**
 * Reading the products back out of the tool history.
 *
 * The chat needs the products themselves, not the ids, so the client can show
 * a card per product. The history is jsonb on the way back from the database,
 * so it is read defensively: a hand-edited row must not take the chat down.
 */

import { describe, expect, it } from 'vitest';

import { extractSearchProducts } from '@/lib/llm/tools';
import type { Json } from '@/lib/db/types';
import type { LlmMessage } from '@/lib/llm/types';

const PRODUCT = {
  id: 'p-1',
  name_th: 'โซฟา KIVIK',
  name_en: 'KIVIK sofa',
  category: 'sofa',
  style_tags: ['scandinavian'],
  color: 'สีเทา',
  material: 'ผ้า',
  price_thb: 24900,
  width_cm: 228,
  depth_cm: 95,
  height_cm: 83,
  image_url: '/product-images/p-1.svg',
  in_stock: true,
  source: 'ikea',
  source_url: 'https://example.test/p-1',
};

function searchResult(products: Json[]): LlmMessage {
  return {
    role: 'user',
    parts: [
      {
        kind: 'toolResult',
        callId: 'call-1',
        name: 'searchFurniture',
        result: { count: products.length, products },
      },
    ],
  };
}

describe('extractSearchProducts', () => {
  it('returns the products of the search', () => {
    const products = extractSearchProducts([searchResult([PRODUCT as unknown as Json])]);

    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ id: 'p-1', name_th: 'โซฟา KIVIK', price_thb: 24900 });
    expect(products[0].style_tags).toEqual(['scandinavian']);
    expect(products[0].in_stock).toBe(true);
  });

  it('takes the last search when a turn searched twice', () => {
    const other = { ...PRODUCT, id: 'p-2', name_th: 'โซฟา สอง' };
    const products = extractSearchProducts([
      searchResult([PRODUCT as unknown as Json]),
      searchResult([other as unknown as Json]),
    ]);

    expect(products.map((p) => p.id)).toEqual(['p-2']);
  });

  it('ignores results from other tools', () => {
    const history: LlmMessage[] = [
      {
        role: 'user',
        parts: [
          {
            kind: 'toolResult',
            callId: 'call-1',
            name: 'checkFit',
            result: { product: PRODUCT },
          },
        ],
      },
    ];

    expect(extractSearchProducts(history)).toEqual([]);
  });

  it('returns nothing for a result that is not shaped like a search', () => {
    const broken: LlmMessage[] = [
      {
        role: 'user',
        parts: [
          { kind: 'toolResult', callId: 'call-1', name: 'searchFurniture', result: 'not an object' },
          { kind: 'toolResult', callId: 'call-2', name: 'searchFurniture', result: { products: 'nope' } },
          { kind: 'toolResult', callId: 'call-3', name: 'searchFurniture', result: { products: [null, 7] } },
        ],
      },
    ];

    expect(extractSearchProducts(broken)).toEqual([]);
  });

  it('keeps the products it can read and drops the ones it cannot', () => {
    const partial = { ...PRODUCT, width_cm: undefined };
    const products = extractSearchProducts([
      searchResult([partial as unknown as Json, PRODUCT as unknown as Json]),
    ]);

    // The first row has no width, so it is not a product.
    expect(products.map((p) => p.id)).toEqual(['p-1']);
  });
});
