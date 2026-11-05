/**
 * `designRoom` — the tool that draws a whole room.
 *
 * The point of these tests is the user's requirement: the assistant asks
 * before it draws. So the first half of them is about the refusals — a room
 * is not drawn until the user has confirmed the plan, and nothing is drawn
 * from a brief that is missing its essentials.
 *
 * The second half is about where the numbers come from. The size of the room
 * and the size of each piece are read from the user's own words by the code,
 * and the prices come from the catalogue rows. The model contributes taste
 * and intent; it never contributes arithmetic.
 *
 * The database is the real local adapter and the image provider is a stub, so
 * the quota, the job rows and the image records are the real thing.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DbClient, Json, Product, Session } from '@/lib/db/types';
import type { ImageProvider, ImageRequest } from '@/lib/image';
import type { ToolContext } from '@/lib/llm/loop';

// lib/db/local.ts snapshots ROOMY_DATA_DIR into a module-level const at import
// time, and a static import is hoisted above anything in this body. These files
// write real rows, so they need a data dir of their own before that happens.
const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'roomy-design-'));
process.env.ROOMY_DATA_DIR = DATA_DIR;
delete process.env.DB_ADAPTER;
delete process.env.GEMINI_API_KEY;

let getDb: () => DbClient;
let resetDb: () => void;
let setImageProviderForTesting: (provider: ImageProvider | null) => void;
let executeToolCall: Awaited<typeof import('@/lib/llm/tools')>['executeToolCall'];

beforeAll(async () => {
  ({ getDb, resetDb } = await import('@/lib/db'));
  ({ setImageProviderForTesting } = await import('@/lib/image'));
  ({ executeToolCall } = await import('@/lib/llm/tools'));
});

const BED: Product = {
  id: 'bed-near',
  source: 'manual',
  source_url: 'https://example.test/bed-near',
  name_th: 'เตียง 106 ซม.',
  name_en: 'Bed 106',
  category: 'bed',
  style_tags: ['minimal'],
  color: 'สีขาว',
  material: 'ไม้',
  price_thb: 15000,
  width_cm: 106,
  depth_cm: 200,
  height_cm: 40,
  image_url: '/product-images/bed-near.svg',
  in_stock: true,
};

const LAMP: Product = {
  id: 'lamp-pastel',
  source: 'manual',
  source_url: 'https://example.test/lamp-pastel',
  name_th: 'โคมไฟพาสเทล',
  name_en: 'Pastel lamp',
  category: 'lamp',
  style_tags: ['minimal', 'pastel'],
  color: 'สีขาว',
  material: 'เซรามิก',
  price_thb: 2500,
  width_cm: 30,
  depth_cm: 30,
  height_cm: 150,
  image_url: '/product-images/lamp-pastel.svg',
  in_stock: true,
};

/** The picture the stub provider "returns". */
async function generatedImage(): Promise<Buffer> {
  return sharp({
    create: { width: 512, height: 384, channels: 3, background: { r: 120, g: 110, b: 100 } },
  })
    .png()
    .toBuffer();
}

/** A provider that records what it was asked and returns a fixed picture. */
function stubProvider(picture: Buffer, fail?: Error): {
  provider: ImageProvider;
  requests: ImageRequest[];
} {
  const requests: ImageRequest[] = [];
  const provider: ImageProvider = {
    id: 'stub',
    async render(request) {
      requests.push(request);
      if (fail) throw fail;
      return { bytes: picture, contentType: 'image/png', width: 512, height: 384 };
    },
  };
  return { provider, requests };
}

/** The room the user described, in the words the user used. */
const REQUEST: {
  style: string;
  theme: string;
  purpose: string;
  room_size: string;
  items: { category: string; note: string; requested_width: string }[];
  confirmed: boolean;
} = {
  style: 'มินิมอล',
  theme: 'สีชมพู-ขาวพาสเทล',
  purpose: 'ห้องนอน',
  room_size: '24 ตารางเมตร',
  items: [
    { category: 'bed', note: 'เตียง 3.5 ฟุต', requested_width: '3.5 ฟุต' },
    { category: 'lamp', note: 'โคมไฟที่ปลอดภัยกับสัตว์เลี้ยง', requested_width: '' },
  ],
  confirmed: true,
};

interface DesignResponse {
  status?: string;
  error?: string;
  missing?: string[];
  problems?: { category: string; message: string }[];
  reason?: string;
  guidance?: string;
  design?: {
    image_id: string;
    version: number;
    style: string;
    room_size_m2: number | null;
    width_cm: number | null;
    depth_cm: number | null;
    total_price_thb: number;
    image_quota_left: number;
    notes: string[];
    pieces: { product_id: string; name_th: string; price_thb: number; width_cm: number }[];
  };
  brief?: { items: { category: string; product_id: string | null }[] };
}

async function call(args: Json, context: ToolContext): Promise<DesignResponse> {
  return (await executeToolCall({ id: null, name: 'designRoom', args }, context)) as DesignResponse;
}

/** A session with the products the room is made of. */
async function contextWith(
  state: Record<string, unknown> = {},
  session?: Session,
): Promise<ToolContext> {
  const db = getDb();
  await db.upsertProducts([BED, LAMP]);
  const active = session ?? (await db.createSession());
  return {
    db,
    session: { ...active, state: { ...active.state, ...state } },
  };
}

beforeEach(() => {
  resetDb();
  setImageProviderForTesting(null);
});

afterEach(() => {
  setImageProviderForTesting(null);
});

// ---------------------------------------------------------------------------
// The assistant asks before it draws
// ---------------------------------------------------------------------------

describe('designRoom — it does not draw before the user says so', () => {
  it('refuses a plan the user has not confirmed', async () => {
    const context = await contextWith();
    const stub = stubProvider(await generatedImage());
    setImageProviderForTesting(stub.provider);

    const result = await call({ ...REQUEST, confirmed: false }, context);

    expect(result.error).toBe('not_confirmed');
    // Nothing was drawn, and no unit of quota was spent.
    expect(stub.requests).toHaveLength(0);
    expect((await getDb().getSession(context.session.id))!.image_quota_left).toBe(10);
  });

  it('says what to ask the user before trying again', async () => {
    const context = await contextWith();

    const result = await call({ ...REQUEST, confirmed: false }, context);

    expect(result.guidance).toContain('สรุปแผน');
  });

  it('asks for the style when the brief has none', async () => {
    const context = await contextWith();
    const stub = stubProvider(await generatedImage());
    setImageProviderForTesting(stub.provider);

    const { style: _style, ...withoutStyle } = REQUEST;
    const result = await call(withoutStyle, context);

    expect(result.error).toBe('incomplete_brief');
    expect(result.missing).toContain('สไตล์ที่ต้องการ');
    expect(stub.requests).toHaveLength(0);
  });

  it('asks for the size of the room when the brief has none', async () => {
    const context = await contextWith();

    const { room_size: _roomSize, ...withoutSize } = REQUEST;
    const result = await call(withoutSize, context);

    expect(result.error).toBe('incomplete_brief');
    expect(result.missing).toContain('ขนาดของห้อง');
  });

  it('asks for the pieces when the brief has none', async () => {
    const context = await contextWith();

    const { items: _items, ...withoutItems } = REQUEST;
    const result = await call(withoutItems, context);

    expect(result.error).toBe('incomplete_brief');
    expect(result.missing).toContain('ชิ้นสินค้าที่ต้องมีในห้อง');
  });

  it('says when the catalogue has nothing the user asked for', async () => {
    const context = await contextWith();

    const result = await call(
      { ...REQUEST, items: [{ category: 'table', note: 'โต๊ะกลาง' }] },
      context,
    );

    expect(result.error).toBe('no_catalogue_match');
    expect(result.problems?.[0].category).toBe('table');
    expect(result.problems?.[0].message).toContain('ไม่มี');
  });

  it('refuses the call when the arguments make no sense', async () => {
    const context = await contextWith();

    const result = await call({ confirmed: true, items: 'not an array' }, context);

    expect(result.error).toBe('invalid_arguments');
  });
});

// ---------------------------------------------------------------------------
// The room it draws
// ---------------------------------------------------------------------------

describe('designRoom — the room it draws', () => {
  it('returns the picture and what the room is made of', async () => {
    const context = await contextWith();
    const stub = stubProvider(await generatedImage());
    setImageProviderForTesting(stub.provider);

    const result = await call(REQUEST, context);

    expect(result.status).toBe('rendered');
    expect(result.design?.image_id).toBeTruthy();
    expect(result.design?.pieces).toHaveLength(2);
    expect(result.design?.pieces[0].product_id).toBe(BED.id);
    expect(result.design?.version).toBe(1);
  });

  it('takes the price and the size from the catalogue rows', async () => {
    const context = await contextWith();
    setImageProviderForTesting(stubProvider(await generatedImage()).provider);

    const result = await call(REQUEST, context);

    // 15000 for the bed and 2500 for the lamp, straight from the rows.
    expect(result.design?.total_price_thb).toBe(BED.price_thb + LAMP.price_thb);
    expect(result.design?.pieces[0].price_thb).toBe(BED.price_thb);
    expect(result.design?.pieces[0].width_cm).toBe(BED.width_cm);
  });

  it('takes the size of the room from the user’s own words', async () => {
    const context = await contextWith();
    setImageProviderForTesting(stubProvider(await generatedImage()).provider);

    const result = await call(REQUEST, context);

    // "24 ตารางเมตร" becomes 600 by 400, by the code and not by the model.
    expect(result.design?.room_size_m2).toBe(24);
    expect(result.design?.width_cm).toBe(600);
    expect(result.design?.depth_cm).toBe(400);
  });

  it('tells the model the real size of the room in the prompt', async () => {
    const context = await contextWith();
    const stub = stubProvider(await generatedImage());
    setImageProviderForTesting(stub.provider);

    await call(REQUEST, context);

    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].prompt).toContain('600 cm wide x 400 cm deep');
    expect(stub.requests[0].prompt).toContain('โคมไฟที่ปลอดภัยกับสัตว์เลี้ยง');
  });

  it('spends one unit of quota and records the picture', async () => {
    const context = await contextWith();
    setImageProviderForTesting(stubProvider(await generatedImage()).provider);

    const result = await call(REQUEST, context);

    expect(result.design?.image_quota_left).toBe(9);
    const images = await getDb().listImages(context.session.id);
    const generated = images.filter((image) => image.kind === 'generated');
    expect(generated).toHaveLength(1);
    // A design is of a whole room, so the picture points at no piece.
    expect(generated[0].product_id).toBeNull();
  });

  it('records a job that points at no piece', async () => {
    const context = await contextWith();
    setImageProviderForTesting(stubProvider(await generatedImage()).provider);

    await call(REQUEST, context);

    // The picture is of a whole room, so there is no single piece for the job
    // to point at. The column allows null; this is what puts that to use.
    const jobs = JSON.parse(
      await fs.readFile(path.join(DATA_DIR, 'generation_jobs.json'), 'utf8'),
    ) as {
      session_id: string;
      status: string;
      product_id: string | null;
      result_image_id: string | null;
    }[];

    const mine = jobs.filter((job) => job.session_id === context.session.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe('done');
    expect(mine[0].product_id).toBeNull();
    expect(mine[0].result_image_id).toBeTruthy();
  });

  it('tells the model when the drawing failed', async () => {
    const context = await contextWith();
    setImageProviderForTesting(stubProvider(await generatedImage(), new Error('no picture')).provider);

    const result = await call(REQUEST, context);

    expect(result.error).toBe('render_failed');
    expect(result.reason).toContain('no picture');
  });
});

// ---------------------------------------------------------------------------
// Another version of the same room
// ---------------------------------------------------------------------------

describe('designRoom — another version of the same room', () => {
  it('keeps the pieces of the room that was already drawn', async () => {
    const context = await contextWith();
    setImageProviderForTesting(stubProvider(await generatedImage()).provider);

    const first = await call(REQUEST, context);

    // The chat route stores the brief, and the next turn is a change.
    const context2 = await contextWith({ design_brief: first.brief }, context.session);
    const second = await call({ instruction: 'เปลี่ยนเป็นสีฟ้า', confirmed: true }, context2);

    expect(second.status).toBe('rendered');
    expect(second.design?.pieces.map((piece) => piece.product_id)).toEqual(
      first.design?.pieces.map((piece) => piece.product_id),
    );
  });

  it('numbers the versions of one room', async () => {
    const context = await contextWith();
    setImageProviderForTesting(stubProvider(await generatedImage()).provider);

    const first = await call(REQUEST, context);
    const context2 = await contextWith({ design_brief: first.brief }, context.session);
    const second = await call({ instruction: 'เปลี่ยนเป็นสีฟ้า', confirmed: true }, context2);

    expect(first.design?.version).toBe(1);
    expect(second.design?.version).toBe(2);
  });

  it('puts the change into the prompt of the new version', async () => {
    const context = await contextWith();
    const stub = stubProvider(await generatedImage());
    setImageProviderForTesting(stub.provider);

    const first = await call(REQUEST, context);
    const context2 = await contextWith({ design_brief: first.brief }, context.session);
    await call({ instruction: 'เปลี่ยนเป็นสีฟ้า', confirmed: true }, context2);

    expect(stub.requests).toHaveLength(2);
    expect(stub.requests[1].prompt).toContain('เปลี่ยนเป็นสีฟ้า');
  });

  it('keeps the size of the room the user gave', async () => {
    const context = await contextWith();
    setImageProviderForTesting(stubProvider(await generatedImage()).provider);

    const first = await call(REQUEST, context);
    const context2 = await contextWith({ design_brief: first.brief }, context.session);
    const second = await call({ instruction: 'เปลี่ยนเป็นสีฟ้า', confirmed: true }, context2);

    expect(second.design?.room_size_m2).toBe(24);
    expect(second.design?.width_cm).toBe(600);
  });
});
