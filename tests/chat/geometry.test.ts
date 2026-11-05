/**
 * Pointer maths for the area picker.
 *
 * Kept out of the component so it can be tested without a DOM, and kept
 * separate from `lib/fit.ts` on purpose: that module works in centimetres and
 * knows nothing about pixels, while this one only converts a drag on screen into
 * the normalised coordinates the spec stores.
 *
 * The aspect correction is deliberately absent — a normalised rectangle is
 * relative to the photo, and turning it into centimetres is the server's job,
 * where the photo's real dimensions are known.
 */

import { describe, expect, it } from 'vitest';

import { areaFromDrag, lineFromDrag, normalizedPoint } from '@/app/chat/geometry';

const BOX = { width: 800, height: 600 };

/** A drag from one client point to another, plus the element it happened over. */
function drag(from: [number, number], to: [number, number]) {
  return { from, to, box: BOX };
}

describe('normalizedPoint', () => {
  it('turns a pixel position into a 0..1 point on the photo', () => {
    expect(normalizedPoint({ x: 400, y: 300 }, BOX)).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizedPoint({ x: 0, y: 0 }, BOX)).toEqual({ x: 0, y: 0 });
    expect(normalizedPoint({ x: 800, y: 600 }, BOX)).toEqual({ x: 1, y: 1 });
  });

  it('clamps a drag that wanders off the photo', () => {
    // Pointer capture lets a drag end outside the element; the stored point
    // still has to sit on the photo.
    expect(normalizedPoint({ x: -40, y: 900 }, BOX)).toEqual({ x: 0, y: 1 });
    expect(normalizedPoint({ x: 9999, y: -12 }, BOX)).toEqual({ x: 1, y: 0 });
  });

  it('returns nothing for an element with no size yet', () => {
    // A hidden or not-yet-laid-out image reports a zero-sized box, and dividing
    // by that would produce Infinity.
    expect(normalizedPoint({ x: 10, y: 10 }, { width: 0, height: 0 })).toBeNull();
  });
});

describe('areaFromDrag', () => {
  it('normalises a rectangle dragged down and right', () => {
    expect(areaFromDrag(drag([100, 100], [500, 400]))).toEqual({ x: 0.125, y: 0.1667, w: 0.5, h: 0.5 });
  });

  it('gives the same rectangle whichever way it was dragged', () => {
    // Users drag up and left as often as down and right, and the stored area
    // must not depend on the direction of the gesture.
    expect(areaFromDrag(drag([500, 400], [100, 100]))).toEqual(areaFromDrag(drag([100, 100], [500, 400])));
  });

  it('anchors the rectangle at its top-left corner', () => {
    const area = areaFromDrag(drag([500, 400], [100, 100]));

    expect(area?.x).toBe(0.125);
    expect(area?.y).toBe(0.1667);
    expect(area?.w).toBeGreaterThan(0);
    expect(area?.h).toBeGreaterThan(0);
  });

  it('refuses a rectangle too small to mean anything', () => {
    // A stray tap would otherwise store a 1% box and produce a scale-derived
    // space that looks measured but is not.
    expect(areaFromDrag(drag([100, 100], [104, 100]))).toBeNull();
  });

  it('clamps a rectangle dragged off the photo', () => {
    expect(areaFromDrag(drag([-200, -200], [1600, 1200]))).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('returns nothing when the photo has no size', () => {
    expect(areaFromDrag({ from: [0, 0], to: [10, 10], box: { width: 0, height: 0 } })).toBeNull();
  });
});

describe('lineFromDrag', () => {
  it('normalises both ends of the line', () => {
    expect(lineFromDrag(drag([80, 300], [480, 300]))).toEqual({ x1: 0.1, y1: 0.5, x2: 0.6, y2: 0.5 });
  });

  it('keeps a diagonal diagonal', () => {
    expect(lineFromDrag(drag([0, 0], [800, 600]))).toEqual({ x1: 0, y1: 0, x2: 1, y2: 1 });
  });

  it('clamps ends that leave the photo', () => {
    expect(lineFromDrag(drag([-50, -50], [850, 650]))).toEqual({ x1: 0, y1: 0, x2: 1, y2: 1 });
  });

  it('refuses a line with no length', () => {
    expect(lineFromDrag(drag([300, 300], [300, 300]))).toBeNull();
  });

  it('refuses a line of a pixel or two, which is a stray tap', () => {
    expect(lineFromDrag(drag([300, 300], [302, 300]))).toBeNull();
  });

  it('returns nothing when the photo has no size', () => {
    expect(lineFromDrag({ from: [0, 0], to: [10, 10], box: { width: 0, height: 0 } })).toBeNull();
  });
});