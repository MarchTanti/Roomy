/**
 * `compareOptions` — the tool the model calls when the user asks "which one
 * is better?".
 *
 * The rule this file exists to protect is the same one `checkFit` follows:
 * every number in the answer comes from the database. The model sends ids and
 * nothing else, and what comes back is the rows it pointed at — with the fit
 * verdicts computed from the same measured space `checkFit` would use, so a
 * comparison and a fit check can never tell the user two different things.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ToolContext } from '@/lib/llm/loop';
import type { LlmMessage } from '@/lib/llm/types';
import { resetPhotoStore, setPhotoStoreForTesting, type PhotoStore } from '@/lib/storage';
import {
  emptySessionState,
  type Area,
  type DbClient,
  type Json,
  type Product,
  type ReferenceLine,
  type SessionState,
} from '@/lib/db/types';

// lib/db/local.ts snapshots ROOMY_DATA_DIR at import time, and a static import
// is hoisted above anything in this body. These files write real rows, so they
// need a data dir of their own before that happens.
const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'roomy-compare-'));
process.env.ROOMY_DATA_DIR = DATA_DIR;
delete process.env.DB_ADAPTER;

let getDb: () => DbClient;
let resetDb: () => void;
let executeToolCall: Awaited<typeof import('@/lib/llm/tools')>['executeToolCall'];
let extractComparison: Awaited<typeof import('@/lib/llm/tools')>['extractComparison'];

beforeAll(async () => {
  ({ getDb, resetDb } = await import('@/lib/db'));
  ({ executeToolCall, extractComparison } = await import('@/lib/llm/tools'));
});

const SESSION_ID = '77777777-7777-4777-8777-777777777777';
const IMAGE_ID = '88888888-8888-4888-8888-888888888888';

/** Cheap, and far too big for the measured space. */
const TABLE: Product = {
  id: 'table-big',
  source: 'manual',
  source_url: 'https://example.test/table',
  name_th: 'โต๊ะกินข้าวใหญ่',
  name_en: 'Big dining table',
  category: 'table',
  style_tags: ['loft'],
  color: 'สีไม้',
  material: 'ไม้',
  price_thb: 1900,
  width_cm: 200,
  depth_cm: 100,
  height_cm: 75,
  image_url: '/product-images/table.svg',
  in_stock: true,
};

/** Fits the measured space, and costs more than the table. */
const ARMCHAIR: Product = {
  id: 'armchair-1',
  source: 'manual',
  source_url: 'https://example.test/armchair',
  name_th: 'เก้าอี้โยก',
  name_en: 'Rocking armchair',
  category: 'armchair',
  style_tags: ['scandinavian'],
  color: 'สีเทา',
  material: 'ผ้า',
  price_thb: 6900,
  width_cm: 70,
  depth_cm: 70,
  height_cm: 85,
  image_url: '/product-images/armchair.svg',
  in_stock: true,
};

const SOFA: Product = {
  id: 'sofa-1',
  source: 'manual',
  source_url: 'https://example.test/sofa',
  name_th: 'โซฟา KIVIK',
  name_en: 'KIVIK sofa',
  category: 'sofa',
  style_tags: ['scandinavian'],
  color: 'สีเทา',
  material: 'ผ้า',
  price_thb: 24900,
  width_cm: 228,
  depth_cm: 95,
  height_cm: 83,
  image_url: '/product-images/sofa.svg',
  in_stock: false,
};

/** A quarter of the width of a 4:3 photo, declared as 60 cm wide. */
const LINE: ReferenceLine = { x1: 0.1, y1: 0.2, x2: 0.35, y2: 0.2 };
const REFERENCE_CM = 60;
/** Half of each axis: 120 cm across, 90 cm deep. */
const AREA: Area = { x: 0.1, y: 0.2, w: 0.5, h: 0.5 };

function jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 10, b: 10 } },
  })
    .jpeg()
    .toBuffer();
}

function storeReturning(bytes: Buffer): PhotoStore {
  return {
    id: 'local',
    async put() {
      throw new Error('put() is not used in these tests');
    },
    async get() {
      return bytes;
    },
    async remove() {},
  };
}

async function contextWith(state: Partial<SessionState>): Promise<ToolContext> {
  setPhotoStoreForTesting(storeReturning(await jpeg(1200, 900)));

  const image = await getDb().addImage({
    session_id: SESSION_ID,
    kind: 'room',
    storage_path: `${SESSION_ID}/${IMAGE_ID}.jpg`,
  });

  return {
    db: getDb(),
    session: {
      id: SESSION_ID,
      state: { ...emptySessionState(), room_image_id: image.id, ...state },
      image_quota_left: 10,
      created_at: '2026-01-01T00:00:00.000Z',
    },
  };
}

function measuredState(): Partial<SessionState> {
  return { reference_line: LINE, reference_cm: REFERENCE_CM, selected_area: AREA };
}

interface CompareResponse {
  error?: string;
  guidance?: string;
  notes?: string[];
  space?: { width_cm: number; depth_cm: number; height_cm: number | null } | null;
  products?: {
    id: string;
    name_th: string;
    price_thb: number;
    width_cm: number;
    depth_cm: number;
    height_cm: number;
    in_stock: boolean;
    fit: { verdict: string } | null;
  }[];
  cheapest_id?: string;
  best_fit_id?: string | null;
  missing_ids?: string[];
}

async function call(args: Json, context?: ToolContext): Promise<CompareResponse> {
  return (await executeToolCall({ id: null, name: 'compareOptions', args }, context)) as CompareResponse;
}

beforeEach(async () => {
  resetDb();
  resetPhotoStore();
  await getDb().upsertProducts([TABLE, ARMCHAIR, SOFA]);
});

afterEach(() => {
  setPhotoStoreForTesting(null);
});

// ---------------------------------------------------------------------------

describe('compareOptions — where the numbers come from', () => {
  it('reads the price and the size from the database, never from the call', async () => {
    const context = await contextWith({});

    const result = await call(
      {
        product_ids: [TABLE.id, ARMCHAIR.id],
        // A model that invents its own numbers must not change the answer.
        price_thb: 1,
        width_cm: 1,
        depth_cm: 1,
      },
      context,
    );

    const table = result.products?.find((p) => p.id === TABLE.id);
    expect(table?.price_thb).toBe(1900);
    expect(table?.width_cm).toBe(200);
    expect(table?.depth_cm).toBe(100);
  });

  it('returns one row per product asked for', async () => {
    const context = await contextWith({});

    const result = await call({ product_ids: [TABLE.id, ARMCHAIR.id, SOFA.id] }, context);

    expect(result.products).toHaveLength(3);
    expect(result.products?.map((p) => p.id).sort()).toEqual([ARMCHAIR.id, SOFA.id, TABLE.id]);
  });
});

describe('compareOptions — the answer', () => {
  it('names the cheapest', async () => {
    const context = await contextWith({});

    const result = await call({ product_ids: [SOFA.id, ARMCHAIR.id] }, context);

    expect(result.cheapest_id).toBe(ARMCHAIR.id);
    expect(result.notes?.join(' ')).toContain('ราคาถูกสุด');
  });

  it('names the one that fits best, when there is a space to judge them by', async () => {
    const context = await contextWith(measuredState());

    const result = await call({ product_ids: [TABLE.id, ARMCHAIR.id] }, context);

    // The table is 200 cm wide and the space is 120 cm; the armchair is 70.
    expect(result.best_fit_id).toBe(ARMCHAIR.id);
  });

  it('gives every product the same verdict a fit check would give it', async () => {
    const context = await contextWith(measuredState());

    const compared = await call({ product_ids: [TABLE.id, ARMCHAIR.id] }, context);
    const checked = (await executeToolCall(
      { id: null, name: 'checkFit', args: { product_id: ARMCHAIR.id } },
      context,
    )) as { fit?: { verdict: string } };

    const armchair = compared.products?.find((p) => p.id === ARMCHAIR.id);
    expect(armchair?.fit?.verdict).toBe(checked.fit?.verdict);
    expect(armchair?.fit?.verdict).toBe('fits');
  });

  it('says the space is unknown when nothing was measured', async () => {
    const context = await contextWith({});

    const result = await call({ product_ids: [TABLE.id, ARMCHAIR.id] }, context);

    expect(result.space).toBeNull();
    expect(result.products?.every((p) => p.fit === null)).toBe(true);
    expect(result.notes?.join(' ')).toContain('ยังไม่ทราบขนาดพื้นที่');
  });

  it('judges the products by the space a fit check was given', async () => {
    // The user typed the size in the chat, so there is no photo to measure —
    // but `checkFit` already judged against that size, and the comparison has
    // to agree with it. Without this, the comparison comes back with no
    // verdicts at all and the model fills the table in itself.
    const context = await contextWith({});
    context.history = [
      {
        role: 'user',
        parts: [
          {
            kind: 'toolResult',
            callId: '1',
            name: 'checkFit',
            result: { space: { width_cm: 240, depth_cm: 120, height_cm: 260 } },
          },
        ],
      },
    ];

    const result = await call({ product_ids: [TABLE.id, ARMCHAIR.id] }, context);

    expect(result.space).toEqual({ width_cm: 240, depth_cm: 120, height_cm: 260 });
    // Both fit a 240 × 120 room, and the cheaper one wins the tie.
    expect(result.products?.find((p) => p.id === ARMCHAIR.id)?.fit?.verdict).toBe('fits');
    expect(result.products?.find((p) => p.id === TABLE.id)?.fit?.verdict).toBe('fits');
    expect(result.best_fit_id).toBe(TABLE.id);
  });

  it('prefers the space measured on the photo over the one in the chat', async () => {
    const context = await contextWith(measuredState());
    context.history = [
      {
        role: 'user',
        parts: [
          {
            kind: 'toolResult',
            callId: '1',
            name: 'checkFit',
            result: { space: { width_cm: 500, depth_cm: 500, height_cm: null } },
          },
        ],
      },
    ];

    const result = await call({ product_ids: [TABLE.id, ARMCHAIR.id] }, context);

    // The photo says 120 × 90, so the table does not fit and the armchair does.
    expect(result.space?.width_cm).toBe(120);
    expect(result.products?.find((p) => p.id === TABLE.id)?.fit?.verdict).toBe('does_not_fit');
  });

  it('takes the newest space when the user corrected the size', async () => {
    const context = await contextWith({});
    context.history = [
      {
        role: 'user',
        parts: [
          {
            kind: 'toolResult',
            callId: '1',
            name: 'checkFit',
            result: { space: { width_cm: 500, depth_cm: 500, height_cm: null } },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            kind: 'toolResult',
            callId: '2',
            name: 'checkFit',
            result: { space: { width_cm: 240, depth_cm: 120, height_cm: 260 } },
          },
        ],
      },
    ];

    const result = await call({ product_ids: [TABLE.id, ARMCHAIR.id] }, context);

    expect(result.space?.width_cm).toBe(240);
  });

  it('says which one is out of stock', async () => {
    const context = await contextWith({});

    const result = await call({ product_ids: [SOFA.id, ARMCHAIR.id] }, context);

    expect(result.notes?.join(' ')).toContain('หมดสต็อก');
  });
});

describe('compareOptions — when it cannot answer', () => {
  it('needs at least two products', async () => {
    const context = await contextWith({});

    const result = await call({ product_ids: [TABLE.id] }, context);

    expect(result.error).toBe('invalid_arguments');
  });

  it('refuses to compare one product with nothing', async () => {
    const context = await contextWith({});

    const result = await call({ product_ids: [TABLE.id, 'no-such-product'] }, context);

    expect(result.error).toBe('not_enough_products');
    expect(result.missing_ids).toEqual(['no-such-product']);
  });

  it('compares the ones it found and reports the one it did not', async () => {
    const context = await contextWith({});

    const result = await call({ product_ids: [TABLE.id, ARMCHAIR.id, 'no-such-product'] }, context);

    expect(result.products).toHaveLength(2);
    expect(result.missing_ids).toEqual(['no-such-product']);
  });
});

describe('extractComparison — what the client is shown', () => {
  const toolResult = {
    space: { width_cm: 120, depth_cm: 90, height_cm: null },
    products: [
      {
        id: TABLE.id,
        name_th: TABLE.name_th,
        name_en: TABLE.name_en,
        category: 'table',
        color: 'สีไม้',
        material: 'ไม้',
        price_thb: 1900,
        width_cm: 200,
        depth_cm: 100,
        height_cm: 75,
        in_stock: true,
        image_url: '/product-images/table.svg',
        fit: { verdict: 'does_not_fit', rotation_deg: 0, reasons: ['ด้านกว้างเกินพื้นที่ 80 ซม.'] },
      },
      {
        id: ARMCHAIR.id,
        name_th: ARMCHAIR.name_th,
        name_en: ARMCHAIR.name_en,
        category: 'armchair',
        color: 'สีเทา',
        material: 'ผ้า',
        price_thb: 6900,
        width_cm: 70,
        depth_cm: 70,
        height_cm: 85,
        in_stock: true,
        image_url: '/product-images/armchair.svg',
        fit: { verdict: 'fits', rotation_deg: 0, reasons: ['พื้นที่วางได้'] },
      },
    ],
    cheapest_id: TABLE.id,
    best_fit_id: ARMCHAIR.id,
    notes: [],
  };

  const history: LlmMessage[] = [
    { role: 'user', parts: [{ kind: 'text', text: 'เทียบโต๊ะกับเก้าอี้' }] },
    {
      role: 'model',
      parts: [{ kind: 'toolCall', call: { id: '1', name: 'compareOptions', args: {} } }],
    },
    {
      role: 'user',
      parts: [{ kind: 'toolResult', callId: '1', name: 'compareOptions', result: toolResult }],
    },
  ];

  it('reads the comparison back out of the history', () => {
    const comparison = extractComparison(history);

    expect(comparison?.products).toHaveLength(2);
    expect(comparison?.cheapest_id).toBe(TABLE.id);
    expect(comparison?.best_fit_id).toBe(ARMCHAIR.id);
    expect(comparison?.space?.width_cm).toBe(120);
    expect(comparison?.products[1].verdict).toBe('fits');
  });

  it('has nothing to show when the model did not compare anything', () => {
    const comparison = extractComparison([{ role: 'user', parts: [{ kind: 'text', text: 'สวัสดี' }] }]);

    expect(comparison).toBeNull();
  });

  it('survives a tool result that is not a comparison at all', () => {
    const broken: LlmMessage[] = [
      {
        role: 'user',
        parts: [{ kind: 'toolResult', callId: '1', name: 'compareOptions', result: { error: 'boom' } }],
      },
    ];

    expect(extractComparison(broken)).toBeNull();
  });
});
