/**
 * The catalogue fit sweep — the part of step 8 that needs no model.
 *
 * Every product in the catalogue is put against the same measured space, and
 * the fit rule decides. That makes the sweep a check of the *rule* over the
 * real catalogue: if the numbers in the report are right, the rule is right on
 * all 42 rows, not just on the three that happened to come up in a chat.
 *
 * The rule itself is in `lib/fit.ts` and has its own tests; what is checked
 * here is that the sweep reports what the rule said, and counts it right.
 */

import { describe, expect, it } from 'vitest';

import type { Product } from '@/lib/db/types';
import { evaluateCatalogue } from '@/lib/results/catalogue-fit';
import type { FitSpace } from '@/lib/fit';

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p-1',
    source: 'manual',
    source_url: 'https://example.test/p-1',
    name_th: 'โซฟาทดสอบ',
    name_en: 'Test sofa',
    category: 'sofa',
    style_tags: ['japandi'],
    color: 'สีเทา',
    material: 'ไม้',
    price_thb: 12_900,
    width_cm: 200,
    depth_cm: 90,
    height_cm: 80,
    image_url: '/product-images/p-1.svg',
    in_stock: true,
    ...overrides,
  };
}

const SPACE: FitSpace = { width_cm: 240, depth_cm: 120, height_cm: 260 };

describe('evaluateCatalogue', () => {
  it('reports one row per product, with the catalogue values on it', () => {
    const { rows } = evaluateCatalogue([product({ id: 'a' }), product({ id: 'b', name_th: 'โต๊ะ' })], SPACE);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      product_id: 'a',
      name_th: 'โซฟาทดสอบ',
      category: 'sofa',
      price_thb: 12_900,
      size_cm: { width: 200, depth: 90, height: 80 },
    });
    expect(rows[1].name_th).toBe('โต๊ะ');
  });

  it('calls a piece with room to spare "fits"', () => {
    const { rows } = evaluateCatalogue([product()], SPACE);
    expect(rows[0].verdict).toBe('fits');
    expect(rows[0].rotation_deg).toBe(0);
    // The depth is the tighter of the two footprint axes here.
    expect(rows[0].limiting).toBe('depth');
    expect(rows[0].clearance_cm).toBe(30);
  });

  it('calls a piece that exactly fills the space "tight"', () => {
    // No room to walk past it: the rule wants 5 cm of clearance.
    const { rows } = evaluateCatalogue([product({ width_cm: 240, depth_cm: 120 })], SPACE);
    expect(rows[0].verdict).toBe('tight');
    expect(rows[0].clearance_cm).toBe(0);
  });

  it('calls a piece with a few centimetres to spare "tight"', () => {
    // MIN_CLEARANCE_CM is 5: less than that is not worth recommending.
    const { rows } = evaluateCatalogue([product({ width_cm: 236 })], SPACE);
    expect(rows[0].verdict).toBe('tight');
    expect(rows[0].clearance_cm).toBe(4);
  });

  it('calls a piece that is wider than the space "does_not_fit"', () => {
    const { rows } = evaluateCatalogue([product({ width_cm: 260 })], SPACE);
    expect(rows[0].verdict).toBe('does_not_fit');
    expect(rows[0].limiting).toBe('width');
    expect(rows[0].clearance_cm).toBe(-20);
  });

  it('names the height as the limiting axis when the ceiling is low', () => {
    const { rows } = evaluateCatalogue([product({ height_cm: 280 })], SPACE);
    expect(rows[0].verdict).toBe('does_not_fit');
    expect(rows[0].limiting).toBe('height');
  });

  it('turns a piece onto its side when that is the roomier way round', () => {
    // Catalogued 90 wide × 200 deep does not fit a 240 × 120 space; turned, it
    // is. The rule keeps the roomier orientation.
    const { rows } = evaluateCatalogue([product({ width_cm: 90, depth_cm: 200 })], SPACE);
    expect(rows[0].rotation_deg).toBe(90);
    expect(rows[0].verdict).toBe('fits');
  });

  it('carries the reason the fit rule wrote, in Thai', () => {
    const { rows } = evaluateCatalogue([product({ width_cm: 260 })], SPACE);
    expect(rows[0].reason).toContain('ด้านกว้าง');
  });

  it('counts the verdicts', () => {
    const { summary } = evaluateCatalogue(
      [
        product({ id: 'a' }),
        product({ id: 'b', width_cm: 236 }),
        product({ id: 'c', width_cm: 260 }),
        product({ id: 'd', width_cm: 210 }),
      ],
      SPACE,
    );

    expect(summary).toEqual({ total: 4, fits: 2, tight: 1, does_not_fit: 1 });
  });

  it('copes with an empty catalogue', () => {
    const { rows, summary } = evaluateCatalogue([], SPACE);
    expect(rows).toEqual([]);
    expect(summary).toEqual({ total: 0, fits: 0, tight: 0, does_not_fit: 0 });
  });
});
