/**
 * `POST /api/generate` — the route that turns a product and a room photo into
 * a picture.
 *
 * The provider and the photo store are the only two things stubbed. The
 * database, the quota, the job rows and the scale are all the real
 * implementations, because those are the parts that can be wrong in ways the
 * response alone would not show.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DbClient, Product, SessionState } from '@/lib/db/types';
import type { PhotoStore } from '@/lib/storage';
import type { ImageProvider, ImageRequest } from '@/lib/image';

// lib/db/local.ts snapshots ROOMY_DATA_DIR into a module-level const at import
// time, and a static import is hoisted above anything in this body. So the
// assignment and every import that reaches the DB have to happen dynamically,
// in this order.
const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'roomy-generate-'));
process.env.ROOMY_DATA_DIR = DATA_DIR;
delete process.env.DB_ADAPTER;
delete process.env.GEMINI_API_KEY;

type RouteHandler = (request: Request) => Promise<Response>;

let POST: RouteHandler;
let getDb: () => DbClient;
let resetDb: () => void;
let setPhotoStoreForTesting: (store: PhotoStore | null) => void;
let setImageProviderForTesting: (provider: ImageProvider | null) => void;

beforeAll(async () => {
  ({ POST } = await import('@/app/api/generate/route'));
  ({ getDb, resetDb } = await import('@/lib/db'));
  ({ setPhotoStoreForTesting } = await import('@/lib/storage'));
  ({ setImageProviderForTesting } = await import('@/lib/image'));
});

const SOFA: Product = {
  id: 'sofa-1',
  source: 'ikea',
  source_url: 'https://example.test/sofa-1',
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
  image_url: '/product-images/sofa-1.svg',
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

/** The room photo the stub store hands back. */
async function roomImage(): Promise<Buffer> {
  return sharp({
    create: { width: 1200, height: 900, channels: 3, background: { r: 40, g: 45, b: 55 } },
  })
    .jpeg()
    .toBuffer();
}

interface Stub {
  provider: ImageProvider;
  requests: ImageRequest[];
  stored: Buffer[];
}

/** A provider that records what it was asked and returns a fixed picture. */
function stubProvider(picture: Buffer, fail?: Error): Stub {
  const requests: ImageRequest[] = [];
  const provider: ImageProvider = {
    id: 'stub',
    async render(request) {
      requests.push(request);
      if (fail) throw fail;
      return { bytes: picture, contentType: 'image/png', width: 512, height: 384 };
    },
  };
  return { provider, requests, stored: [] };
}

/** A store that returns the room photo and records what was written. */
function stubStore(room: Buffer, stored: Buffer[]): PhotoStore {
  return {
    id: 'local',
    async put(sessionId, buffer) {
      stored.push(buffer);
      return {
        path: `${sessionId}/generated.jpg`,
        imageId: 'generated',
        bytes: buffer.length,
        width: 512,
        height: 384,
        contentType: 'image/jpeg',
        buffer,
      };
    },
    async get() {
      return room;
    },
    async remove() {},
  };
}

/** A session with a room photo, a product, and optionally a measurement. */
async function seed(state: Partial<SessionState> = {}): Promise<string> {
  const db = getDb();
  await db.upsertProducts([SOFA]);
  const session = await db.createSession();
  const image = await db.addImage({
    session_id: session.id,
    kind: 'room',
    storage_path: `${session.id}/room.jpg`,
  });
  await db.updateSessionState(session.id, { ...session.state, room_image_id: image.id, ...state });
  return session.id;
}

/** The request the user wrote — every placement is made for one. */
const REQUEST = 'อยากได้โซฟาสีเทาตรงหน้าต่าง';

function request(sessionId: string, productId: string): Request {
  return new Request('http://localhost/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      product_id: productId,
      placement: REQUEST,
    }),
  });
}

/** A request that may carry a change request — an iteration. */
function iterationRequest(
  sessionId: string,
  productId: string,
  body: { instruction?: string; previous_instructions?: string[] },
): Request {
  return new Request('http://localhost/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, product_id: productId, ...body }),
  });
}

beforeEach(() => {
  resetDb();
  setPhotoStoreForTesting(null);
  setImageProviderForTesting(null);
});

afterEach(() => {
  setPhotoStoreForTesting(null);
  setImageProviderForTesting(null);
});

// ---------------------------------------------------------------------------

describe('POST /api/generate — the refusals', () => {
  it('rejects a malformed body', async () => {
    const res = await POST(
      new Request('http://localhost/api/generate', { method: 'POST', body: '{not json' }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects an unknown session', async () => {
    const res = await POST(request('00000000-0000-4000-8000-000000000000', SOFA.id));
    expect(res.status).toBe(404);
  });

  it('rejects an unknown product', async () => {
    const sessionId = await seed();
    const res = await POST(request(sessionId, 'no-such-product'));
    expect(res.status).toBe(404);
  });

  it('refuses to work without a room photo', async () => {
    const db = getDb();
    await db.upsertProducts([SOFA]);
    const session = await db.createSession();

    const res = await POST(request(session.id, SOFA.id));

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('no_room_photo');
  });

  it('refuses when the session has spent its image quota', async () => {
    const sessionId = await seed();
    // The room photo is read before the quota is checked, so that a request
    // which cannot generate anything never spends a unit.
    setPhotoStoreForTesting(stubStore(await roomImage(), []));
    setImageProviderForTesting(stubProvider(await generatedImage()).provider);
    const db = getDb();
    // Ten units is the whole budget.
    for (let i = 0; i < 10; i += 1) await db.consumeImageQuota(sessionId);

    const res = await POST(request(sessionId, SOFA.id));

    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe('image_quota_exhausted');
  });

  it('does not spend a unit on a request it cannot fulfil', async () => {
    const db = getDb();
    await db.upsertProducts([SOFA]);
    const session = await db.createSession();

    const res = await POST(request(session.id, SOFA.id));

    expect(res.status).toBe(409);
    // The quota only moves when a picture is actually on its way.
    expect((await db.getSession(session.id))!.image_quota_left).toBe(10);
  });

  it('says so when the server has no image provider configured', async () => {
    const sessionId = await seed();
    setPhotoStoreForTesting(stubStore(await roomImage(), []));
    // No key, no stub: the real lookup fails.
    setImageProviderForTesting(null);

    const res = await POST(request(sessionId, SOFA.id));

    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('server_not_configured');
    // A misconfigured server must not cost the user a unit of quota.
    expect((await getDb().getSession(sessionId))!.image_quota_left).toBe(10);
  });
});

describe('POST /api/generate — a placement needs a request', () => {
  it('refuses a placement nobody asked for', async () => {
    const sessionId = await seed();
    setPhotoStoreForTesting(stubStore(await roomImage(), []));
    setImageProviderForTesting(stubProvider(await generatedImage()).provider);

    const res = await POST(
      new Request('http://localhost/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, product_id: SOFA.id }),
      }),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('no_placement_prompt');
  });

  it('spends no unit on a placement nobody asked for', async () => {
    const sessionId = await seed();
    setPhotoStoreForTesting(stubStore(await roomImage(), []));
    setImageProviderForTesting(stubProvider(await generatedImage()).provider);

    await POST(
      new Request('http://localhost/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, product_id: SOFA.id }),
      }),
    );

    // The refusal happens before the quota is touched.
    expect((await getDb().getSession(sessionId))!.image_quota_left).toBe(10);
  });

  it('puts the request the user wrote into the prompt', async () => {
    const sessionId = await seed();
    const stub = stubProvider(await generatedImage());
    setImageProviderForTesting(stub.provider);
    setPhotoStoreForTesting(stubStore(await roomImage(), []));

    const res = await POST(request(sessionId, SOFA.id));

    expect(res.status).toBe(201);
    expect(stub.requests[0].prompt).toContain(REQUEST);
    expect(stub.requests[0].prompt).toContain('WHAT THE USER ASKED FOR');
  });
});

describe('POST /api/generate — the picture', () => {
  it('stores the picture and links it to the session', async () => {
    const sessionId = await seed();
    const picture = await generatedImage();
    const stub = stubProvider(picture);
    const stored: Buffer[] = [];
    setImageProviderForTesting(stub.provider);
    setPhotoStoreForTesting(stubStore(await roomImage(), stored));

    const res = await POST(request(sessionId, SOFA.id));

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      image_id: string;
      job_id: string;
      width: number;
      image_quota_left: number;
      product: { width_cm: number; price_thb: number };
    };

    expect(body.image_id).toBeTruthy();
    expect(body.width).toBe(512);
    // The quota moved by exactly one.
    expect(body.image_quota_left).toBe(9);
    // The product's numbers come from the row, not from the request.
    expect(body.product.width_cm).toBe(228);
    expect(body.product.price_thb).toBe(24900);

    const images = await getDb().listImages(sessionId);
    const generated = images.filter((i) => i.kind === 'generated');
    expect(generated).toHaveLength(1);
    expect(generated[0].id).toBe(body.image_id);
    expect(generated[0].product_id).toBe(SOFA.id);

    const state = (await getDb().getSession(sessionId))!.state;
    expect(state.generated_image_ids).toContain(body.image_id);
    expect(state.selected_product_id).toBe(SOFA.id);
  });

  it('records the job as done and points it at the picture', async () => {
    const sessionId = await seed();
    const stub = stubProvider(await generatedImage());
    setImageProviderForTesting(stub.provider);
    setPhotoStoreForTesting(stubStore(await roomImage(), []));

    const res = await POST(request(sessionId, SOFA.id));
    const body = (await res.json()) as { image_id: string; job_id: string };

    const job = await getDb().getJob(body.job_id);
    expect(job?.status).toBe('done');
    expect(job?.result_image_id).toBe(body.image_id);
    expect(job?.product_id).toBe(SOFA.id);
  });

  it('stores the provider’s bytes untouched', async () => {
    const sessionId = await seed();
    const picture = await generatedImage();
    const stub = stubProvider(picture);
    const stored: Buffer[] = [];
    setImageProviderForTesting(stub.provider);
    setPhotoStoreForTesting(stubStore(await roomImage(), stored));

    await POST(request(sessionId, SOFA.id));

    // Nothing is drawn on top of the picture: the owner asked for the
    // pictures without a label in them (November 2026).
    expect(stored).toHaveLength(1);
    expect(stored[0].equals(picture)).toBe(true);
  });

  it('sends the room photo and a prompt built from the catalogue row', async () => {
    const sessionId = await seed();
    const stub = stubProvider(await generatedImage());
    setImageProviderForTesting(stub.provider);
    setPhotoStoreForTesting(stubStore(await roomImage(), []));

    await POST(request(sessionId, SOFA.id));

    expect(stub.requests).toHaveLength(1);
    const sent = stub.requests[0];
    expect(sent.baseImage!.bytes.length).toBeGreaterThan(0);
    expect(sent.baseImage!.mimeType).toBe('image/jpeg');
    // The dimensions in the prompt are the catalogue's.
    expect(sent.prompt).toContain('228 cm');
    expect(sent.prompt).toContain('KIVIK sofa');
  });

  it('sends the piece’s own picture so the model copies the real item', async () => {
    const publicDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roomy-public-'));
    process.env.ROOMY_PUBLIC_DIR = publicDir;
    await fs.mkdir(path.join(publicDir, 'product-images'), { recursive: true });
    await fs.writeFile(
      path.join(publicDir, 'product-images', `${SOFA.id}.svg`),
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#a7abb0"/></svg>',
    );

    try {
      const sessionId = await seed();
      const stub = stubProvider(await generatedImage());
      setImageProviderForTesting(stub.provider);
      setPhotoStoreForTesting(stubStore(await roomImage(), []));

      const res = await POST(request(sessionId, SOFA.id));

      expect(res.status).toBe(201);
      const sent = stub.requests[0];
      expect(sent.referenceImages).toHaveLength(1);
      expect(sent.referenceImages[0].mimeType).toBe('image/png');
      expect(sent.referenceImages[0].bytes.length).toBeGreaterThan(0);
      // The prompt tells the model which picture is which.
      expect(sent.prompt).toContain('SECOND image is the piece');
    } finally {
      delete process.env.ROOMY_PUBLIC_DIR;
    }
  });

  it('goes on without a reference when the catalogue has no picture', async () => {
    const sessionId = await seed();
    const stub = stubProvider(await generatedImage());
    setImageProviderForTesting(stub.provider);
    setPhotoStoreForTesting(stubStore(await roomImage(), []));

    const res = await POST(request(sessionId, SOFA.id));

    expect(res.status).toBe(201);
    expect(stub.requests[0].referenceImages).toHaveLength(0);
    expect(stub.requests[0].prompt).not.toContain('SECOND image');
  });

  it('quotes the measured space when the user measured one', async () => {
    const sessionId = await seed({
      selected_area: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 },
      reference_line: { x1: 0.1, y1: 0.2, x2: 0.35, y2: 0.2 },
      reference_cm: 60,
    });
    const stub = stubProvider(await generatedImage());
    setImageProviderForTesting(stub.provider);
    setPhotoStoreForTesting(stubStore(await roomImage(), []));

    const res = await POST(request(sessionId, SOFA.id));
    const body = (await res.json()) as {
      space: { width_cm: number; depth_cm: number };
      fit: { verdict: string };
    };

    // The line is a quarter of a 4:3 photo's width and is 60 cm, so one photo
    // width is 240 cm; half of that is 120 wide and 90 deep.
    expect(body.space.width_cm).toBeCloseTo(120, 1);
    expect(body.space.depth_cm).toBeCloseTo(90, 1);
    // The sofa is 228 x 95, so it does not fit that space.
    expect(body.fit.verdict).toBe('does_not_fit');
    expect(stub.requests[0].prompt).toContain('120 cm');
  });

  it('marks the target area on the photo it sends', async () => {
    const sessionId = await seed({
      selected_area: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 },
      reference_line: { x1: 0.1, y1: 0.2, x2: 0.35, y2: 0.2 },
      reference_cm: 60,
    });
    const stub = stubProvider(await generatedImage());
    setImageProviderForTesting(stub.provider);
    const room = await roomImage();
    setPhotoStoreForTesting(stubStore(room, []));

    await POST(request(sessionId, SOFA.id));

    // The copy that left the server carries the marker; the stored photo does
    // not, because it was never modified.
    expect(stub.requests[0].baseImage!.bytes.equals(room)).toBe(false);
    expect(stub.requests[0].prompt).toContain('outline');
  });
});

describe('POST /api/generate — another version of the same piece', () => {
  it('puts the change the user asked for into the prompt', async () => {
    const sessionId = await seed();
    const stub = stubProvider(await generatedImage());
    setImageProviderForTesting(stub.provider);
    setPhotoStoreForTesting(stubStore(await roomImage(), []));

    const res = await POST(
      iterationRequest(sessionId, SOFA.id, { instruction: 'ย้ายไปทางขวาอีกนิด' }),
    );

    expect(res.status).toBe(201);
    expect(stub.requests[0].prompt).toContain('ย้ายไปทางขวาอีกนิด');
    expect(stub.requests[0].prompt).toContain('THE CHANGE REQUESTED');
  });

  it('keeps the earlier changes too, so "smaller still" has a reference', async () => {
    const sessionId = await seed();
    const stub = stubProvider(await generatedImage());
    setImageProviderForTesting(stub.provider);
    setPhotoStoreForTesting(stubStore(await roomImage(), []));

    await POST(
      iterationRequest(sessionId, SOFA.id, {
        instruction: 'เล็กลงอีก',
        previous_instructions: ['ทำให้เล็กลง'],
      }),
    );

    const prompt = stub.requests[0].prompt;
    expect(prompt).toContain('ทำให้เล็กลง');
    expect(prompt).toContain('เล็กลงอีก');
    // Oldest first.
    expect(prompt.indexOf('ทำให้เล็กลง')).toBeLessThan(prompt.indexOf('เล็กลงอีก'));
  });

  it('numbers the versions of one piece, oldest first', async () => {
    const sessionId = await seed();
    const stub = stubProvider(await generatedImage());
    setImageProviderForTesting(stub.provider);
    setPhotoStoreForTesting(stubStore(await roomImage(), []));

    const first = await POST(request(sessionId, SOFA.id));
    const second = await POST(iterationRequest(sessionId, SOFA.id, { instruction: 'เล็กลงอีก' }));
    const third = await POST(iterationRequest(sessionId, SOFA.id, { instruction: 'แล้วก็ไปทางซ้าย' }));

    const firstBody = (await first.json()) as { version: number };
    const secondBody = (await second.json()) as { version: number };
    const thirdBody = (await third.json()) as { version: number };

    expect(firstBody.version).toBe(1);
    expect(secondBody.version).toBe(2);
    expect(thirdBody.version).toBe(3);
  });

  it('starts a new chain for a different piece', async () => {
    const sessionId = await seed();
    const db = getDb();
    const other = { ...SOFA, id: 'chair-1', name_th: 'เก้าอี้', name_en: 'Chair' };
    await db.upsertProducts([other]);

    const stub = stubProvider(await generatedImage());
    setImageProviderForTesting(stub.provider);
    setPhotoStoreForTesting(stubStore(await roomImage(), []));

    await POST(request(sessionId, SOFA.id));
    const res = await POST(request(sessionId, other.id));

    const body = (await res.json()) as { version: number };
    expect(body.version).toBe(1);
  });

  it('spends a unit of quota on an iteration, like any other picture', async () => {
    const sessionId = await seed();
    const stub = stubProvider(await generatedImage());
    setImageProviderForTesting(stub.provider);
    setPhotoStoreForTesting(stubStore(await roomImage(), []));

    const res = await POST(iterationRequest(sessionId, SOFA.id, { instruction: 'เล็กลงอีก' }));

    const body = (await res.json()) as { image_quota_left: number };
    expect(body.image_quota_left).toBe(9);
  });

  it('refuses a change that is empty', async () => {
    const sessionId = await seed();
    setPhotoStoreForTesting(stubStore(await roomImage(), []));
    setImageProviderForTesting(stubProvider(await generatedImage()).provider);

    const res = await POST(iterationRequest(sessionId, SOFA.id, { instruction: '   ' }));

    expect(res.status).toBe(400);
  });

  it('refuses a change that is too long to be a sentence', async () => {
    const sessionId = await seed();
    setPhotoStoreForTesting(stubStore(await roomImage(), []));
    setImageProviderForTesting(stubProvider(await generatedImage()).provider);

    const res = await POST(iterationRequest(sessionId, SOFA.id, { instruction: 'ก'.repeat(301) }));

    expect(res.status).toBe(400);
  });

  it('refuses an unknown field rather than ignoring it', async () => {
    const sessionId = await seed();
    setPhotoStoreForTesting(stubStore(await roomImage(), []));
    setImageProviderForTesting(stubProvider(await generatedImage()).provider);

    const res = await POST(
      new Request('http://localhost/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          product_id: SOFA.id,
          width_cm: 10,
        }),
      }),
    );

    expect(res.status).toBe(400);
  });
});

describe('POST /api/generate — when it goes wrong', () => {
  it('reports a provider failure and marks the job failed', async () => {
    const sessionId = await seed();
    const stub = stubProvider(await generatedImage(), new Error('provider exploded'));
    setImageProviderForTesting(stub.provider);
    setPhotoStoreForTesting(stubStore(await roomImage(), []));

    const res = await POST(request(sessionId, SOFA.id));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; job_id: string };
    const job = await getDb().getJob(body.job_id);
    expect(job?.status).toBe('failed');
    expect(job?.error).toContain('provider exploded');
  });

  it('stores no picture when the provider failed', async () => {
    const sessionId = await seed();
    const stub = stubProvider(await generatedImage(), new Error('provider exploded'));
    setImageProviderForTesting(stub.provider);
    setPhotoStoreForTesting(stubStore(await roomImage(), []));

    await POST(request(sessionId, SOFA.id));

    const images = await getDb().listImages(sessionId);
    expect(images.filter((i) => i.kind === 'generated')).toHaveLength(0);
  });
});
