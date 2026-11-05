import { describe, expect, it } from 'vitest';

import { emptySessionState, normalizeSessionState } from '@/lib/db/types';

/**
 * The fields the session row holds.
 *
 * The nine the spec names, plus the brief of the room that was designed — the
 * row has to keep it, or the next turn would have no room to refine.
 */
const FIELDS = [
  'design_brief',
  'generated_image_ids',
  'preferences',
  'reference_cm',
  'reference_line',
  'room_analysis',
  'room_image_id',
  'selected_area',
  'selected_product_id',
  'shown_products',
];

describe('normalizeSessionState', () => {
  it('fills a bare `{}` — the raw SQL default — into the full shape', () => {
    const result = normalizeSessionState({});
    expect(Object.keys(result).sort()).toEqual(FIELDS);
    expect(result).toEqual(emptySessionState());
  });

  it('returns the empty state for non-object input', () => {
    for (const bad of [null, undefined, 42, 'oops', [], true]) {
      expect(normalizeSessionState(bad)).toEqual(emptySessionState());
    }
  });

  it('merges a partial preferences object one level deep', () => {
    const result = normalizeSessionState({ preferences: { style: 'japandi' } });
    expect(result.preferences).toEqual({
      style: 'japandi',
      budget_thb: null,
      category: null,
    });
  });

  it('keeps values that are already present', () => {
    const result = normalizeSessionState({
      room_image_id: 'img-1',
      reference_cm: 220,
      shown_products: ['a', 'b'],
      preferences: { budget_thb: 15000 },
    });
    expect(result.room_image_id).toBe('img-1');
    expect(result.reference_cm).toBe(220);
    expect(result.shown_products).toEqual(['a', 'b']);
    expect(result.preferences.budget_thb).toBe(15000);
  });

  it('preserves an explicit null rather than treating it as missing', () => {
    const result = normalizeSessionState({ selected_product_id: null });
    expect(result.selected_product_id).toBeNull();
    expect('selected_product_id' in result).toBe(true);
  });

  it('replaces a wrongly-typed array field with an empty array', () => {
    const result = normalizeSessionState({
      shown_products: 'not-an-array',
      generated_image_ids: null,
    });
    expect(result.shown_products).toEqual([]);
    expect(result.generated_image_ids).toEqual([]);
  });

  it('is idempotent', () => {
    const once = normalizeSessionState({ preferences: { style: 'loft' } });
    expect(normalizeSessionState(once)).toEqual(once);
  });

  it('keeps the brief of the room that was designed', () => {
    const brief = {
      style: 'มินิมอล',
      theme: 'สีชมพู',
      purpose: null,
      room_size: '24 ตารางเมตร',
      room_size_m2: 24,
      width_cm: 600,
      depth_cm: 400,
      budget_thb: null,
      items: [{ category: 'bed', note: '', requested_width: null, product_id: 'bed-1' }],
      instruction: null,
    };

    const result = normalizeSessionState({ design_brief: brief });

    expect(result.design_brief).toEqual(brief);
  });

  it('has no brief until a room has been designed', () => {
    expect(normalizeSessionState({}).design_brief).toBeNull();
  });
});