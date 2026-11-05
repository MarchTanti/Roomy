/**
 * The catalogue fit sweep.
 *
 * Step 8 of the build plan asks for a `results.json`. The half of it that
 * needs no model is this: every product in the catalogue, put against one
 * measured space, judged by the same rule the chat uses.
 *
 * It is the check that matters for the catalogue. A chat answer is one
 * product's verdict on one day; this is all of them at once, so a rule that
 * is wrong shows up as a row that is wrong rather than as one bad sentence in
 * a conversation.
 *
 * Pure: no model, no network, no database. The rows come in, the verdicts go
 * out.
 */

import { evaluateFit, type FitAxis, type FitSpace, type FitVerdict } from '../fit';
import type { Product } from '../db/types';

export interface CatalogueFitRow {
  product_id: string;
  name_th: string;
  category: string;
  price_thb: number;
  size_cm: { width: number; depth: number; height: number };
  verdict: FitVerdict;
  /** 0 = as catalogued, 90 = turned onto its side. */
  rotation_deg: 0 | 90;
  /** The axis with the least room left. */
  limiting: 'width' | 'depth' | 'height';
  /** Room left on that axis. Negative is an overflow. */
  clearance_cm: number;
  /** The fit rule's own sentence, in Thai — the first of them. */
  reason: string;
  /** Every sentence the fit rule wrote, in Thai. */
  reasons: string[];
}

export interface CatalogueFitSummary {
  total: number;
  fits: number;
  tight: number;
  does_not_fit: number;
}

export interface CatalogueFitResult {
  space_cm: { width: number; depth: number; height: number | null };
  rows: CatalogueFitRow[];
  summary: CatalogueFitSummary;
}

/** The axis the rule named, as the numbers behind it. */
function limitingAxis(
  width: FitAxis,
  depth: FitAxis,
  height: FitAxis | null,
  limiting: 'width' | 'depth' | 'height',
): FitAxis {
  if (limiting === 'width') return width;
  if (limiting === 'depth') return depth;
  // The rule only names the height when the height was checked.
  return height ?? width;
}

/**
 * Judges every product against one space.
 *
 * The order of the rows is the order of the catalogue, so the report reads
 * the same way twice.
 */
export function evaluateCatalogue(products: readonly Product[], space: FitSpace): CatalogueFitResult {
  const rows: CatalogueFitRow[] = [];

  for (const product of products) {
    const fit = evaluateFit(product, space);
    const axis = limitingAxis(fit.width, fit.depth, fit.height, fit.limiting);

    rows.push({
      product_id: product.id,
      name_th: product.name_th,
      category: product.category,
      price_thb: product.price_thb,
      size_cm: {
        width: product.width_cm,
        depth: product.depth_cm,
        height: product.height_cm,
      },
      verdict: fit.verdict,
      rotation_deg: fit.rotation_deg,
      limiting: fit.limiting,
      clearance_cm: axis.clearance_cm,
      reason: fit.reasons[0] ?? '',
      reasons: fit.reasons,
    });
  }

  return {
    space_cm: {
      width: space.width_cm,
      depth: space.depth_cm,
      height: space.height_cm,
    },
    rows,
    summary: {
      total: rows.length,
      fits: rows.filter((r) => r.verdict === 'fits').length,
      tight: rows.filter((r) => r.verdict === 'tight').length,
      does_not_fit: rows.filter((r) => r.verdict === 'does_not_fit').length,
    },
  };
}
