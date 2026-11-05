/**
 * The room brief: what the user asked the room to be, and the code that turns
 * that request into a set of real catalogue pieces.
 *
 * This file exists to keep one rule: **the model never does the arithmetic**.
 *
 * A user says "เตียง 3.5 ฟุต" or "ห้อง 24 ตารางเมตร". Those are words, and
 * turning them into centimetres and square metres is arithmetic — which the
 * spec forbids the model from doing, because a number the model made up is a
 * number the database never said. So the model quotes the user's own words and
 * this file parses them.
 *
 * The same goes for choosing the piece. "The bed in the catalogue closest to
 * 106.7 cm" is a decision about numbers, and the numbers come from the rows.
 *
 * Everything the model contributes is taste and intent — the style, the
 * colours, what the room is for. Everything numeric comes from here or from
 * the database.
 */

import type { BriefItem, DbClient, Product, RoomBrief } from '../db/types';

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/** How many centimetres one of each unit is. */
const CM_PER_UNIT = {
  foot: 30.48,
  inch: 2.54,
  centimetre: 1,
  metre: 100,
} as const;

/**
 * The units a length can be written in.
 *
 * The order matters: the longer words come first, so "เซนติเมตร" is read as
 * centimetres rather than as metres, and "ตารางเมตร" is skipped entirely by
 * `parseLength` (a room's area is not a length).
 */
const LENGTH_UNITS: ReadonlyArray<{ pattern: RegExp; cm: number }> = [
  { pattern: /ฟุต|foot|feet|ft\b|['″]/, cm: CM_PER_UNIT.foot },
  { pattern: /นิ้ว|inches|inch|in\b|"/, cm: CM_PER_UNIT.inch },
  { pattern: /เซนติเมตร|ซม|cm\b/, cm: CM_PER_UNIT.centimetre },
  { pattern: /เมตร|ม\.|metres?|meters?|\bm\b/, cm: CM_PER_UNIT.metre },
];

/** A number followed by the unit that belongs to it. */
const MEASURE = /(\d+(?:\.\d+)?)\s*([^\d]{0,14})/g;

/**
 * A number that is an area, not a length: "24 ตารางเมตร", "24 ตร.ม.", "24 m²".
 *
 * A bare "เมตร" is *not* in here: "ห้องกว้าง 4 เมตร" is a width, not an area.
 */
const AREA_WORDS = /ตาราง|ตร\.?\s*ม|ตรม|ตร\.?\s*เมตร|m\s*²|m\s*2|sqm|sq\.?\s*m/i;

/**
 * Reads a length out of the user's own words.
 *
 * Handles one unit ("3.5 ฟุต") and two ("3 ฟุต 6 นิ้ว"), because both turn
 * up in Thai and both mean the same thing to a carpenter.
 *
 * Returns null when there is no length to be had — never a guess. A null here
 * means "the piece has no size attached", not "the size is 0".
 */
export function parseLength(text: string): number | null {
  const source = text.toLowerCase().replace(/,/g, '');
  let total = 0;
  let found = false;

  for (const match of source.matchAll(MEASURE)) {
    const after = match[2] ?? '';
    // "24 ตารางเมตร" is an area; it is not a length of 24 metres.
    if (AREA_WORDS.test(after)) continue;

    const unit = LENGTH_UNITS.find((candidate) => candidate.pattern.test(after));
    if (!unit) continue;

    total += Number(match[1]) * unit.cm;
    found = true;
  }

  return found ? Math.round(total * 100) / 100 : null;
}

/**
 * Reads the size of the room out of the user's own words.
 *
 * Four forms are understood, in this order:
 *
 *   - dimensions — "4x5 เมตร", "400x500 ซม.";
 *   - an area — "24 ตารางเมตร", "24 ตร.ม.";
 *   - two lengths with their words — "กว้าง 4 เมตร ยาว 5 เมตร";
 *   - one length — "ห้องกว้าง 4 เมตร" — which is taken as the width, with the
 *     depth derived from it.
 *
 * An area alone is enough: the floor is derived from it, because a room of 24
 * square metres is not 24 by 24.
 */
export function parseRoomSize(text: string): RoomSize | null {
  const source = text.toLowerCase().replace(/,/g, '');

  // "4x5 เมตร" — dimensions first, because they are exact.
  const dimensions = /(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*([^\d]{0,14})/.exec(source);
  if (dimensions) {
    const unit = unitCm(dimensions[3] ?? '');
    if (unit) {
      const width = Number(dimensions[1]) * unit;
      const depth = Number(dimensions[2]) * unit;
      if (width > 0 && depth > 0) {
        return {
          width_cm: Math.round(width),
          depth_cm: Math.round(depth),
          area_m2: round2((width / 100) * (depth / 100)),
        };
      }
    }
  }

  // "24 ตารางเมตร" — the area, in square metres.
  //
  // The unit has to say "square" in some way. A bare "เมตร" is a length, and
  // reading "ห้องกว้าง 4 เมตร ยาว 5 เมตร" as an area of 4 square metres would
  // put the furniture in the wrong room.
  const area =
    /(\d+(?:\.\d+)?)\s*(?:ตาราง|ตร\.?\s*ม|ตรม|ตร\.?\s*เมตร|m\s*²|m\s*2|sqm|sq\.?\s*m)/.exec(
      source,
    );
  if (area) {
    const squareMetres = Number(area[1]);
    if (squareMetres > 0) {
      return { ...dimensionsFromArea(squareMetres), area_m2: round2(squareMetres) };
    }
  }

  // "กว้าง 4 เมตร ยาว 5 เมตร" — two lengths, each with its own word.
  const wide = /(?:กว้าง|wide)\s*(\d+(?:\.\d+)?)\s*([^\d]{0,10})/.exec(source);
  const deep = /(?:ยาว|deep|length)\s*(\d+(?:\.\d+)?)\s*([^\d]{0,10})/.exec(source);
  if (wide || deep) {
    const widthCm = wide ? Number(wide[1]) * (unitCm(wide[2] ?? '') ?? 0) : 0;
    const depthCm = deep ? Number(deep[1]) * (unitCm(deep[2] ?? '') ?? 0) : 0;
    if (widthCm > 0 && depthCm > 0) {
      return {
        width_cm: Math.round(widthCm),
        depth_cm: Math.round(depthCm),
        area_m2: round2((widthCm / 100) * (depthCm / 100)),
      };
    }
    if (widthCm > 0) {
      const depth = Math.round((widthCm * 2) / 3);
      return {
        width_cm: Math.round(widthCm),
        depth_cm: depth,
        area_m2: round2((widthCm / 100) * (depth / 100)),
      };
    }
    if (depthCm > 0) {
      const width = Math.round((depthCm * 3) / 2);
      return {
        width_cm: width,
        depth_cm: Math.round(depthCm),
        area_m2: round2((width / 100) * (depthCm / 100)),
      };
    }
  }

  // One length on its own — taken as the width.
  const single = /(\d+(?:\.\d+)?)\s*([^\d]{0,14})/.exec(source);
  if (single) {
    const unit = unitCm(single[2] ?? '');
    const width = Number(single[1]) * (unit ?? 0);
    if (unit && width > 0) {
      const depth = Math.round((width * 2) / 3);
      return {
        width_cm: Math.round(width),
        depth_cm: depth,
        area_m2: round2((width / 100) * (depth / 100)),
      };
    }
  }

  return null;
}

/**
 * The centimetres one unit is worth, from the words that follow a number.
 *
 * Null when there is no unit, or when the words are an area — "24 ตารางเมตร"
 * is not 24 metres long.
 */
function unitCm(text: string): number | null {
  if (AREA_WORDS.test(text)) return null;
  const unit = LENGTH_UNITS.find((candidate) => candidate.pattern.test(text));
  return unit ? unit.cm : null;
}

export interface RoomSize {
  /** The floor area in square metres. */
  area_m2: number | null;
  /** The floor, in centimetres. */
  width_cm: number | null;
  depth_cm: number | null;
}

/**
 * The floor of a room of a given area.
 *
 * A room is not square, and the model is not asked to guess a shape: the floor
 * is taken at a ratio of 3:2 (width to depth), which is the shape of most
 * bedrooms and living rooms, and every number here is derived from the area
 * the user gave.
 *
 * 24 square metres therefore becomes 600 x 400 cm.
 */
export function dimensionsFromArea(areaM2: number): { width_cm: number; depth_cm: number } {
  const widthM = Math.sqrt(areaM2 * 1.5);
  const depthM = widthM > 0 ? areaM2 / widthM : 0;
  return {
    width_cm: roundTo(widthM * 100, 5),
    depth_cm: roundTo(depthM * 100, 5),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

/**
 * Whether the brief has enough in it to draw a room.
 *
 * The essentials are the style, the size of the room, and at least one piece.
 * The colour theme is not essential — a room can be drawn without one — but
 * the model is told to ask about it, because a palette is what turns "a room"
 * into "this room".
 */
export function checkBrief(brief: RoomBrief): BriefCheck {
  const missing: string[] = [];

  if (!brief.style.trim()) missing.push('สไตล์ที่ต้องการ');
  if (brief.room_size_m2 === null || brief.width_cm === null) missing.push('ขนาดของห้อง');
  if (brief.items.length === 0) missing.push('ชิ้นสินค้าที่ต้องมีในห้อง');

  return {
    ok: missing.length === 0,
    missing,
    suggestion:
      missing.length > 0
        ? `ถามผู้ใช้เรื่องที่ขาด: ${missing.join(' · ')}`
        : 'ข้อมูลครบแล้ว สรุปแผนให้ผู้ใช้ตรวจก่อนวาด',
  };
}

export interface BriefCheck {
  ok: boolean;
  /** What is missing, in the user's language. */
  missing: string[];
  /** What to do about it, in the user's language. */
  suggestion: string;
}

/**
 * Merges what the model just asked for into the brief the session already
 * holds.
 *
 * A refinement ("เปลี่ยนเป็นสีฟ้า") only carries the part that changed; the
 * rest of the room is what the session remembers. The numbers of the stored
 * brief are re-read from its own words, never copied: the size is parsed
 * again, so a brief that was stored with a size still has one.
 */
export function mergeBrief(stored: RoomBrief | null, incoming: Partial<RoomBrief>): RoomBrief {
  const style = (incoming.style ?? stored?.style ?? '').trim();
  const theme = (incoming.theme ?? stored?.theme ?? null)?.trim() || null;
  const purpose = (incoming.purpose ?? stored?.purpose ?? null)?.trim() || null;
  const roomSizeText = (incoming.room_size ?? stored?.room_size ?? null)?.trim() || null;
  const size = roomSizeText ? parseRoomSize(roomSizeText) : null;

  const items = incoming.items && incoming.items.length > 0 ? incoming.items : (stored?.items ?? []);

  return {
    style,
    theme,
    purpose,
    room_size: roomSizeText,
    room_size_m2: size?.area_m2 ?? null,
    width_cm: size?.width_cm ?? null,
    depth_cm: size?.depth_cm ?? null,
    budget_thb: incoming.budget_thb ?? stored?.budget_thb ?? null,
    items: items.map((item) => ({
      category: item.category,
      note: item.note ?? '',
      requested_width: item.requested_width ?? null,
      product_id: item.product_id ?? null,
    })),
    instruction: incoming.instruction ?? stored?.instruction ?? null,
  };
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/** A catalogue row, chosen for the room, with the user's words still on it. */
export interface ResolvedPiece {
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
  /** How far the row's width is from what they asked for. */
  width_gap_cm: number | null;
}

/** Something the brief asked for that the catalogue could not answer. */
export interface BriefProblem {
  /** The category that had no match. */
  category: string;
  /** The user's own words about it. */
  note: string;
  /** Why it could not be answered, in the user's language. */
  message: string;
}

/**
 * Turns the brief's pieces into catalogue rows.
 *
 * A piece that was already chosen in an earlier version keeps that row — the
 * user refining a room does not expect a different sofa. A piece that is new
 * is looked for: by category, then by how close its width is to what was
 * asked for, then by style and colour, and finally by price.
 */
export async function resolveBrief(
  db: DbClient,
  brief: RoomBrief,
): Promise<{ pieces: ResolvedPiece[]; problems: BriefProblem[] }> {
  const pieces: ResolvedPiece[] = [];
  const problems: BriefProblem[] = [];

  for (const item of brief.items) {
    const product = await findPiece(db, item, brief);
    if (!product) {
      problems.push({
        category: item.category,
        note: item.note,
        message: `ไม่มี${labelOf(item.category)}ในแคตตาล็อกที่ตรงกับที่ขอ`,
      });
      continue;
    }
    pieces.push(toPiece(product, item));
  }

  return { pieces, problems };
}

/** The row for one piece of the brief, or null when the catalogue has none. */
async function findPiece(db: DbClient, item: BriefItem, brief: RoomBrief): Promise<Product | null> {
  if (item.product_id) {
    const kept = await db.getProduct(item.product_id);
    if (kept) return kept;
  }

  const candidates = await db.searchProducts({
    category: item.category,
    max_price_thb: brief.budget_thb ?? undefined,
    in_stock_only: true,
    limit: 12,
  });
  if (candidates.length === 0) return null;

  const target = item.requested_width ? parseLength(item.requested_width) : null;

  let best: Product | null = null;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const score = scorePiece(candidate, brief, target);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/**
 * How well a catalogue row answers the brief.
 *
 * The width dominates when one was asked for: a bed 40 cm too wide is a
 * different bed. Style and colour break a tie, and the cheaper row wins when
 * everything else is equal — the catalogue is sorted by price anyway, and a
 * room should not cost more than it has to.
 */
function scorePiece(product: Product, brief: RoomBrief, targetWidthCm: number | null): number {
  let score = 0;

  if (targetWidthCm !== null) {
    // Ten points per centimetre off, so nothing else can outvote a size.
    score += 10_000 - Math.min(9_999, Math.abs(product.width_cm - targetWidthCm) * 10);
  }
  if (styleMatches(product, brief.style)) score += 30;
  if (colourMatches(product, brief.theme)) score += 10;

  return score - product.price_thb / 100_000;
}

/** True when the row carries the style the brief asks for. */
function styleMatches(product: Product, style: string): boolean {
  const needle = canonicalStyle(style);
  if (!needle) return false;
  return product.style_tags.some((tag) => {
    const value = canonicalStyle(tag);
    if (!value) return false;
    return value === needle || value.includes(needle) || needle.includes(value);
  });
}

/**
 * The style words the model is likely to pass, and the tag the catalogue uses.
 *
 * The model quotes the user's words — "มินิมอล" — and the catalogue rows are
 * tagged in English — "minimal". Without this the style would never match, and
 * the piece would be chosen on price alone.
 */
const STYLE_ALIASES: Record<string, string> = {
  'มินิมอล': 'minimal',
  'มินิมัล': 'minimal',
  'มินิม': 'minimal',
  minimal: 'minimal',
  'สแกนดินาเวีย': 'scandinavian',
  'สแกนดิ': 'scandinavian',
  'สวีเดน': 'scandinavian',
  scandinavian: 'scandinavian',
  'ญี่ปุ่น': 'japandi',
  japandi: 'japandi',
  'ญี่ปุ่นสไตล์': 'japandi',
  'โมเดิร์น': 'modern',
  modern: 'modern',
  'วินเทจ': 'vintage',
  vintage: 'vintage',
  'อินดูสตรี': 'industrial',
  industrial: 'industrial',
  'คลาสสิก': 'classic',
  classic: 'classic',
  'โบโฮ': 'boho',
  boho: 'boho',
  'ลอฟต์': 'loft',
  loft: 'loft',
  'คลาสสิกยุค': 'classic',
};

/**
 * The catalogue's word for a style, whether it came in Thai or in English.
 *
 * Exported because the results script compares the style of a drawn room with
 * the style the user asked for, and it has to use the same aliases this file
 * uses — "มินิมอล" and "minimal" are one style, not two.
 */
export function canonicalStyle(text: string): string {
  const value = text.trim().toLowerCase();
  if (!value) return '';
  return STYLE_ALIASES[value] ?? value;
}

/**
 * True when the row's colour is one of the theme's colours.
 *
 * The theme is a phrase in the user's words ("สีชมพู-ขาวพาสเทล"), so it is
 * broken into words and each word is looked for in the row's colour and in its
 * style tags. A row tagged 'pastel' answers a 'พาสเทล' theme.
 */
function colourMatches(product: Product, theme: string | null): boolean {
  if (!theme) return false;
  const words = theme
    .split(/[^฀-๿a-z]+/i)
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word.length >= 3);
  if (words.length === 0) return false;

  const haystack = [product.color ?? '', ...product.style_tags].join(' ').toLowerCase();
  return words.some((word) => haystack.includes(word));
}

/** The piece, with the user's words still attached to it. */
function toPiece(product: Product, item: BriefItem): ResolvedPiece {
  const requested = item.requested_width ? parseLength(item.requested_width) : null;
  return {
    product_id: product.id,
    name_th: product.name_th,
    name_en: product.name_en,
    category: product.category,
    color: product.color,
    material: product.material,
    price_thb: product.price_thb,
    width_cm: product.width_cm,
    depth_cm: product.depth_cm,
    height_cm: product.height_cm,
    image_url: product.image_url,
    note: item.note,
    requested_width_cm: requested,
    width_gap_cm: requested === null ? null : Math.round(Math.abs(product.width_cm - requested) * 10) / 10,
  };
}

/** A Thai word for a catalogue category, for the messages the user reads. */
function labelOf(category: string): string {
  const labels: Record<string, string> = {
    sofa: 'โซฟา',
    armchair: 'เก้าอี้',
    table: 'โต๊ะ',
    shelf: 'ชั้นวาง',
    lamp: 'โคมไฟ',
    bed: 'เตียง',
    desk: 'โต๊ะทำงาน',
    chair: 'เก้าอี้',
    cabinet: 'ตู้',
    rug: 'พรม',
    tv_stand: 'โต๊ะวางทีวี',
    dresser: 'โต๊ะแต่งตัว',
  };
  return labels[category] ?? category;
}
