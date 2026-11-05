/**
 * What the client sees of a designed room.
 *
 * The shape is shared by the server and the browser so the two cannot drift:
 * the tool result is this object, the chat route sends it as it is, and the
 * card in the chat renders it.
 */

export interface DesignPieceView {
  product_id: string;
  name_th: string;
  name_en: string;
  category: string;
  color: string | null;
  material: string | null;
  price_thb: number;
  width_cm: number;
  depth_cm: number;
  height_cm: number;
  image_url: string;
  /** The user's own words about this piece. */
  note: string;
  /** The width they asked for, in centimetres, when they asked for one. */
  requested_width_cm: number | null;
  /** How far the catalogue's width is from what they asked for. */
  width_gap_cm: number | null;
}

export interface DesignView {
  image_id: string;
  /** The signed URL, when the store can make one. */
  url: string | null;
  expires_at: string | null;
  /** 1 for the first version of this room, 2 for the next, and so on. */
  version: number;
  style: string;
  theme: string | null;
  purpose: string | null;
  room_size_m2: number | null;
  width_cm: number | null;
  depth_cm: number | null;
  /** What the pieces together cost, from the catalogue rows. */
  total_price_thb: number;
  pieces: DesignPieceView[];
  /** The change the user asked for, when this version is an iteration. */
  instruction: string | null;
  /** What the user should be told: a size that differs, a budget that is over. */
  notes: string[];
  /** How many pictures this session may still draw. */
  image_quota_left: number;
}
