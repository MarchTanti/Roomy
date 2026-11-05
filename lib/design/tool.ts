/**
 * The `designRoom` tool — the room-styling half of the assistant.
 *
 * The model decides *what* the room should be: the style, the colours, what
 * it is for, which pieces it has to have. The code decides everything
 * numeric: the size of the floor, which catalogue row answers each request,
 * what it costs, and what the picture looks like.
 *
 * Two refusals are built in, and both of them are the user's requirement that
 * the assistant asks before it draws:
 *
 *   - `not_confirmed` — the model has to have agreed the plan with the user
 *     first. The tool will not draw a room nobody approved.
 *   - `incomplete_brief` — the style, the size of the room, or the pieces
 *     themselves are missing. The tool answers with what is missing so the
 *     model can ask the user about it, instead of guessing.
 *
 * Every failure is returned to the model as data. The model can read it and
 * ask the right question; it never sees an exception.
 */

import { z } from 'zod';

import type { Json, RoomBrief } from '../db/types';
import type { ToolContext } from '../llm/loop';
import type { ToolSpec } from '../llm/types';
import type { LlmMessage } from '../llm/types';
import { checkBrief, mergeBrief, resolveBrief, type ResolvedPiece } from './brief';
import { renderRoom } from './render';
import type { DesignPieceView, DesignView } from './view';

// ---------------------------------------------------------------------------
// The arguments
// ---------------------------------------------------------------------------

/**
 * One piece the room has to have.
 *
 * `requested_width` is the user's own words ("3.5 ฟุต"), not a number: the
 * code parses it, because converting units is arithmetic and the model does
 * not do arithmetic.
 */
const ItemArgs = z.object({
  category: z
    .string()
    .trim()
    .min(1)
    .describe('หมวดหมู่ในแคตตาล็อก เช่น bed, sofa, lamp, table, shelf, chair, rug, desk'),
  note: z
    .string()
    .trim()
    .max(200)
    .default('')
    .describe('คำขอของผู้ใช้เกี่ยวกับชิ้นนี้ เช่น "โคมไฟที่ปลอดภัยกับสัตว์เลี้ยง"'),
  requested_width: z
    .string()
    .trim()
    .max(60)
    .optional()
    .transform((value) => value ?? null)
    .describe('ขนาดที่ผู้ใช้ขอ ในคำพูดของผู้ใช้เอง เช่น "3.5 ฟุต" หรือ "120 ซม." (ห้ามแปลงหน่วยเอง)'),
  product_id: z
    .string()
    .trim()
    .min(1)
    .optional()
    .transform((value) => value ?? null)
    .describe('id ของสินค้าที่เลือกไว้แล้ว เมื่อปรับแต่งห้องเดิม'),
});

const DesignRoomArgs = z.object({
  style: z.string().trim().min(1).optional().describe('สไตล์ห้อง เช่น minimal, japandi, scandinavian'),
  theme: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('โทนสีของห้อง เช่น "สีชมพู-ขาวพาสเทล"'),
  purpose: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('ห้องนี้ใช้ทำอะไร เช่น "ห้องนอน" หรือ "ห้องทำงาน"'),
  room_size: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('ขนาดห้องในคำพูดของผู้ใช้ เช่น "24 ตารางเมตร" หรือ "4x5 เมตร" (ห้ามแปลงหน่วยเอง)'),
  budget_thb: z.number().nonnegative().optional().describe('งบประมาณรวมของห้อง เป็นบาท'),
  items: z.array(ItemArgs).min(1).max(8).optional().describe('ชิ้นสินค้าที่ห้องต้องมี'),
  instruction: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .optional()
    .describe('คำขอเปลี่ยนแปลงของผู้ใช้ เมื่อปรับแต่งห้องที่ทำไว้แล้ว'),
  confirmed: z
    .boolean()
    .describe('true เฉพาะเมื่อผู้ใช้ยืนยันแผนแล้วว่าให้วาดห้องนี้'),
});

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export const designRoom: ToolSpec = {
  name: 'designRoom',
  description:
    'ออกแบบห้องทั้งห้องตามคำขอของผู้ใช้ แล้ววาดภาพห้องที่มีเฟอร์นิเจอร์จริงจากแคตตาล็อก ' +
    'เรียกเมื่อผู้ใช้ขอ "แต่งห้อง" หรืออยากได้ห้องสไตล์หนึ่งๆ ' +
    'ต้องถามผู้ใช้เรื่องที่ยังไม่ชัดเจนก่อน และต้องได้รับการยืนยันจากผู้ใช้ก่อนเรียก ' +
    'ขนาดห้องและขนาดชิ้นสินค้าต้องส่งมาเป็นคำขอของผู้ใช้เอง เช่น "24 ตารางเมตร" หรือ "3.5 ฟุต" ' +
    'ห้ามแปลงหน่วยเอง เครื่องมืออ่านค่าจริงจากฐานข้อมูลและวาดให้',
  parameters: {
    type: 'object',
    properties: {
      style: { type: 'string', description: 'สไตล์ห้อง เช่น minimal, japandi, scandinavian' },
      theme: { type: 'string', description: 'โทนสีของห้อง เช่น "สีชมพู-ขาวพาสเทล"' },
      purpose: { type: 'string', description: 'ห้องนี้ใช้ทำอะไร เช่น "ห้องนอน"' },
      room_size: {
        type: 'string',
        description: 'ขนาดห้องในคำขอของผู้ใช้ เช่น "24 ตารางเมตร" หรือ "4x5 เมตร"',
      },
      budget_thb: { type: 'number', description: 'งบประมาณรวมของห้อง เป็นบาท' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            category: { type: 'string', description: 'หมวดหมู่ในแคตตาล็อก เช่น bed, lamp' },
            note: { type: 'string', description: 'คำขอของผู้ใช้เกี่ยวกับชิ้นนี้' },
            requested_width: {
              type: 'string',
              description: 'ขนาดที่ผู้ใช้ขอ ในคำขอของผู้ใช้เอง เช่น "3.5 ฟุต"',
            },
            product_id: {
              type: 'string',
              description: 'id ของสินค้าที่เลือกไว้แล้ว เมื่อปรับแต่งห้องเดิม',
            },
          },
          required: ['category'],
        },
        description: 'ชิ้นสินค้าที่ห้องต้องมี',
      },
      instruction: {
        type: 'string',
        description: 'คำขอเปลี่ยนแปลงของผู้ใช้ เมื่อปรับแต่งห้องที่ทำไว้แล้ว',
      },
      confirmed: {
        type: 'boolean',
        description: 'true เฉพาะเมื่อผู้ใช้ยืนยันแผนแล้วว่าให้วาดห้องนี้',
      },
    },
    required: ['confirmed'],
  },
};

export async function executeDesignRoom(args: Json, context?: ToolContext): Promise<Json> {
  const parsed = DesignRoomArgs.safeParse(args);
  if (!parsed.success) {
    return {
      error: 'invalid_arguments',
      issues: parsed.error.issues.map((i) => ({
        field: i.path.join('.'),
        problem: i.message,
      })),
    };
  }

  if (!context) {
    return {
      error: 'unavailable',
      reason: 'ไม่ทราบเซสชันของคำขอนี้',
      guidance: 'ถามผู้ใช้ว่าอยากให้แต่งห้องแบบไหน แล้วค่อยเรียกอีกครั้ง',
    };
  }

  // The user has to have agreed the plan first. Drawing a room nobody asked
  // for is worse than asking one more question.
  if (!parsed.data.confirmed) {
    return {
      error: 'not_confirmed',
      reason: 'ยังไม่ได้ยืนยันแผนกับผู้ใช้',
      guidance:
        'ให้สรุปแผนที่จะทำ (สไตล์ โทนสี ขนาดห้อง ชิ้นที่จะใส่ ราคารวม) แล้วถามผู้ใช้ว่าให้วาดเลยไหม ' +
        'ผู้ใช้ตอบว่าได้แล้วจึงเรียกอีกครั้งด้วย confirmed: true',
    };
  }

  const stored = context.session.state.design_brief;
  const brief = mergeBrief(stored, parsed.data);
  const check = checkBrief(brief);
  if (!check.ok) {
    return {
      error: 'incomplete_brief',
      missing: check.missing,
      suggestion: check.suggestion,
      guidance:
        'ถามผู้ใช้เรื่องที่ขาด 2-3 ข้อในข้อความเดียว (สไตล์ ขนาดห้อง ชิ้นที่ต้องมี) ' +
        'แล้วเรียกใหม่เมื่อได้ครบ',
    };
  }

  const { pieces, problems } = await resolveBrief(context.db, brief);
  if (problems.length > 0) {
    // A piece the user insisted on is missing from the catalogue. Drawing the
    // room without it would quietly drop something they asked for, so the
    // room waits until the user says what to do about it.
    return {
      error: 'no_catalogue_match',
      problems: problems.map((problem) => ({
        category: problem.category,
        note: problem.note,
        message: problem.message,
      })),
      guidance:
        'บอกผู้ใช้ว่าไม่มีชิ้นที่ขอในแคตตาล็อก แล้วถามว่าจะให้ตัดชิ้นนั้นออก หรือใช้ชิ้นอื่นแทน ' +
        '(เรียก searchFurniture เพื่อหาทางเลือก)',
    };
  }
  if (pieces.length === 0) {
    return {
      error: 'no_catalogue_match',
      problems: [],
      guidance: 'ยังไม่มีสินค้าที่ตรงกับคำขอเลย ให้ถามผู้ใช้ว่าอยากได้ชิ้นไหนบ้าง',
    };
  }

  // The chosen rows go back into the brief. A later version of this room then
  // keeps the same pieces: the user asked for a different colour, not for a
  // different bed.
  for (let i = 0; i < pieces.length; i += 1) {
    const item = brief.items[i];
    if (item) item.product_id = pieces[i].product_id;
  }

  const version = await nextVersionNumber(context);

  try {
    const drawn = await renderRoom({
      db: context.db,
      session: context.session,
      brief,
      pieces,
    });

    const view = buildView(brief, pieces, drawn, version);
    return { status: 'rendered', design: view as unknown as Json, brief: brief as unknown as Json };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'วาดห้องไม่สำเร็จ';
    return {
      error: 'render_failed',
      reason,
      guidance: 'บอกผู้ใช้ว่าวาดภาพห้องไม่สำเร็จ แล้วเสนอให้ลองอีกครั้ง',
    };
  }
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

/** The view the client renders, built from the rows and the brief. */
function buildView(
  brief: RoomBrief,
  pieces: ResolvedPiece[],
  drawn: {
    image_id: string;
    url: string | null;
    expires_at: string | null;
    image_quota_left: number;
  },
  version: number,
): DesignView {
  const total = pieces.reduce((sum, piece) => sum + piece.price_thb, 0);
  const notes: string[] = [];

  for (const piece of pieces) {
    if (piece.width_gap_cm !== null && piece.width_gap_cm > 1) {
      notes.push(
        `${piece.name_th} ที่มีในแคตตาล็อกกว้าง ${piece.width_cm} ซม. ` +
          `(ที่ขอไว้ ${piece.requested_width_cm} ซม. ต่างกัน ${piece.width_gap_cm} ซม.)`,
      );
    }
  }
  if (brief.budget_thb !== null && total > brief.budget_thb) {
    notes.push(
      `ราคารวม ${total.toLocaleString('th-TH')} บาท เกินงบ ${brief.budget_thb.toLocaleString('th-TH')} บาท`,
    );
  }

  const pieceViews: DesignPieceView[] = pieces.map((piece) => ({
    product_id: piece.product_id,
    name_th: piece.name_th,
    name_en: piece.name_en,
    category: piece.category,
    color: piece.color,
    material: piece.material,
    price_thb: piece.price_thb,
    width_cm: piece.width_cm,
    depth_cm: piece.depth_cm,
    height_cm: piece.height_cm,
    image_url: piece.image_url,
    note: piece.note,
    requested_width_cm: piece.requested_width_cm,
    width_gap_cm: piece.width_gap_cm,
  }));

  return {
    image_id: drawn.image_id,
    url: drawn.url,
    expires_at: drawn.expires_at,
    version,
    style: brief.style,
    theme: brief.theme,
    purpose: brief.purpose,
    room_size_m2: brief.room_size_m2,
    width_cm: brief.width_cm,
    depth_cm: brief.depth_cm,
    total_price_thb: total,
    pieces: pieceViews,
    instruction: brief.instruction,
    notes,
    image_quota_left: drawn.image_quota_left,
  };
}

/**
 * Which version of this room comes next.
 *
 * The chain is the design pictures of one session, in the order they were
 * made. A design picture is a generated image with no product: a placement
 * always points at the piece it placed, and a design is of a whole room.
 */
async function nextVersionNumber(context: ToolContext): Promise<number> {
  const images = await context.db.listImages(context.session.id);
  const designs = images.filter((image) => image.kind === 'generated' && image.product_id === null);
  return designs.length + 1;
}

// ---------------------------------------------------------------------------
// Reading the result back
// ---------------------------------------------------------------------------

export interface DesignResult {
  /** What the client renders. */
  view: DesignView;
  /** The brief as it was understood, for the session state. */
  brief: RoomBrief;
}

/**
 * The design of the most recent `designRoom` call in this turn.
 *
 * Read out of the transcript rather than kept in a global, the same way the
 * products of a search are read back: the result is already there.
 */
export function extractDesign(history: readonly LlmMessage[]): DesignResult | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    for (let p = message.parts.length - 1; p >= 0; p -= 1) {
      const part = message.parts[p];
      if (part.kind !== 'toolResult' || part.name !== 'designRoom') continue;

      const result = part.result;
      if (typeof result !== 'object' || result === null || Array.isArray(result)) continue;
      const row = result as Record<string, Json>;

      if (row.status !== 'rendered') continue;
      const design = row.design;
      const brief = row.brief;
      if (typeof design !== 'object' || design === null || Array.isArray(design)) continue;
      if (typeof brief !== 'object' || brief === null || Array.isArray(brief)) continue;

      return {
        view: design as unknown as DesignView,
        brief: brief as unknown as RoomBrief,
      };
    }
  }
  return null;
}
