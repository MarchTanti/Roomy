/**
 * The fit rule — the only place that decides whether a piece of furniture goes
 * in a space.
 *
 * Written before the implementation, per the spec. The rule is deliberately
 * arithmetic with no model, no network and no database: the dimensions come in
 * already-resolved, so a wrong answer here can only ever be a wrong formula.
 *
 * Two things are worth knowing while reading the expectations:
 *
 *   - The photo scale is *isotropic*. Normalised photo coordinates run 0..1 on
 *     both axes, but a 4:3 phone photo is a third wider than it is tall, so
 *     "half the height" is not half the width in centimetres. Vertical spans are
 *     multiplied by the photo's height/width before being compared. One unit
 *     always means "one photo width". Without that correction every vertical
 *     measurement is out by a third.
 *   - Clearance means room left over, not room needed. A negative clearance is
 *     an overflow, and its magnitude is how much bigger the piece is.
 */

import { describe, expect, it } from 'vitest';

import {
  MIN_CLEARANCE_CM,
  areaToSpace,
  deriveScale,
  evaluateFit,
  referenceLength,
  type FitProduct,
  type FitSpace,
} from '@/lib/fit';
import type { Area, ReferenceLine } from '@/lib/db/types';

const SOFA: FitProduct = { width_cm: 100, depth_cm: 50, height_cm: 80 };

function space(width: number, depth: number, height: number | null = null): FitSpace {
  return { width_cm: width, depth_cm: depth, height_cm: height };
}

/** A line spanning `dx` (normalised) horizontally from the origin. */
function hLine(dx: number): ReferenceLine {
  return { x1: 0, y1: 0, x2: dx, y2: 0 };
}

const ASPECT_4_3 = 4 / 3;

// ---------------------------------------------------------------------------

describe('evaluateFit — the verdict', () => {
  it('says it fits when there is room on every axis', () => {
    const result = evaluateFit(SOFA, space(200, 120));

    expect(result.verdict).toBe('fits');
    expect(result.rotation_deg).toBe(0);
    expect(result.width).toEqual({ needed_cm: 100, available_cm: 200, clearance_cm: 100 });
    expect(result.depth).toEqual({ needed_cm: 50, available_cm: 120, clearance_cm: 70 });
    expect(result.reasons.join(' ')).toContain('วางได้');
  });

  it('is exact at the boundary — equal sizes fit, with no clearance', () => {
    // A piece that exactly fills the space does go in, but it is not a
    // recommendation, so it must not read as a comfortable yes.
    const result = evaluateFit(SOFA, space(100, 50));

    expect(result.verdict).toBe('tight');
    expect(result.width.clearance_cm).toBe(0);
    expect(result.depth.clearance_cm).toBe(0);
  });

  it('calls it tight when the clearance is under the minimum', () => {
    const result = evaluateFit(SOFA, space(104, 100));

    expect(result.verdict).toBe('tight');
    expect(result.width.clearance_cm).toBe(4);
    expect(MIN_CLEARANCE_CM).toBe(5);
    expect(result.reasons.join(' ')).toContain('4');
  });

  it('does not fit when neither orientation goes in', () => {
    // 80 x 40 fits neither way: catalogued it overhangs the width, and turned
    // it needs 100 cm of depth where there is 40.
    const result = evaluateFit(SOFA, space(80, 40));

    expect(result.verdict).toBe('does_not_fit');
    expect(result.width.clearance_cm).toBe(-20);
    expect(result.limiting).toBe('width');
    // The advice has to carry the number, or the user cannot act on it.
    expect(result.reasons.join(' ')).toContain('20');
  });

  it('treats an unmeasurable space as one that does not fit', () => {
    // The failure mode that matters: a NaN slipping through a bad photo scale
    // would compare false everywhere and quietly report "fits".
    const result = evaluateFit(SOFA, space(Number.NaN, 120));

    expect(result.verdict).toBe('does_not_fit');
    expect(result.reasons.join(' ')).not.toContain('NaN');
  });
});

describe('evaluateFit — rotation', () => {
  const long: FitProduct = { width_cm: 200, depth_cm: 300, height_cm: 100 };

  it('turns the piece 90 degrees when that is the orientation that goes in', () => {
    const result = evaluateFit(long, space(320, 210));

    expect(result.verdict).toBe('fits');
    expect(result.rotation_deg).toBe(90);
    expect(result.reasons.join(' ')).toContain('90');
  });

  it('leaves the piece alone when its catalogued orientation already fits', () => {
    const result = evaluateFit(long, space(300, 400));

    expect(result.verdict).toBe('fits');
    expect(result.rotation_deg).toBe(0);
  });

  it('picks the orientation with more room when both fit', () => {
    // 500 x 300: as catalogued it leaves nothing on the depth, turned it leaves
    // a metre on each axis.
    const result = evaluateFit(long, space(500, 300));

    expect(result.verdict).toBe('fits');
    expect(result.rotation_deg).toBe(90);
    expect(result.width.clearance_cm).toBe(200);
  });

  it('keeps the catalogued orientation when the two are equally good', () => {
    const result = evaluateFit(long, space(500, 500));

    expect(result.verdict).toBe('fits');
    expect(result.rotation_deg).toBe(0);
  });

  it('reports the lesser overflow when it fits neither way', () => {
    // 220 x 230: catalogued it overhangs the depth by 70; turned, the width by
    // 80. The user should hear about the 70.
    const result = evaluateFit(long, space(220, 230));

    expect(result.verdict).toBe('does_not_fit');
    expect(result.rotation_deg).toBe(0);
    expect(result.width.clearance_cm).toBe(20);
    expect(result.depth.clearance_cm).toBe(-70);
    expect(result.limiting).toBe('depth');
  });
});

describe('evaluateFit — height', () => {
  it('checks height only when a ceiling height is known', () => {
    const result = evaluateFit(SOFA, space(200, 120));

    // The piece is 80 cm tall and nobody measured the ceiling, so height is
    // not part of the verdict — but saying so beats implying it fits.
    expect(result.height).toBeNull();
    expect(result.verdict).toBe('fits');
    expect(result.reasons.join(' ')).toContain('เพดาน');
  });

  it('fails when the piece is taller than the ceiling', () => {
    const result = evaluateFit(SOFA, space(200, 120, 70));

    expect(result.verdict).toBe('does_not_fit');
    expect(result.height).toEqual({ needed_cm: 80, available_cm: 70, clearance_cm: -10 });
    expect(result.limiting).toBe('height');
  });

  it('is tight when the ceiling is only just above the piece', () => {
    const result = evaluateFit(SOFA, space(200, 120, 82));

    expect(result.verdict).toBe('tight');
    expect(result.limiting).toBe('height');
  });

  it('lets a generous ceiling leave the floor as the limiting axis', () => {
    const result = evaluateFit(SOFA, space(200, 120, 250));

    expect(result.verdict).toBe('fits');
    expect(result.limiting).toBe('depth');
  });
});

describe('referenceLength', () => {
  it('measures a horizontal span in photo widths', () => {
    expect(referenceLength(hLine(0.5), 1)).toBeCloseTo(0.5, 6);
  });

  it('measures a vertical span in photo widths, not heights', () => {
    // A 4:3 photo is 0.75 of a photo-width tall, so the full height is 0.75.
    expect(referenceLength({ x1: 0, y1: 0, x2: 0, y2: 1 }, ASPECT_4_3)).toBeCloseTo(0.75, 6);
  });

  it('ignores the aspect when the photo size is unknown', () => {
    expect(referenceLength({ x1: 0, y1: 0, x2: 0, y2: 1 })).toBeCloseTo(1, 6);
  });

  it('measures a diagonal as the hypotenuse of the corrected axes', () => {
    // 0.6 of the width and 0.4 of a 4:3 photo's height = 0.3 of a width.
    expect(referenceLength({ x1: 0, y1: 0, x2: 0.6, y2: 0.4 }, ASPECT_4_3)).toBeCloseTo(
      Math.hypot(0.6, 0.3),
      6,
    );
  });

  it('is zero for a dot', () => {
    expect(referenceLength({ x1: 0.2, y1: 0.3, x2: 0.2, y2: 0.3 }, ASPECT_4_3)).toBe(0);
  });
});

describe('deriveScale', () => {
  it('turns a known-length line into centimetres per unit', () => {
    const scale = deriveScale(hLine(0.5), 100);

    expect(scale).not.toBeNull();
    expect(scale?.cm_per_unit).toBeCloseTo(200, 6);
    expect(scale?.reference_cm).toBe(100);
  });

  it('carries the photo aspect so later conversions stay consistent', () => {
    expect(deriveScale(hLine(0.5), 100, ASPECT_4_3)?.photo_aspect).toBeCloseTo(ASPECT_4_3, 6);
  });

  it('refuses when the real-world length is unknown', () => {
    expect(deriveScale(hLine(0.5), null)).toBeNull();
    expect(deriveScale(hLine(0.5), 0)).toBeNull();
    expect(deriveScale(hLine(0.5), -20)).toBeNull();
    expect(deriveScale(hLine(0.5), Number.NaN)).toBeNull();
  });

  it('refuses when there is no line', () => {
    expect(deriveScale(null, 100)).toBeNull();
  });

  it('refuses a line too short to measure against', () => {
    // A few pixels of drag would otherwise imply a scale of metres per pixel.
    expect(deriveScale(hLine(0.005), 100)).toBeNull();
    expect(deriveScale({ x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5 }, 100)).toBeNull();
  });

  it('refuses a line with non-finite coordinates', () => {
    expect(deriveScale({ x1: 0, y1: 0, x2: Number.NaN, y2: 1 }, 100)).toBeNull();
    expect(deriveScale({ x1: Number.POSITIVE_INFINITY, y1: 0, x2: 1, y2: 0 }, 100)).toBeNull();
  });

  it('ignores a nonsensical photo aspect', () => {
    // A zero-width or zero-tall photo would divide by zero downstream.
    expect(deriveScale(hLine(0.5), 100, 0)?.photo_aspect).toBe(1);
    expect(deriveScale(hLine(0.5), 100, -2)?.photo_aspect).toBe(1);
    expect(deriveScale(hLine(0.5), 100, Number.NaN)?.photo_aspect).toBe(1);
  });
});

describe('areaToSpace', () => {
  const FULL: Area = { x: 0, y: 0, w: 1, h: 1 };

  it('converts a drawn rectangle with the photo scale', () => {
    // 0.5 of the width = 100 cm. Half of a 4:3 photo's height = 0.375 of its
    // width = 75 cm.
    const scale = deriveScale(hLine(0.5), 100, ASPECT_4_3);
    const result = areaToSpace({ x: 0, y: 0, w: 0.5, h: 0.5 }, scale);

    expect(result?.width_cm).toBeCloseTo(100, 6);
    expect(result?.depth_cm).toBeCloseTo(75, 6);
  });

  it('treats the position of the rectangle as irrelevant', () => {
    const scale = deriveScale(hLine(0.5), 100, ASPECT_4_3);
    const here = areaToSpace({ x: 0, y: 0, w: 0.5, h: 0.5 }, scale);
    const there = areaToSpace({ x: 0.4, y: 0.4, w: 0.5, h: 0.5 }, scale);

    expect(there).toEqual(here);
  });

  it('leaves the height unknown unless a ceiling is supplied', () => {
    const scale = deriveScale(hLine(0.5), 100, ASPECT_4_3);

    expect(areaToSpace(FULL, scale)?.height_cm).toBeNull();
    expect(areaToSpace(FULL, scale, 260)?.height_cm).toBe(260);
  });

  it('returns nothing without a drawn area', () => {
    expect(areaToSpace(null, deriveScale(hLine(0.5), 100))).toBeNull();
  });

  it('returns nothing without a scale', () => {
    expect(areaToSpace(FULL, null)).toBeNull();
  });
});

describe('evaluateFit against a photo-measured space', () => {
  it('feeds a drawn area straight into the verdict', () => {
    // The whole path the UI takes: a 60 cm reference line drawn across a
    // quarter of a 4:3 photo's width, then a rectangle covering half of each
    // axis — a 120 x 90 cm space, and a 220 cm wide sofa.
    const scale = deriveScale(hLine(0.25), 60, ASPECT_4_3);
    const measured = areaToSpace({ x: 0, y: 0, w: 0.5, h: 0.5 }, scale);

    expect(measured?.width_cm).toBeCloseTo(120, 6);
    expect(measured?.depth_cm).toBeCloseTo(90, 6);

    const result = evaluateFit({ width_cm: 220, depth_cm: 90, height_cm: 80 }, measured!);

    expect(result.verdict).toBe('does_not_fit');
    expect(result.limiting).toBe('width');
    expect(result.width.clearance_cm).toBeCloseTo(-100, 6);
  });
});