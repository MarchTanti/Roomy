/**
 * Pointer maths for the area picker.
 *
 * A drag on screen becomes the normalised coordinates the spec stores:
 * `selected_area` and `reference_line` are both 0..1 fractions of the photo,
 * which is what makes them independent of how large the photo is drawn.
 *
 * Deliberately *not* here: any conversion to centimetres. That is
 * `lib/fit.ts`'s job, on the server, where the photo's real pixel dimensions
 * are known — a displayed image knows nothing about its own aspect.
 */

import type { Area, ReferenceLine } from '@/lib/db/types';

export interface Point {
  x: number;
  y: number;
}

/** The photo element the drag happened over. */
export interface Bounds {
  width: number;
  height: number;
}

export interface Drag {
  from: [number, number];
  to: [number, number];
  box: Bounds;
}

/**
 * Shortest drag worth storing, as a fraction of the photo.
 *
 * Matches the server's own floor for a reference line. Below it, a stray tap
 * would become a "measurement" that looks precise and is not.
 */
const MIN_DRAG = 0.02;

/** Four decimals: finer than a photo can be measured, coarse enough to store. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** A client position as a 0..1 point, or null before the photo has a size. */
export function normalizedPoint(point: Point, box: Bounds): Point | null {
  if (box.width <= 0 || box.height <= 0) return null;
  return {
    x: clamp01(point.x / box.width),
    y: clamp01(point.y / box.height),
  };
}

function endpoints(drag: Drag): { a: Point; b: Point } | null {
  const a = normalizedPoint({ x: drag.from[0], y: drag.from[1] }, drag.box);
  const b = normalizedPoint({ x: drag.to[0], y: drag.to[1] }, drag.box);
  return a && b ? { a, b } : null;
}

/**
 * A drag as a rectangle, anchored at its top-left corner so the result does
 * not depend on which way the gesture went.
 */
export function areaFromDrag(drag: Drag): Area | null {
  const ends = endpoints(drag);
  if (!ends) return null;

  const w = Math.abs(ends.b.x - ends.a.x);
  const h = Math.abs(ends.b.y - ends.a.y);
  if (w < MIN_DRAG || h < MIN_DRAG) return null;

  return {
    x: round4(Math.min(ends.a.x, ends.b.x)),
    y: round4(Math.min(ends.a.y, ends.b.y)),
    w: round4(w),
    h: round4(h),
  };
}

/**
 * A drag as a reference line — the edge of something whose real length the
 * user knows, which is what turns pixels into centimetres.
 */
export function lineFromDrag(drag: Drag): ReferenceLine | null {
  const ends = endpoints(drag);
  if (!ends) return null;
  if (Math.hypot(ends.b.x - ends.a.x, ends.b.y - ends.a.y) < MIN_DRAG) return null;

  return {
    x1: round4(ends.a.x),
    y1: round4(ends.a.y),
    x2: round4(ends.b.x),
    y2: round4(ends.b.y),
  };
}