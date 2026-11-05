/**
 * `checkFit` — the tool the model calls when a user asks "will it fit?".
 *
 * The spec's rule for this project is that prices and dimensions come from the
 * database and never from model text. That makes these tests less about
 * arithmetic — `tests/fit/fit.test.ts` covers that — and more about where each
 * number in the answer is allowed to come from.
 *
 * The real local adapter and a real JPEG are used, so the photo path runs end
 * to end; only the photo *bytes* are stubbed, because there is no store on disk
 * in a unit test.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ToolContext } from '@/lib/llm/loop';
import { resetPhotoStore, setPhotoStoreForTesting, type PhotoStore } from '@/lib/storage';
import {
  emptySessionState,
  type Area,
  type DbClient,
  type Json,
  type Product,
  type ReferenceLine,
  type Session,
  type SessionState,
} from '@/lib/db/types';

// lib/db/local.ts snapshots ROOMY_DATA_DIR into a module-level const at import
// time, and a static import is hoisted above anything in this body. These files
// write real rows, so they need a data dir of their own before that happens.
const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'roomy-fit-'));
process.env.ROOMY_DATA_DIR = DATA_DIR;
delete process.env.DB_ADAPTER;

let getDb: () => DbClient;
let resetDb: () => void;
let executeToolCall: Awaited<typeof import('@/lib/llm/tools')>['executeToolCall'];

beforeAll(async () => {
  ({ getDb, resetDb } = await import('@/lib/db'));
  ({ executeToolCall } = await import('@/lib/llm/tools'));
});

const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const IMAGE_ID = '66666666-6666-4666-8666-666666666666';

const SOFA: Product = {
  id: 'test-sofa',
  source: 'manual',
  source_url: 'https://example.test/sofa',
  name_th: 'โซฟาทดสอบ',
  name_en: 'Test sofa',
  category: 'sofa',
  style_tags: ['modern'],
  color: 'gray',
  material: 'ผ้า',
  price_thb: 12000,
  width_cm: 200,
  depth_cm: 90,
  height_cm: 80,
  image_url: '/product-images/test.svg',
  in_stock: true,
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

function storeReturning(bytes: Buffer | Error): PhotoStore {
  return {
    id: 'local',
    async put() {
      throw new Error('put() is not used in these tests');
    },
    async get() {
      if (bytes instanceof Error) throw bytes;
      return bytes;
    },
    async remove() {},
  };
}

/**
 * A session with one room photo recorded, via the real local adapter, and a
 * stubbed store standing in for its bytes.
 *
 * `state` is spread last so a test can clear `room_image_id` to ask what
 * happens with no photo to measure against.
 */
async function contextWith(state: Partial<SessionState>, bytes?: Buffer | Error): Promise<ToolContext> {
  setPhotoStoreForTesting(storeReturning(bytes ?? (await jpeg(1200, 900))));

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

/** The state the picker writes when the user measures a space on the photo. */
function measuredState(): Partial<SessionState> {
  return { reference_line: LINE, reference_cm: REFERENCE_CM, selected_area: AREA };
}

// --- response shapes --------------------------------------------------------

interface FitResponse {
  error?: string;
  guidance?: string;
  notes?: string[];
  space?: { width_cm: number; depth_cm: number; height_cm: number | null };
  space_source?: 'photo_scale' | 'stated_cm';
  product?: { id: string; width_cm: number; depth_cm: number; height_cm: number };
  fit?: {
    verdict: string;
    rotation_deg: number;
    limiting: string;
    width: { clearance_cm: number };
    depth: { clearance_cm: number };
    height: { clearance_cm: number } | null;
    reasons: string[];
  };
}

async function call(args: Json, context?: ToolContext): Promise<FitResponse> {
  return (await executeToolCall({ id: null, name: 'checkFit', args }, context)) as FitResponse;
}

beforeEach(async () => {
  resetDb();
  resetPhotoStore();
  await getDb().upsertProducts([SOFA]);
});

afterEach(() => {
  setPhotoStoreForTesting(null);
});

// ---------------------------------------------------------------------------

describe('checkFit — where the numbers come from', () => {
  it('reads the product size from the database, never from the call', async () => {
    const context = await contextWith(measuredState());

    const result = await call(
      // A model that invents its own dimensions must not change the answer.
      { product_id: SOFA.id, width_cm: 5, depth_cm: 5, height_cm: 5 },
      context,
    );

    expect(result.product).toMatchObject({ width_cm: 200, depth_cm: 90, height_cm: 80 });
    // 120 cm of measured width against the catalogued 200 cm.
    expect(result.fit?.width.clearance_cm).toBeCloseTo(-80, 1);
  });

  it('measures the space off the photo when the session has a scale', async () => {
    const context = await contextWith(measuredState());

    const result = await call({ product_id: SOFA.id }, context);

    expect(result.space_source).toBe('photo_scale');
    // The line is a quarter of a 4:3 photo's width and is 60 cm, so one photo
    // width is 240 cm; half of that is 120, and half of a 4:3 height is 90.
    expect(result.space?.width_cm).toBeCloseTo(120, 1);
    expect(result.space?.depth_cm).toBeCloseTo(90, 1);
  });

  it('prefers the photo over centimetres the model typed', async () => {
    const context = await contextWith(measuredState());

    const result = await call(
      { product_id: SOFA.id, area_width_cm: 5000, area_depth_cm: 5000 },
      context,
    );

    // The photo is the user's own measurement of this room; a number that
    // arrived through the model is only a guess about it.
    expect(result.space_source).toBe('photo_scale');
    expect(result.space?.width_cm).toBeCloseTo(120, 1);
    expect(result.notes?.join(' ')).toContain('photo');
  });

  it('uses stated centimetres when there is no photo scale', async () => {
    const context = await contextWith({});

    const result = await call(
      { product_id: SOFA.id, area_width_cm: 250, area_depth_cm: 150, area_height_cm: 240 },
      context,
    );

    expect(result.space_source).toBe('stated_cm');
    expect(result.space).toEqual({ width_cm: 250, depth_cm: 150, height_cm: 240 });
    expect(result.fit?.height?.clearance_cm).toBeCloseTo(160, 1);
  });

  it('ignores half a stated space rather than guessing the other half', async () => {
    const context = await contextWith({});

    const result = await call({ product_id: SOFA.id, area_width_cm: 250 }, context);

    expect(result.error).toBe('no_space_data');
  });

  it('uses the stated height as the ceiling', async () => {
    const context = await contextWith({});

    const result = await call(
      { product_id: SOFA.id, area_width_cm: 250, area_depth_cm: 150, area_height_cm: 70 },
      context,
    );

    expect(result.fit?.verdict).toBe('does_not_fit');
    expect(result.fit?.limiting).toBe('height');
  });
});

describe('checkFit — when it cannot answer', () => {
  it('tells the model what to ask for when there is no space at all', async () => {
    const context = await contextWith({});
    const result = await call({ product_id: SOFA.id }, context);

    expect(result.error).toBe('no_space_data');
    expect(result.guidance).toContain('เส้นอ้างอิง');
  });

  it('reports an unknown product instead of checking nothing', async () => {
    const context = await contextWith(measuredState());
    const result = await call({ product_id: 'no-such-product' }, context);

    expect(result.error).toBe('product_not_found');
  });

  it('validates the arguments before touching anything', async () => {
    const result = await call({ area_width_cm: 100 });

    expect(result.error).toBe('invalid_arguments');
  });

  it('still answers from stated centimetres when the photo cannot be read', async () => {
    const context = await contextWith(measuredState(), new Error('missing file'));

    const result = await call({ product_id: SOFA.id, area_width_cm: 250, area_depth_cm: 150 }, context);

    // Losing the photo must not lose the answer.
    expect(result.space_source).toBe('stated_cm');
    expect(result.notes?.join(' ')).toContain('fallback');
  });

  it('says nothing rather than inventing a scale from a line of no length', async () => {
    const context = await contextWith({
      reference_line: { x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5 },
      reference_cm: REFERENCE_CM,
      selected_area: AREA,
    });

    const result = await call({ product_id: SOFA.id }, context);

    expect(result.error).toBe('no_space_data');
  });

  it('falls back to stated centimetres when there is no room photo to scale', async () => {
    const context = await contextWith({ ...measuredState(), room_image_id: null });

    const result = await call({ product_id: SOFA.id, area_width_cm: 250, area_depth_cm: 150 }, context);

    expect(result.space_source).toBe('stated_cm');
  });
});

describe('checkFit — the answer', () => {
  it('carries the verdict and the limiting axis back to the model', async () => {
    // The measured space is 120 x 90 and the sofa is 200 x 90: too wide as
    // catalogued, and turning it needs 200 cm of depth where there are 90.
    const context = await contextWith(measuredState());

    const result = await call({ product_id: SOFA.id }, context);

    expect(result.fit?.verdict).toBe('does_not_fit');
    expect(result.fit?.limiting).toBe('width');
    expect(result.fit?.reasons.length).toBeGreaterThan(0);
  });

  it('explains a rotation when turning the piece is what makes it fit', async () => {
    const context = await contextWith({});

    const result = await call({ product_id: SOFA.id, area_width_cm: 120, area_depth_cm: 240 }, context);

    // 90 x 200 turned fits 120 x 240; 200 x 90 as catalogued does not.
    expect(result.fit?.verdict).toBe('fits');
    expect(result.fit?.rotation_deg).toBe(90);
    expect(result.fit?.reasons.join(' ')).toContain('90');
  });

  it('says the ceiling is unknown when nobody measured it', async () => {
    const context = await contextWith(measuredState());
    const result = await call({ product_id: SOFA.id }, context);

    expect(result.fit?.height).toBeNull();
    expect(result.fit?.reasons.join(' ')).toContain('เพดาน');
  });
});