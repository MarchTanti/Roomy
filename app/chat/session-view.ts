/**
 * The shapes the client renders.
 *
 * They live in one file so the panels, the cards and the chat can all talk
 * about the same session without importing each other.
 */

import type { Area, ReferenceLine } from '@/lib/db/types';

/** What the model made of the room photo. */
export interface RoomAnalysisView {
  style: string;
  colors: string[];
  lighting: string;
  free_areas?: string[];
}

/** The measurement the user drew on the photo. */
export interface MeasurementView {
  selected_area: Area | null;
  reference_line: ReferenceLine | null;
  reference_cm: number | null;
}

/** The room the user asked to have designed. */
export interface DesignBriefView {
  style: string;
  theme: string | null;
  purpose: string | null;
  room_size_m2: number | null;
  width_cm: number | null;
  depth_cm: number | null;
  budget_thb: number | null;
  items: {
    category: string;
    note: string;
    requested_width: string | null;
    product_id: string | null;
  }[];
  instruction: string | null;
}

/** Everything the server stored about this session. */
export interface SessionStateView extends MeasurementView {
  preferences: { style: string | null; budget_thb: number | null; category: string | null };
  room_image_id: string | null;
  room_analysis: RoomAnalysisView | null;
  shown_products: string[];
  selected_product_id: string | null;
  generated_image_ids: string[];
  design_brief: DesignBriefView | null;
}
