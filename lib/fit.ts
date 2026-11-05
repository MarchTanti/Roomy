/**
 * The fit rule.
 *
 * Pure arithmetic — no model, no network, no database — so the dimensions that
 * reach it have already been resolved by the caller and the only thing left to
 * get wrong is the formula. That is the whole reason this is a module of its
 * own rather than a few lines inside the tool executor: it is the one piece of
 * the system whose wrong answer is a wrong *fact* told to a customer, and it
 * needs to be readable and testable on its own.
 *
 * The spec's shape for this is already in the database: `reference_line` plus
 * `reference_cm` gives a scale, `selected_area` gives a footprint, and the
 * product row gives the thing being placed. This turns those into a verdict.
 *
 * Two rules that are easy to get wrong and are therefore spelled out:
 *
 *   1. Measurements from a photo run through one isotropic scale. Normalised
 *      photo coordinates are 0..1 on both axes, but a 4:3 photo is a third
 *      wider than tall, so "half the height" is not half the width in
 *      centimetres. Vertical spans are divided by the photo's aspect ratio;
 *      one unit always means "one photo width".
 *   2. A space that cannot be measured is never reported as one that fits. A
 *      NaN compares false against everything, which would otherwise sail
 *      through as a green light.
 */

import type { Area, Json, ReferenceLine } from './db/types';

/** Below this the answer is "fits", but it is not worth recommending. */
export const MIN_CLEARANCE_CM = 5;

/**
 * Shorter than this, a dragged line is an accident rather than a measurement,
 * and the scale it implies would be metres per pixel.
 */
const MIN_LINE_LENGTH = 0.02;

/** What is being placed. Structurally a `Product`, without the whole row. */
export interface FitProduct {
  width_cm: number;
  depth_cm: number;
  height_cm: number;
}

/**
 * The room, in centimetres.
 *
 * `height_cm` is the ceiling height. `null` means nobody measured it, which is
 * different from zero: the height check is skipped and the gap is said out loud
 * rather than assumed away.
 */
export interface FitSpace {
  width_cm: number;
  depth_cm: number;
  height_cm: number | null;
}

export interface FitAxis {
  needed_cm: number;
  available_cm: number;
  /** Room left over. Negative is an overflow, and its size is the overflow. */
  clearance_cm: number;
}

export type FitVerdict = 'fits' | 'tight' | 'does_not_fit';
export type FitAxisName = 'width' | 'depth' | 'height';

export interface FitResult {
  verdict: FitVerdict;
  /** 0 = as catalogued, 90 = turned onto its side. */
  rotation_deg: 0 | 90;
  width: FitAxis;
  depth: FitAxis;
  /** null when no ceiling height was given, meaning height was not checked. */
  height: FitAxis | null;
  /** The axis with the least room left — what to tell the user first. */
  limiting: FitAxisName;
  /** Thai, one per problem, written to be read aloud by the model. */
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Rounding and formatting
// ---------------------------------------------------------------------------

/**
 * One decimal is the honest precision of a measurement taken off a photo, and
 * it keeps the numbers the model quotes readable.
 */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** `4` stays `4`; `40.5` stays `40.5`. Never `4.0`. */
function fmt(n: number): string {
  return String(round1(n));
}

/** An aspect ratio we can actually divide by. */
function saneAspect(aspect: number): number {
  return Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

function axis(needed: number, available: number): FitAxis {
  return {
    needed_cm: round1(needed),
    available_cm: round1(available),
    clearance_cm: round1(available - needed),
  };
}

/**
 * `does_not_fit` for an overflow *and* for a clearance we cannot compute —
 * a space that cannot be measured is not a space we can promise fits.
 */
function axisVerdict(clearance: number): FitVerdict {
  if (!Number.isFinite(clearance) || clearance < 0) return 'does_not_fit';
  return clearance < MIN_CLEARANCE_CM ? 'tight' : 'fits';
}

const SEVERITY: Record<FitVerdict, number> = { fits: 0, tight: 1, does_not_fit: 2 };

function worse(a: FitVerdict, b: FitVerdict): FitVerdict {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

interface Orientation {
  rotation_deg: 0 | 90;
  width: FitAxis;
  depth: FitAxis;
  /** The roomiest the piece is on its two footprint axes. */
  roomiest: number;
}

function orientation(product: FitProduct, space: FitSpace, rotation_deg: 0 | 90): Orientation {
  const footprintWidth = rotation_deg === 0 ? product.width_cm : product.depth_cm;
  const footprintDepth = rotation_deg === 0 ? product.depth_cm : product.width_cm;
  const width = axis(footprintWidth, space.width_cm);
  const depth = axis(footprintDepth, space.depth_cm);

  return {
    rotation_deg,
    width,
    depth,
    roomiest: Math.min(width.clearance_cm, depth.clearance_cm),
  };
}

/**
 * Compare the piece in both orientations and keep the roomier one.
 *
 * A tie goes to the catalogued orientation: telling someone to turn a sofa
 * because a floating-point hair said so would be absurd.
 */
function roomiestOrientation(product: FitProduct, space: FitSpace): Orientation {
  const asCatalogued = orientation(product, space, 0);
  const turned = orientation(product, space, 90);

  return turned.roomiest > asCatalogued.roomiest ? turned : asCatalogued;
}

function axisNote(label: string, axis: FitAxis): string | null {
  if (!Number.isFinite(axis.clearance_cm)) {
    return `${label}วัดไม่ได้ จึงยังยืนยันว่าวางพอดีไม่ได้`;
  }
  if (axis.clearance_cm < 0) {
    return `${label}เกินพื้นที่ ${fmt(-axis.clearance_cm)} ซม. (ต้องการ ${fmt(axis.needed_cm)} ซม. มีแค่ ${fmt(axis.available_cm)} ซม.)`;
  }
  if (axis.clearance_cm < MIN_CLEARANCE_CM) {
    return `${label}เหลือช่องว่างเพียง ${fmt(axis.clearance_cm)} ซม. ควรมีอย่างน้อย ${MIN_CLEARANCE_CM} ซม.`;
  }
  return null;
}

function rotationNote(product: FitProduct, rotation_deg: 0 | 90): string | null {
  if (rotation_deg === 0) return null;
  return `ต้องหมุนตัว 90 องศา เอาด้านยาว ${fmt(product.depth_cm)} ซม. วางเป็นด้านกว้าง ถึงจะพอดี`;
}

/** The tightest axis, which is the one worth naming in the advice. */
function limitingAxis(width: FitAxis, depth: FitAxis, height: FitAxis | null): FitAxisName {
  if (height && height.clearance_cm < depth.clearance_cm) return 'height';
  return width.clearance_cm < depth.clearance_cm ? 'width' : 'depth';
}

export function evaluateFit(product: FitProduct, space: FitSpace): FitResult {
  const best = roomiestOrientation(product, space);
  const height = space.height_cm === null ? null : axis(product.height_cm, space.height_cm);

  const footprintVerdict = worse(
    axisVerdict(best.width.clearance_cm),
    axisVerdict(best.depth.clearance_cm),
  );
  const verdict = height ? worse(footprintVerdict, axisVerdict(height.clearance_cm)) : footprintVerdict;

  // Every step may have nothing to say; the ones that do, say it once.
  const notes: (string | null)[] = [rotationNote(product, best.rotation_deg)];

  if (footprintVerdict === 'fits') {
    notes.push(
      `พื้นที่วางได้ เหลือช่องว่างด้านกว้าง ${fmt(best.width.clearance_cm)} ซม. และด้านลึก ${fmt(best.depth.clearance_cm)} ซม.`,
    );
  } else {
    notes.push(axisNote('ด้านกว้าง', best.width), axisNote('ด้านลึก', best.depth));
  }

  if (height) {
    notes.push(axisNote('ความสูง', height));
  } else {
    // Silence here would read as "and it fits under the ceiling too".
    notes.push(
      `ยังไม่ทราบความสูงเพดาน จึงยังตรวจความสูงไม่ได้ ชิ้นนี้สูง ${fmt(product.height_cm)} ซม.`,
    );
  }

  return {
    verdict,
    rotation_deg: best.rotation_deg,
    width: best.width,
    depth: best.depth,
    height,
    limiting: limitingAxis(best.width, best.depth, height),
    reasons: notes.filter((n): n is string => n !== null),
  };
}

// ---------------------------------------------------------------------------
// Photo → centimetres
// ---------------------------------------------------------------------------

export interface PhotoScale {
  /** Centimetres per photo-width. */
  cm_per_unit: number;
  /** The real-world length the user said their reference line is. */
  reference_cm: number;
  /** Photo width ÷ height, kept so later conversions use the same correction. */
  photo_aspect: number;
}

/**
 * The length of a drawn line in photo-widths, so it can be compared with a
 * stated length in centimetres.
 *
 * Drawn in the photo's own coordinate space, where both axes run 0..1, which
 * is not square unless the photo is. Dividing the vertical run by the aspect
 * ratio puts both axes in the same units.
 */
export function referenceLength(line: ReferenceLine, photoAspect = 1): number {
  return Math.hypot(line.x2 - line.x1, (line.y2 - line.y1) / saneAspect(photoAspect));
}

/**
 * The scale implied by a reference line, or null when there is not enough to
 * work with. Refusing is the point: a plausible-looking number built on a
 * missing measurement is worse than no number.
 */
export function deriveScale(
  line: ReferenceLine | null,
  referenceCm: number | null,
  photoAspect = 1,
): PhotoScale | null {
  if (!line) return null;
  if (referenceCm === null || !Number.isFinite(referenceCm) || referenceCm <= 0) return null;
  if (![line.x1, line.y1, line.x2, line.y2].every((n) => Number.isFinite(n))) return null;

  const aspect = saneAspect(photoAspect);
  const length = referenceLength(line, aspect);
  if (!Number.isFinite(length) || length < MIN_LINE_LENGTH) return null;

  return { cm_per_unit: referenceCm / length, reference_cm: referenceCm, photo_aspect: aspect };
}

/**
 * A drawn rectangle as a space in centimetres.
 *
 * Where the rectangle sits on the photo does not matter — only how big it is.
 * The ceiling is passed through rather than derived: a photo of a wall does
 * not say how high the ceiling is.
 */
export function areaToSpace(
  area: Area | null,
  scale: PhotoScale | null,
  ceilingCm: number | null = null,
): FitSpace | null {
  if (!area || !scale) return null;
  if (![area.w, area.h].every((n) => Number.isFinite(n))) return null;

  return {
    width_cm: round1(area.w * scale.cm_per_unit),
    depth_cm: round1((area.h * scale.cm_per_unit) / saneAspect(scale.photo_aspect)),
    height_cm: Number.isFinite(ceilingCm) && (ceilingCm ?? 0) > 0 ? ceilingCm : null,
  };
}

// ---------------------------------------------------------------------------
// JSON shapes
//
// `FitSpace` and `FitResult` are interfaces, and an interface has no index
// signature, so neither can be handed to `Json` directly. These mappers are
// the one place that says what the JSON looks like — the tool result and the
// generation response have to agree.
// ---------------------------------------------------------------------------

export function spaceToJson(space: FitSpace): Json {
  return {
    width_cm: space.width_cm,
    depth_cm: space.depth_cm,
    height_cm: space.height_cm,
  };
}

export function axisToJson(axis: FitAxis): Json {
  return {
    needed_cm: axis.needed_cm,
    available_cm: axis.available_cm,
    clearance_cm: axis.clearance_cm,
  };
}

export function fitToJson(fit: FitResult): Json {
  return {
    verdict: fit.verdict,
    rotation_deg: fit.rotation_deg,
    width: axisToJson(fit.width),
    depth: axisToJson(fit.depth),
    height: fit.height === null ? null : axisToJson(fit.height),
    limiting: fit.limiting,
    reasons: fit.reasons,
  };
}