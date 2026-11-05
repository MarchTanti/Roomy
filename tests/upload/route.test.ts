/**
 * End-to-end test of the real `/api/upload` route — no network.
 *
 * Drives the actual handler with the real image pipeline (sharp), the real local
 * photo store and the real local DB adapter. Only the vision model is replaced.
 * That combination is what makes the EXIF and quota assertions meaningful: they
 * are claims about bytes on disk and counters in the database, so testing
 * against mocks would prove nothing.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseImageKey } from '@/lib/storage';
import type { DbClient, ImageRecord, RoomAnalysis, Session } from '@/lib/db/types';

const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'roomy-upload-'));
process.env.ROOMY_DATA_DIR = DATA_DIR;
delete process.env.DB_ADAPTER;
delete process.env.GEMINI_API_KEY;

type RoutePost = (request: Request) => Promise<Response>;
type RouteGet = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let POST: RoutePost;
let createSessionPost: RoutePost;
let imageGet: RouteGet;
let setRoomAnalyzerForTesting: (a: { id: string; analyze: (b64: string) => Promise<RoomAnalysis> } | null) => void;
let resetLlm: () => void;
let resetDb: () => void;
let resetPhotoStore: () => void;
let getDb: () => DbClient;

beforeAll(async () => {
  ({ POST } = await import('@/app/api/upload/route'));
  ({ POST: createSessionPost } = await import('@/app/api/session/route'));
  ({ GET: imageGet } = await import('@/app/api/image/[id]/route'));
  ({ setRoomAnalyzerForTesting, resetLlm } = await import('@/lib/llm'));
  ({ resetDb, getDb } = await import('@/lib/db'));
  ({ resetPhotoStore } = await import('@/lib/storage'));
});

const ANALYSIS: RoomAnalysis = {
  style: 'japandi',
  colors: ['สีขาว', 'ไม้อ่อน'],
  lighting: 'แสงธรรมชาติจากหน้าต่าง',
};

function stubAnalyzer(result: RoomAnalysis | Error = ANALYSIS): string[] {
  const seen: string[] = [];
  setRoomAnalyzerForTesting({
    id: 'stub',
    async analyze(b64) {
      seen.push(b64);
      if (result instanceof Error) throw result;
      return result;
    },
  });
  return seen;
}

async function newSessionId(): Promise<string> {
  const res = await createSessionPost(new Request('http://localhost/api/session', { method: 'POST' }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { session_id: string }).session_id;
}

/** A real JPEG with EXIF attached, including a GPS tag. */
async function jpegWithExif(): Promise<Uint8Array> {
  const base = await sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 120, g: 120, b: 120 } },
  })
    .jpeg()
    .toBuffer();
  return sharp(base)
    .withExif({
      IFD0: { Copyright: 'RoomyAI test' },
      IFD2: { GPSLatitude: '13/1 45/1 0/1', GPSLongitude: '100/1 30/1 0/1' },
    })
    .toBuffer();
}

/** `File` wants an `ArrayBuffer`, not a view onto one. */
function toFilePart(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function uploadRequest(sessionId: string, file: Uint8Array, filename = 'room.jpg', type = 'image/jpeg'): Request {
  const form = new FormData();
  form.set('session_id', sessionId);
  form.set('file', new File([toFilePart(file)], filename, { type }));
  return new Request('http://localhost/api/upload', { method: 'POST', body: form });
}

interface UploadBody {
  image_id: string;
  url: string | null;
  analysis: RoomAnalysis | null;
  analysis_error: string | null;
  image_quota_left: number;
  room_photos_uploaded: number;
  room_photos_limit: number;
  width: number;
  height: number;
}

/** POST, expect the status, return the parsed body. */
async function postJson(request: Request, status: number): Promise<UploadBody> {
  const res = await POST(request);
  expect(res.status, `expected ${status}, body was ${await res.clone().text()}`).toBe(status);
  return (await res.json()) as UploadBody;
}

/** Upload a photo with EXIF and return the parsed body. */
function postPhoto(sessionId: string): Promise<UploadBody> {
  return upload(sessionId);
}

async function upload(sessionId: string): Promise<UploadBody> {
  return postJson(uploadRequest(sessionId, await jpegWithExif()), 201);
}

/**
 * Read the stored bytes straight off disk, below the app.
 *
 * Goes through the path recorded on the image row rather than assuming a
 * filename, so it also proves the DB and the filesystem agree.
 */
async function readStored(imageId: string): Promise<Buffer> {
  const record = (await getDb().getImage(imageId)) as ImageRecord;
  const { sessionId, imageId: fileId, extension } = parseImageKey(record.storage_path);
  const file = path.join(DATA_DIR, 'uploads', sessionId, `${fileId}.${extension}`);
  return fs.readFile(file);
}

/** A unique storage path for an image row that is never uploaded. */
let dummyCounter = 0;
function dummyPath(): string {
  dummyCounter += 1;
  const id = `00000000-0000-4000-8000-${String(dummyCounter).padStart(12, '0')}`;
  return `${SESSION_UUID}/${id}.jpg`;
}

const SESSION_UUID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  resetDb();
  resetLlm();
  resetPhotoStore();
});

afterEach(() => {
  setRoomAnalyzerForTesting(null);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('POST /api/upload', () => {
  it('stores the photo, analyses it and records both', async () => {
    const analyzed = stubAnalyzer();
    const sessionId = await newSessionId();

    const body = await postPhoto(sessionId);

    expect(body.analysis).toEqual(ANALYSIS);
    expect(body.analysis_error).toBeNull();
    expect(body.image_quota_left).toBe(10);

    // The vision model saw the processed bytes — and specifically the ones that
    // were stored, not the raw upload with its GPS tag still attached.
    expect(analyzed).toHaveLength(1);
    expect(Buffer.from(analyzed[0], 'base64')).not.toEqual(await jpegWithExif());
    expect(Buffer.from(analyzed[0], 'base64')).toEqual(await readStored(body.image_id));

    const record = (await getDb().getImage(body.image_id)) as ImageRecord;
    expect(record.kind).toBe('room');
    expect(parseImageKey(record.storage_path).sessionId).toBe(sessionId);
  });

  it('writes the analysis into session state so chat never has to re-look', async () => {
    // The whole reason this route analyses the photo: a later chat turn reads
    // `room_analysis` out of the system instruction instead of paying for
    // another vision round trip.
    stubAnalyzer();
    const sessionId = await newSessionId();

    const body = await postPhoto(sessionId);
    const session = (await getDb().getSession(sessionId)) as Session;

    expect(session.state.room_image_id).toBe(body.image_id);
    expect(session.state.room_analysis).toEqual(ANALYSIS);
  });

  it('strips EXIF — including location — before the bytes touch disk', async () => {
    stubAnalyzer();
    const sessionId = await newSessionId();
    const withGps = await jpegWithExif();

    // Guard the fixture: if sharp ever stops writing the tag, this test would
    // pass for the wrong reason.
    expect((await sharp(withGps).metadata()).exif).toBeDefined();

    const body = await postJson(uploadRequest(sessionId, withGps), 201);
    const stored = await readStored(body.image_id);
    const meta = await sharp(stored).metadata();

    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(stored.includes(Buffer.from('RoomyAI test'))).toBe(false);
  });

  it('resizes to the configured long edge', async () => {
    stubAnalyzer();
    const sessionId = await newSessionId();
    const big = await sharp({
      create: { width: 3000, height: 1500, channels: 3, background: { r: 10, g: 10, b: 10 } },
    })
      .jpeg()
      .toBuffer();
    const body = await postJson(uploadRequest(sessionId, new Uint8Array(big)), 201);
    expect(Math.max(body.width, body.height)).toBeLessThanOrEqual(1536);

    const meta = await sharp(await readStored(body.image_id)).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1536);
  });

  it('keeps the upload when only the analysis fails', async () => {
    // The photo is the user's data. Losing it because a vision call was rate
    // limited would be the wrong trade.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubAnalyzer(new Error('quota exceeded'));
    const sessionId = await newSessionId();

    const body = await postPhoto(sessionId);

    expect(body.analysis).toBeNull();
    expect(body.analysis_error).toBe('quota exceeded');
    expect(await readStored(body.image_id)).toBeInstanceOf(Buffer);
  });

  it('clears a stale analysis when a new photo replaces an old one', async () => {
    stubAnalyzer();
    const sessionId = await newSessionId();
    await postPhoto(sessionId);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubAnalyzer(new Error('boom'));
    const second = await postPhoto(sessionId);

    // Leaving the old description would describe a photo the user replaced.
    const session = (await getDb().getSession(sessionId)) as Session;
    expect(session.state.room_image_id).toBe(second.image_id);
    expect(session.state.room_analysis).toBeNull();
  });

  it('drops a measurement taken on the photo it replaces', async () => {
    // The area the user drew measured the room in the *previous* photo. Left
    // in place, checkFit would answer about a room they are no longer in.
    stubAnalyzer();
    const sessionId = await newSessionId();

    const db = getDb();
    const session = (await db.getSession(sessionId)) as Session;
    await db.updateSessionState(sessionId, {
      ...session.state,
      selected_area: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 },
      reference_line: { x1: 0.1, y1: 0.5, x2: 0.35, y2: 0.5 },
      reference_cm: 60,
    });

    await postPhoto(sessionId);

    const after = (await db.getSession(sessionId)) as Session;
    expect(after.state.selected_area).toBeNull();
    expect(after.state.reference_line).toBeNull();
    expect(after.state.reference_cm).toBeNull();
  });

  // ----- rejections -----

  it('rejects an unknown session with 404', async () => {
    stubAnalyzer();
    const res = await POST(uploadRequest('00000000-0000-4000-8000-000000000000', await jpegWithExif()));
    expect(res.status).toBe(404);
  });

  it('rejects a non-uuid session id with 400', async () => {
    stubAnalyzer();
    expect((await POST(uploadRequest('not-a-uuid', await jpegWithExif()))).status).toBe(400);
  });

  it('rejects a missing file with 400', async () => {
    const sessionId = await newSessionId();
    const form = new FormData();
    form.set('session_id', sessionId);
    const res = await POST(new Request('http://localhost/api/upload', { method: 'POST', body: form }));
    expect(res.status).toBe(400);
  });

  it('rejects a non-multipart body with 400', async () => {
    const res = await POST(
      new Request('http://localhost/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects an unsupported content type with 415', async () => {
    stubAnalyzer();
    const sessionId = await newSessionId();
    const res = await POST(uploadRequest(sessionId, new TextEncoder().encode('not an image'), 'notes.txt', 'text/plain'));
    expect(res.status).toBe(415);
  });

  it('rejects bytes that are not an image with 415', async () => {
    // Declared image/jpeg, actually text. The check has to go through the
    // decoder, not just the header the client sent.
    stubAnalyzer();
    const sessionId = await newSessionId();
    const res = await POST(uploadRequest(sessionId, new TextEncoder().encode('%PDF-1.4 nope'), 'fake.jpg'));
    expect(res.status).toBe(415);
  });

  it('rejects an oversized file with 413', async () => {
    stubAnalyzer();
    const sessionId = await newSessionId();
    const oversize = new Uint8Array(Number(process.env.MAX_UPLOAD_MB ?? 8) * 1024 * 1024 + 1);
    expect((await POST(uploadRequest(sessionId, oversize))).status).toBe(413);
  });

  it('does not spend the image quota — that budget is for generated images', async () => {
    // The spec's `image_quota_left` covers the images the app *generates*, the
    // ones that cost a generation call. A user uploading their own room photo
    // must not spend that budget before they have seen a single result.
    stubAnalyzer();
    const sessionId = await newSessionId();

    const body = await postPhoto(sessionId);
    expect(body.image_quota_left).toBe(10);

    // Walk up to the room-photo cap without ever moving it.
    for (let i = 0; i < 3; i += 1) expect((await postPhoto(sessionId)).image_quota_left).toBe(10);

    const session = (await getDb().getSession(sessionId)) as Session;
    expect(session.image_quota_left).toBe(10);
    expect(await getDb().listImages(sessionId)).toHaveLength(4);
  });

  it('caps room photos per session and refuses past the cap', async () => {
    // ROOM_PHOTOS_PER_SESSION defaults to 4. Nothing in the spec sets this
    // number; it exists so one session cannot fill the bucket.
    stubAnalyzer();
    const sessionId = await newSessionId();

    for (let i = 0; i < 4; i += 1) {
      const res = await POST(uploadRequest(sessionId, await jpegWithExif()));
      expect(res.status).toBe(201);
    }

    const blocked = await POST(uploadRequest(sessionId, await jpegWithExif()));
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { error: string; room_photos_limit: number; message: string };
    expect(body.error).toBe('room_photo_limit_reached');
    expect(body.room_photos_limit).toBe(4);
    expect(body.message).toContain('4');

    // The refused upload stored nothing and analysed nothing.
    expect(await getDb().listImages(sessionId)).toHaveLength(4);
  });

  it('reports how many room photos the session has used', async () => {
    stubAnalyzer();
    const sessionId = await newSessionId();

    expect((await postPhoto(sessionId)).room_photos_uploaded).toBe(1);
    expect((await postPhoto(sessionId)).room_photos_uploaded).toBe(2);
  });

  it('counts only room photos against the cap, not generated ones', async () => {
    // Both live in `images` with a different `kind`. Generated images are
    // bounded by the quota; letting them eat the room-photo allowance would
    // block uploads for a reason the user never caused.
    stubAnalyzer();
    const sessionId = await newSessionId();

    await postPhoto(sessionId);
    await getDb().addImage({ session_id: sessionId, kind: 'generated', storage_path: await dummyPath() });
    await getDb().addImage({ session_id: sessionId, kind: 'generated', storage_path: await dummyPath() });

    // 1 room photo + 2 generated = 3 rows, but the allowance sees only 1.
    expect(await getDb().listImages(sessionId)).toHaveLength(3);
    expect((await postPhoto(sessionId)).room_photos_uploaded).toBe(2);
  });

  it('caps each session separately', async () => {
    stubAnalyzer();
    const a = await newSessionId();
    const b = await newSessionId();

    for (let i = 0; i < 4; i += 1) await postPhoto(a);
    expect((await POST(uploadRequest(a, await jpegWithExif()))).status).toBe(429);

    // A new session is a clean allowance.
    expect((await postPhoto(b)).room_photos_uploaded).toBe(1);
  });

  it('leaves the quota alone for requests it rejects', async () => {
    stubAnalyzer();
    const sessionId = await newSessionId();

    await POST(uploadRequest(sessionId, new TextEncoder().encode('nope'), 'x.txt', 'text/plain'));
    await POST(uploadRequest('00000000-0000-4000-8000-000000000000', await jpegWithExif()));

    const session = (await getDb().getSession(sessionId)) as Session;
    expect(session.image_quota_left).toBe(10);
    expect(await getDb().listImages(sessionId)).toHaveLength(0);
  });
});

describe('GET /api/image/[id]', () => {
  it('streams the photo back for the owning session', async () => {
    stubAnalyzer();
    const sessionId = await newSessionId();
    const body = await postPhoto(sessionId);

    const res = await imageGet(
      new Request(`http://localhost/api/image/${body.image_id}?session_id=${sessionId}`),
      { params: Promise.resolve({ id: body.image_id }) },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect((await sharp(bytes).metadata()).format).toBe('jpeg');
  });

  it('hides a photo from any other session', async () => {
    stubAnalyzer();
    const owner = await newSessionId();
    const stranger = await newSessionId();
    const body = await postPhoto(owner);

    const res = await imageGet(
      new Request(`http://localhost/api/image/${body.image_id}?session_id=${stranger}`),
      { params: Promise.resolve({ id: body.image_id }) },
    );

    // 404, not 403: confirming the photo exists is itself disclosure.
    expect(res.status).toBe(404);
  });

  it('requires the session id', async () => {
    stubAnalyzer();
    const sessionId = await newSessionId();
    const body = await postPhoto(sessionId);

    const res = await imageGet(new Request(`http://localhost/api/image/${body.image_id}`), {
      params: Promise.resolve({ id: body.image_id }),
    });
    expect(res.status).toBe(400);
  });

  it('404s an unknown id', async () => {
    stubAnalyzer();
    const sessionId = await newSessionId();
    const unknown = '44444444-4444-4444-8444-444444444444';

    const res = await imageGet(new Request(`http://localhost/api/image/${unknown}?session_id=${sessionId}`), {
      params: Promise.resolve({ id: unknown }),
    });
    expect(res.status).toBe(404);
  });
});