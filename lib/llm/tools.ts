/**
 * Tool declarations and their executors.
 *
 * Every argument is validated with Zod before it reaches the database. A
 * validation failure is returned to the model as a plain object describing what
 * was wrong, so the model can fix its own call — it is never an exception.
 *
 * Failures are reported the same way, as data the model can read and route
 * around, rather than by throwing. A model that calls `analyzeRoom` on a session
 * with no photo should be told "ask the user to upload one", not handed a 500.
 */

import { z } from 'zod';

import { getDb } from '../db';
import type { Json, Product } from '../db/types';
import { designRoom, executeDesignRoom } from '../design/tool';
import {
  areaToSpace,
  deriveScale,
  evaluateFit,
  fitToJson,
  spaceToJson,
  type FitSpace,
} from '../fit';
import { getPhotoStore, readDimensions } from '../storage';
import { getRoomAnalyzer } from './index';
import type { ToolContext, ToolExecutor } from './loop';
import type { ToolCall, ToolSpec } from './types';
import type { LlmMessage } from './types';

// ---------------------------------------------------------------------------
// searchFurniture — works today (the catalog is seeded)
// ---------------------------------------------------------------------------

const SearchArgs = z.object({
  category: z.string().min(1).optional(),
  style: z.string().min(1).optional(),
  max_price_thb: z.number().nonnegative().optional(),
  color: z.string().min(1).optional(),
  in_stock_only: z.boolean().optional(),
  limit: z.number().int().min(1).max(12).optional(),
});

const searchFurniture: ToolSpec = {
  name: 'searchFurniture',
  description:
    'ค้นหาเฟอร์นิเจอร์ในแคตตาล้อก คืนรายการพร้อมราคาและขนาดจริงจากฐานข้อมูล ' +
    'เรียงจากราคาถูกไปแพง ใช้เมื่อผู้ใช้บอกสไตล์ งบประมาณ หรือหมวดหมู่ที่ต้องการ',
  parameters: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description:
          'หมวดหมู่ เช่น sofa, armchair, table, shelf, lamp, bed, desk, chair, cabinet, rug, tv_stand, dresser',
        enum: [
          'sofa',
          'armchair',
          'table',
          'shelf',
          'lamp',
          'bed',
          'desk',
          'chair',
          'cabinet',
          'rug',
          'tv_stand',
          'dresser',
        ],
      },
      style: {
        type: 'string',
        description: 'สไตล์ เช่น modern, minimalist, scandinavian, japandi, loft, industrial, classic',
      },
      max_price_thb: { type: 'number', description: 'ราคาสูงสุดเป็นบาท' },
      color: { type: 'string', description: 'สีที่ต้องการ เช่น สีเทา, สีขาว, สีไม้' },
      in_stock_only: { type: 'boolean', description: 'เฉพาะของที่มีในสต็อก' },
      limit: { type: 'number', description: 'จำนวนผลลัพธ์สูงสุด (1-12, ค่าเริ่มต้น 6)' },
    },
  },
};

async function executeSearchFurniture(args: Json): Promise<Json> {
  const parsed = SearchArgs.safeParse(args);
  if (!parsed.success) {
    return {
      error: 'invalid_arguments',
      issues: parsed.error.issues.map((i) => ({
        field: i.path.join('.'),
        problem: i.message,
      })),
    };
  }

  const filter = {
    ...parsed.data,
    in_stock_only: parsed.data.in_stock_only ?? true,
    limit: parsed.data.limit ?? 6,
  };

  const products = await getDb().searchProducts(filter);

  return {
    count: products.length,
    products: products.map((p) => ({
      id: p.id,
      name_th: p.name_th,
      name_en: p.name_en,
      category: p.category,
      style_tags: p.style_tags,
      color: p.color,
      material: p.material,
      price_thb: p.price_thb,
      width_cm: p.width_cm,
      depth_cm: p.depth_cm,
      height_cm: p.height_cm,
      image_url: p.image_url,
      in_stock: p.in_stock,
      source: p.source,
      source_url: p.source_url,
    })),
  };
}

// ---------------------------------------------------------------------------
// analyzeRoom — build step 3 (room photo upload)
// ---------------------------------------------------------------------------

// Optional: with no `image_id` the tool analyses the session's current room
// photo, which is what the model wants almost every time. Requiring it would
// make the model echo an id back that it only knows because we put it in the
// session state — one more thing to get wrong.
const AnalyzeRoomArgs = z.object({
  image_id: z.string().min(1).optional(),
});

const analyzeRoom: ToolSpec = {
  name: 'analyzeRoom',
  description:
    'วิเคราะห์รูปห้องของผู้ใช้ เพื่อบอกสไตล์ สี แสง และพื้นที่ว่างที่เหลือ ' +
    'เรียกเมื่อผู้ใช้อัปโหลดรูปห้อง หรือเมื่อผู้ใช้ถามว่าห้องเป็นสไตล์อะไร',
  parameters: {
    type: 'object',
    properties: {
      image_id: {
        type: 'string',
        description: 'id ของรูปห้อง ถ้าไม่ระบุจะใช้รูปห้องปัจจุบันของเซสชัน',
      },
    },
  },
};

async function executeAnalyzeRoom(args: Json, context?: ToolContext): Promise<Json> {
  const parsed = AnalyzeRoomArgs.safeParse(args);
  if (!parsed.success) {
    return {
      error: 'invalid_arguments',
      issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), problem: i.message })),
    };
  }

  // Resolving the photo needs the session, and the loop is the only layer that
  // knows which session a turn belongs to.
  if (!context) {
    return {
      error: 'unavailable',
      reason: 'ไม่ทราบเซสชันของคำขอนี้',
      guidance: 'ให้ถามผู้ใช้ให้อัปโหลดรูปห้องก่อน แล้วค่อยวิเคราะห์',
    };
  }

  const requested = parsed.data.image_id;
  const imageId = requested ?? context.session.state.room_image_id;
  if (!imageId) {
    return {
      error: 'no_room_photo',
      reason: 'ยังไม่มีรูปห้องของเซสชันนี้',
      guidance: 'ให้ผู้ใช้อัปโหลดรูปห้องก่อน แล้วจึงเรียก analyzeRoom อีกครั้ง',
    };
  }

  const record = await context.db.getImage(imageId);
  if (!record) {
    return {
      error: 'image_not_found',
      requested: imageId,
      guidance: 'รูปที่ระบุไม่มีอยู่ในระบบ ให้ถามผู้ใช้ให้อัปโหลดรูปใหม่',
    };
  }

  try {
    // Through the store rather than the Supabase client directly, so the tool
    // works on the local adapter too.
    const bytes = await getPhotoStore().get(record.storage_path, record.session_id);
    const analysis = await getRoomAnalyzer().analyze(bytes.toString('base64'));
    // The route stores this in session state; returning it means the model can
    // read the fresh result even if the write has not landed yet.
    return { image_id: record.id, ...analysis };
  } catch (err) {
    return {
      error: 'analysis_failed',
      reason: err instanceof Error ? err.message : 'วิเคราะห์รูปห้องไม่สำเร็จ',
      guidance: 'ให้ถามรายละเอียดห้องเป็นข้อความแทน เช่น สไตล์ที่ชอบและสีในห้อง',
    };
  }
}

// ---------------------------------------------------------------------------
// checkFit — build step 4 (rule-based size check)
// ---------------------------------------------------------------------------

/**
 * Only `product_id` is required, and the two ways of measuring a space are both
 * optional on purpose:
 *
 *   - the session may carry a space the user measured on the photo (an area
 *     plus a reference line of known length), which the tool reads itself;
 *   - the model may pass centimetres the user typed in the chat.
 *
 * If both exist the photo wins. It is the user marking their own room, where a
 * number that reached us through the model is a second-hand guess.
 *
 * Note what is *not* here: any dimension of the product. The spec says those
 * come from the database, so there is no argument for the model to pass and no
 * code path that would honour one.
 */
const CheckFitArgs = z.object({
  product_id: z.string().min(1),
  area_width_cm: z.number().positive().optional(),
  area_depth_cm: z.number().positive().optional(),
  area_height_cm: z.number().positive().optional(),
});

const checkFit: ToolSpec = {
  name: 'checkFit',
  description:
    'ตรวจว่าเฟอร์นิเจอร์ที่เลือกจะวางลงในพื้นที่ที่ระบุได้หรือไม่ ใช้กฎคำนวณจากขนาดจริงในฐานข้อมูลเท่านั้น ' +
    'ถ้าผู้ใช้ลากกรอบพื้นที่และเส้นอ้างอิงไว้บนรูปห้องแล้ว ให้เรียกโดยไม่ต้องใส่ขนาดเลย ' +
    'ถ้าผู้ใช้บอกขนาดเป็นตัวเลขมา ให้ใส่ area_width_cm และ area_depth_cm (เซนติเมตร) และ area_height_cm ถ้าทราบความสูงเพดาน',
  parameters: {
    type: 'object',
    properties: {
      product_id: { type: 'string', description: 'id ของสินค้า' },
      area_width_cm: {
        type: 'number',
        description: 'ความกว้างพื้นที่ว่าง (cm) — ไม่ต้องใส่ถ้าผู้ใช้วัดบนรูปแล้ว',
      },
      area_depth_cm: {
        type: 'number',
        description: 'ความลึกพื้นที่ว่าง (cm) — ไม่ต้องใส่ถ้าผู้ใช้วัดบนรูปแล้ว',
      },
      area_height_cm: {
        type: 'number',
        description: 'ความสูงเพดาน (cm) ถ้าทราบ ใช้ตรวจว่าสูงเกินไปหรือไม่',
      },
    },
    required: ['product_id'],
  },
};

/** The space the user typed in chat, if both floor dimensions are present. */
function statedSpace(args: z.infer<typeof CheckFitArgs>): FitSpace | null {
  if (args.area_width_cm === undefined || args.area_depth_cm === undefined) return null;
  return {
    width_cm: args.area_width_cm,
    depth_cm: args.area_depth_cm,
    height_cm: args.area_height_cm ?? null,
  };
}

/**
 * The space the user drew on the room photo.
 *
 * The photo's aspect ratio comes from the stored file rather than the caller:
 * without it, every vertical measurement is out by a third on a 4:3 phone
 * photo. Returns null — never a guess — when any piece is missing, including
 * when the photo itself cannot be read, because assuming a square photo would
 * hand back a depth that looks like a measurement but is not.
 */
async function photoSpace(
  context: ToolContext | undefined,
  ceilingCm: number | undefined,
): Promise<FitSpace | null> {
  if (!context) return null;
  const { selected_area, reference_line, reference_cm, room_image_id } = context.session.state;

  // Cheap checks first: there is no point fetching a photo that has nothing to
  // scale it with, and no error to log for a call that never needed it.
  if (!selected_area || !reference_line || reference_cm === null) return null;

  const aspect = await photoAspect(context, room_image_id);
  if (aspect === null) return null;

  const scale = deriveScale(reference_line, reference_cm, aspect);
  if (!scale) return null;
  return areaToSpace(selected_area, scale, ceilingCm ?? null);
}

/** Photo width ÷ height, or null when the room photo cannot be measured. */
async function photoAspect(
  context: ToolContext,
  roomImageId: string | null,
): Promise<number | null> {
  if (!roomImageId) return null;
  const record = await context.db.getImage(roomImageId);
  if (!record) return null;

  try {
    const bytes = await getPhotoStore().get(record.storage_path, record.session_id);
    const { width, height } = await readDimensions(bytes);
    return width / height;
  } catch (err) {
    console.error('[checkFit] cannot read the room photo:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** True when the session carries a measurement the photo path should have used. */
function hasPhotoMeasurement(context: ToolContext | undefined): boolean {
  return context !== undefined && context.session.state.selected_area !== null;
}

/**
 * The space a previous `checkFit` judged against, read back from the transcript.
 *
 * `checkFit` also accepts a space the user typed in the chat, and that is the
 * only space there is when the room was never measured on a photo. The tool
 * result is in the conversation already, so the space is read from there
 * rather than kept somewhere the spec does not have a place for.
 *
 * The newest one wins: the user may have corrected the size since.
 */
function lastCheckedSpace(history: readonly LlmMessage[] | undefined): FitSpace | null {
  if (!history) return null;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    for (const part of history[index].parts) {
      if (part.kind !== 'toolResult' || part.name !== 'checkFit') continue;

      const result = part.result;
      if (typeof result !== 'object' || result === null || Array.isArray(result)) continue;
      const space = (result as Record<string, Json>).space;
      if (typeof space !== 'object' || space === null || Array.isArray(space)) continue;

      const record = space as Record<string, Json>;
      const width = record.width_cm;
      const depth = record.depth_cm;
      if (typeof width !== 'number' || typeof depth !== 'number') continue;

      const height = record.height_cm;
      return {
        width_cm: width,
        depth_cm: depth,
        height_cm: typeof height === 'number' ? height : null,
      };
    }
  }

  return null;
}

async function executeCheckFit(args: Json, context?: ToolContext): Promise<Json> {
  const parsed = CheckFitArgs.safeParse(args);
  if (!parsed.success) {
    return {
      error: 'invalid_arguments',
      issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), problem: i.message })),
    };
  }

  const product = await getDb().getProduct(parsed.data.product_id);
  if (!product) {
    return {
      error: 'product_not_found',
      requested: parsed.data.product_id,
      guidance: 'สินค้าที่ระบุไม่มีในแคตตาล้อก ให้เรียก searchFurniture เพื่อหา id ที่ถูกต้อง',
    };
  }

  const notes: string[] = [];
  const stated = statedSpace(parsed.data);

  const measured = await photoSpace(context, parsed.data.area_height_cm);
  let space = measured;
  let source: 'photo_scale' | 'stated_cm' = 'photo_scale';

  if (!space && hasPhotoMeasurement(context) && stated) {
    notes.push('อ่านรูปห้องเพื่อวัดสเกลไม่ได้ ใช้ตัวเลขที่ผ่านเข้ามาแทน (fallback)');
  }

  if (!space) {
    space = stated;
    source = 'stated_cm';
  } else if (stated) {
    notes.push('ใช้ขนาดที่วัดจากรูปภาพแทนตัวเลขที่ผ่านเข้ามา (photo wins over stated cm)');
  }

  if (!space) {
    return {
      error: 'no_space_data',
      reason: 'ยังไม่ทราบขนาดพื้นที่ที่จะวาง',
      guidance:
        'ให้ถามผู้ใช้ว่าพื้นที่กว้างและลึกเท่าไร (ส่งเป็นตัวเลข) หรือให้ผู้ใช้ลากกรอบพื้นที่และเส้นอ้างอิงที่รู้ความยาวจริงบนรูปห้องก่อน แล้วเรียก checkFit อีกครั้ง',
    };
  }

  const fit = evaluateFit(product, space);

  return {
    product: {
      id: product.id,
      name_th: product.name_th,
      width_cm: product.width_cm,
      depth_cm: product.depth_cm,
      height_cm: product.height_cm,
    },
    space: spaceToJson(space),
    space_source: source,
    fit: fitToJson(fit),
    ...(notes.length > 0 ? { notes } : {}),
    // Quoted from the row, never from anything the model said.
    price_thb: product.price_thb,
  };
}

// ---------------------------------------------------------------------------
// The products of the last search
//
// The chat needs the products themselves, not just the ids the model was
// working from: the client shows a card per product, and the card is what the
// user presses to ask for a picture. The tool result is already in the
// history, so this reads it back rather than running the search again.
// ---------------------------------------------------------------------------

/** A product as the client sees it. */
export interface SearchProduct {
  id: string;
  name_th: string;
  name_en: string;
  category: string;
  style_tags: string[];
  color: string | null;
  material: string | null;
  price_thb: number;
  width_cm: number;
  depth_cm: number;
  height_cm: number;
  image_url: string;
  in_stock: boolean;
  /** Where the product can be seen, when the catalogue row knows. */
  source_url: string | null;
}

function asString(value: Json | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: Json | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Reads one product out of a tool result.
 *
 * The result is jsonb on the way back from the database, so it is treated as
 * untrusted: a row edited by hand, or written by an older version, must not
 * take the client down.
 */
function toSearchProduct(value: Json): SearchProduct | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, Json>;

  const id = asString(row.id);
  const nameTh = asString(row.name_th);
  const width = asNumber(row.width_cm);
  const depth = asNumber(row.depth_cm);
  const height = asNumber(row.height_cm);
  const price = asNumber(row.price_thb);
  if (id === null || nameTh === null || width === null || depth === null) return null;

  const styleTags = Array.isArray(row.style_tags)
    ? row.style_tags.filter((tag): tag is string => typeof tag === 'string')
    : [];

  return {
    id,
    name_th: nameTh,
    name_en: asString(row.name_en) ?? nameTh,
    category: asString(row.category) ?? '',
    style_tags: styleTags,
    color: asString(row.color),
    material: asString(row.material),
    price_thb: price ?? 0,
    width_cm: width,
    depth_cm: depth,
    height_cm: height ?? 0,
    image_url: asString(row.image_url) ?? '',
    in_stock: row.in_stock === true,
    source_url: asString(row.source_url),
  };
}

/**
 * The products from the most recent `searchFurniture` call in this turn.
 *
 * Backwards through the history, so a turn that searched twice shows the
 * second result — the one the reply is about.
 */
export function extractSearchProducts(history: readonly LlmMessage[]): SearchProduct[] {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    for (let p = message.parts.length - 1; p >= 0; p -= 1) {
      const part = message.parts[p];
      if (part.kind !== 'toolResult' || part.name !== 'searchFurniture') continue;

      const result = part.result;
      if (typeof result !== 'object' || result === null || Array.isArray(result)) continue;
      const products = (result as Record<string, Json>).products;
      if (!Array.isArray(products)) continue;

      return products
        .map((product) => toSearchProduct(product))
        .filter((product): product is SearchProduct => product !== null);
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// compareOptions — build step 6 (comparing two or three products)
// ---------------------------------------------------------------------------

/**
 * Only ids go in. The model never passes a price or a dimension, because
 * those come from the rows — the same rule `checkFit` follows.
 */
const CompareOptionsArgs = z.object({
  product_ids: z.array(z.string().min(1)).min(2).max(4),
});

const compareOptions: ToolSpec = {
  name: 'compareOptions',
  description:
    'เทียบสินค้า 2-4 ตัวเคียงกัน คืนราคา ขนาดจริง และผลตรวจว่าวางพอดีไหมของแต่ละตัว ' +
    'พร้อมบอกว่าตัวไหนถูกสุดและตัวไหนวางได้ดีที่สุด ' +
    'เรียกเมื่อผู้ใช้ถามว่าตัวไหนดีกว่า หรือขอให้เทียบสองสามตัว',
  parameters: {
    type: 'object',
    properties: {
      product_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'id ของสินค้าที่จะเทียบกัน (2-4 ตัว) จากผลลัพธ์ของ searchFurniture',
      },
    },
    required: ['product_ids'],
  },
};

/** How bad a verdict is, so "the one that fits best" can be picked. */
const VERDICT_RANK: Record<string, number> = { fits: 0, tight: 1, does_not_fit: 2 };

async function executeCompareOptions(args: Json, context?: ToolContext): Promise<Json> {
  const parsed = CompareOptionsArgs.safeParse(args);
  if (!parsed.success) {
    return {
      error: 'invalid_arguments',
      issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), problem: i.message })),
    };
  }

  const db = getDb();
  const products: Product[] = [];
  const missing: string[] = [];
  for (const id of parsed.data.product_ids) {
    const product = await db.getProduct(id);
    if (product) products.push(product);
    else missing.push(id);
  }

  if (products.length < 2) {
    return {
      error: 'not_enough_products',
      found: products.length,
      missing_ids: missing,
      guidance:
        'ต้องมีสินค้าที่หาเจออย่างน้อย 2 ตัวจึงจะเทียบได้ ให้เรียก searchFurniture หา id ที่ถูกต้องก่อน แล้วค่อยเรียก compareOptions อีกครั้ง',
    };
  }

  // The same measured space `checkFit` would use, so the verdicts in a
  // comparison and the verdict in a fit check can never disagree. The photo
  // wins, as it does in `checkFit`; failing that, the space a previous
  // `checkFit` was given — the size the user typed in the chat.
  const photo = await photoSpace(context, undefined);
  const space = photo ?? lastCheckedSpace(context?.history);
  const spaceSource = photo ? 'photo_scale' : space ? 'stated_cm' : null;

  const rows = products.map((product) => {
    const fit = space ? evaluateFit(product, space) : null;
    return {
      id: product.id,
      name_th: product.name_th,
      name_en: product.name_en,
      category: product.category,
      style_tags: product.style_tags,
      color: product.color,
      material: product.material,
      price_thb: product.price_thb,
      width_cm: product.width_cm,
      depth_cm: product.depth_cm,
      height_cm: product.height_cm,
      in_stock: product.in_stock,
      image_url: product.image_url,
      fit: fit ? fitToJson(fit) : null,
    };
  });

  const cheapest = products.reduce((a, b) => (a.price_thb <= b.price_thb ? a : b));

  // The one that fits best, when there is a space to judge them by.
  const bestFit = space
    ? products.reduce((best, product) => {
        const rank = VERDICT_RANK[evaluateFit(product, space).verdict] ?? 2;
        const bestRank = VERDICT_RANK[evaluateFit(best, space).verdict] ?? 2;
        if (rank < bestRank) return product;
        if (rank === bestRank && product.price_thb < best.price_thb) return product;
        return best;
      })
    : null;

  const notes: string[] = [
    `ราคาถูกสุดคือ ${cheapest.name_th} (${cheapest.price_thb.toLocaleString('th-TH')} บาท)`,
  ];
  if (space) {
    notes.push(
      `พื้นที่ที่วัดไว้ ${space.width_cm} × ${space.depth_cm} ซม. — ตัวที่วางได้ดีที่สุดคือ ${(bestFit ?? cheapest).name_th}`,
    );
  } else {
    notes.push('ยังไม่ทราบขนาดพื้นที่ จึงเปรียบเทียบได้แค่ราคาและขนาด');
  }
  for (const product of products.filter((p) => !p.in_stock)) {
    notes.push(`${product.name_th} หมดสต็อก`);
  }

  return {
    space: space ? spaceToJson(space) : null,
    space_source: spaceSource,
    products: rows,
    cheapest_id: cheapest.id,
    best_fit_id: bestFit?.id ?? null,
    missing_ids: missing,
    notes,
  };
}

// ---------------------------------------------------------------------------
// The comparison of the last compareOptions call
//
// The chat shows a table of the comparison, so the client needs the numbers
// themselves — the same way it needs the products of a search to draw the
// cards. The tool result is already in the history, so this reads it back
// rather than comparing the rows a second time.
// ---------------------------------------------------------------------------

/** One product as the comparison table shows it. */
export interface ComparisonProduct {
  id: string;
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
  in_stock: boolean;
  /** 'fits' | 'tight' | 'does_not_fit', or null when no space was measured. */
  verdict: string | null;
  /** The advice `checkFit` would give, in Thai, one line per problem. */
  reasons: string[];
}

export interface ComparisonView {
  products: ComparisonProduct[];
  space: { width_cm: number; depth_cm: number; height_cm: number | null } | null;
  cheapest_id: string | null;
  best_fit_id: string | null;
}

function asObject(value: Json | undefined): Record<string, Json> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, Json>;
}

function asStringList(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/** One product out of a comparison result, or null when it is unusable. */
function toComparisonProduct(value: Json): ComparisonProduct | null {
  const row = asObject(value);
  if (!row) return null;

  const id = asString(row.id);
  const nameTh = asString(row.name_th);
  const price = asNumber(row.price_thb);
  const width = asNumber(row.width_cm);
  const depth = asNumber(row.depth_cm);
  if (id === null || nameTh === null || price === null || width === null || depth === null) return null;

  const fit = asObject(row.fit);
  const verdict = fit ? asString(fit.verdict) : null;

  return {
    id,
    name_th: nameTh,
    name_en: asString(row.name_en) ?? nameTh,
    category: asString(row.category) ?? '',
    color: asString(row.color),
    material: asString(row.material),
    price_thb: price,
    width_cm: width,
    depth_cm: depth,
    height_cm: asNumber(row.height_cm) ?? 0,
    image_url: asString(row.image_url) ?? '',
    in_stock: row.in_stock === true,
    verdict,
    reasons: fit ? asStringList(fit.reasons) : [],
  };
}

/**
 * The comparison from the most recent `compareOptions` call in this turn.
 *
 * Backwards through the history, so a turn that compared twice shows the
 * second result — the one the reply is about.
 */
export function extractComparison(history: readonly LlmMessage[]): ComparisonView | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    for (let p = message.parts.length - 1; p >= 0; p -= 1) {
      const part = message.parts[p];
      if (part.kind !== 'toolResult' || part.name !== 'compareOptions') continue;

      const result = asObject(part.result);
      if (!result) continue;

      const rawProducts = Array.isArray(result.products) ? result.products : [];
      const products = rawProducts
        .map((product) => toComparisonProduct(product))
        .filter((product): product is ComparisonProduct => product !== null);
      if (products.length === 0) continue;

      const space = asObject(result.space);
      return {
        products,
        space: space
          ? {
              width_cm: asNumber(space.width_cm) ?? 0,
              depth_cm: asNumber(space.depth_cm) ?? 0,
              height_cm: asNumber(space.height_cm) ?? null,
            }
          : null,
        cheapest_id: asString(result.cheapest_id),
        best_fit_id: asString(result.best_fit_id),
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
export const TOOL_SPECS: readonly ToolSpec[] = [
  searchFurniture,
  analyzeRoom,
  checkFit,
  compareOptions,
  designRoom,
];

const EXECUTORS: Record<string, ToolExecutor> = {
  searchFurniture: executeSearchFurniture,
  analyzeRoom: executeAnalyzeRoom,
  checkFit: executeCheckFit,
  compareOptions: executeCompareOptions,
  designRoom: executeDesignRoom,
};

export function executeToolCall(call: ToolCall, context?: ToolContext): Promise<Json> {
  const executor = EXECUTORS[call.name];
  if (!executor) {
    // Unknown tool: tell the model plainly so it can retry with a real one.
    return Promise.resolve({
      error: 'unknown_tool',
      requested: call.name,
      available: Object.keys(EXECUTORS),
    });
  }
  return executor(call.args, context);
}