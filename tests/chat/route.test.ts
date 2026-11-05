/**
 * End-to-end test of the real `/api/chat` route handler — no network.
 *
 * This drives the actual `POST` export through the tool loop, the real tool
 * executors and the real persistence layer, with only the LLM provider
 * replaced by a script. That combination is what isolates "is the bug in our
 * code" from "is the bug in the provider SDK": everything below `runStep` is
 * the production path.
 *
 * It also covers the pieces no other test touches — the 400/404 branches, the
 * rate limiter wiring, and the fact that a turn round-trips through storage
 * intact so the *next* turn can rebuild history from it.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Json, Product } from '@/lib/db/types';
import type { DbClient } from '@/lib/db/types';
import type { LlmPart, LlmProvider, LlmStepInput, LlmStepResult, ToolCall } from '@/lib/llm/types';

// lib/db/local.ts snapshots ROOMY_DATA_DIR into a module-level const at import
// time, and every app module below imports it. So this must be assigned before
// the dynamic imports in beforeAll — static imports would be hoisted above it.
const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'roomy-route-'));
process.env.ROOMY_DATA_DIR = DATA_DIR;
delete process.env.DB_ADAPTER;
delete process.env.GEMINI_API_KEY;

type ChatPost = (request: Request) => Promise<Response>;

let POST: ChatPost;
let createSessionPost: ChatPost;
let setLlmForTesting: (p: LlmProvider | null) => void;
let resetLlm: () => void;
let resetDb: () => void;
let resetRateLimits: () => void;
let getDb: () => DbClient;

beforeAll(async () => {
  ({ POST } = await import('@/app/api/chat/route'));
  ({ POST: createSessionPost } = await import('@/app/api/session/route'));
  ({ setLlmForTesting, resetLlm } = await import('@/lib/llm'));
  ({ resetDb, getDb } = await import('@/lib/db'));
  ({ resetRateLimits } = await import('@/lib/rate-limit'));
});

// ---------------------------------------------------------------------------
// Scripted provider
// ---------------------------------------------------------------------------

/** A provider that replays a fixed list of steps, recording the input it saw. */
function scriptedProvider(steps: LlmStepResult[]): LlmProvider & { seen: LlmStepInput[] } {
  const seen: LlmStepInput[] = [];
  let i = 0;
  return {
    id: 'scripted',
    seen,
    async runStep(input) {
      // Snapshot the history: the real adapter converts it synchronously, but
      // the loop keeps pushing onto the same array, so storing the reference
      // would show the grown history rather than what the model was sent.
      seen.push({ ...input, history: input.history.map((m) => ({ ...m })) });
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      return step;
    },
  };
}

function call(name: string, args: Record<string, unknown>, id: string | null = null): ToolCall {
  return { id, name, args: args as ToolCall['args'] };
}

/** Compact shape of a message, e.g. `model:toolCall(searchFurniture)`. */
function describeMessages(history: readonly { role: string; parts: readonly LlmPart[] }[]): string[] {
  return history.map((m) =>
    m.parts
      .map((p) => {
        if (p.kind === 'text') return `${m.role}:text`;
        if (p.kind === 'toolCall') return `${m.role}:toolCall(${p.call.name})`;
        return `${m.role}:toolResult(${p.name})`;
      })
      .join('+'),
  );
}

async function seedProducts(count = 3): Promise<Product[]> {
  const products: Product[] = Array.from({ length: count }, (_, i) => ({
    id: `p-${i}`,
    source: 'ikea',
    source_url: `https://example.test/${i}`,
    name_th: `โซฟา ${i}`,
    name_en: `Sofa ${i}`,
    category: 'sofa',
    style_tags: ['scandinavian'],
    color: 'สีเทา',
    material: 'ผ้า',
    price_thb: 9000 + i * 1000,
    width_cm: 200,
    depth_cm: 90,
    height_cm: 80,
    image_url: `/product-images/p-${i}.svg`,
    in_stock: true,
  }));
  await getDb().upsertProducts(products);
  return products;
}

async function newSessionId(): Promise<string> {
  const res = await createSessionPost(new Request('http://localhost/api/session', { method: 'POST' }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { session_id: string }).session_id;
}

function chatRequest(sessionId: string, message: string, ip = '203.0.113.7'): Request {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ session_id: sessionId, message }),
  });
}

// --- SSE reading ------------------------------------------------------------

type ChatEvent =
  | { type: 'step' }
  | { type: 'delta'; text: string }
  | {
      type: 'done';
      reply: string;
      tool_calls: { name: string }[];
      iterations: number;
      state: unknown;
      products: { id: string; name_th: string; price_thb: number }[] | null;
    }
  | { type: 'error'; error: string; message: string };

async function streamEvents(res: Response): Promise<ChatEvent[]> {
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const raw = await res.text();
  return raw
    .split('\n\n')
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      return JSON.parse(data) as ChatEvent;
    });
}

/** Drains the stream and returns the terminal `done` frame. */
async function readDone(res: Response): Promise<Extract<ChatEvent, { type: 'done' }>> {
  const events = await streamEvents(res);
  const done = events.find((e) => e.type === 'done');
  expect(done, 'stream ended without a done frame').toBeDefined();
  return done as Extract<ChatEvent, { type: 'done' }>;
}

/**
 * Sends a turn and waits for it to finish.
 *
 * Draining matters: the handler returns the response as soon as the stream
 * opens, and the model call and the writes happen after that. A test that skips
 * this races the next request against an unfinished turn.
 */
async function send(sessionId: string, message: string, ip = '203.0.113.7'): Promise<Response> {
  const res = await POST(chatRequest(sessionId, message, ip));
  await streamEvents(res);
  return res;
}

beforeEach(() => {
  resetLlm();
  resetDb();
  resetRateLimits();
});

afterEach(() => {
  setLlmForTesting(null);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('POST /api/chat', () => {
  it('answers a plain question without calling a tool', async () => {
    await seedProducts(1);
    const provider = scriptedProvider([{ text: 'ได้ครับ ชอบสไตล์ไหนครับ', toolCalls: [], finishReason: 'stop' }]);
    setLlmForTesting(provider);

    const sessionId = await newSessionId();
    const res = await POST(chatRequest(sessionId, 'สวัสดี'));

    expect(res.status).toBe(200);
    const body = await readDone(res);
    expect(body.reply).toBe('ได้ครับ ชอบสไตล์ไหนครับ');
    expect(body.tool_calls).toEqual([]);
    expect(body.iterations).toBe(1);
    expect(provider.seen).toHaveLength(1);
  });

  it('runs a tool and folds the reply into session state', async () => {
    await seedProducts(3);
    const provider = scriptedProvider([
      {
        text: 'กำลังหาให้ครับ',
        toolCalls: [call('searchFurniture', { style: 'scandinavian', max_price_thb: 15000, limit: 3 })],
        finishReason: 'stop',
      },
      { text: 'เจอโซฟาสแกนดินาเวีย 3 รุ่นครับ', toolCalls: [], finishReason: 'stop' },
    ]);
    setLlmForTesting(provider);

    const sessionId = await newSessionId();
    const res = await POST(chatRequest(sessionId, 'อยากได้โซฟาสไตล์สแกนดินาเวีย งบ 15000'));

    expect(res.status).toBe(200);
    const body = await readDone(res);

    expect(body.reply).toBe('เจอโซฟาสแกนดินาเวีย 3 รุ่นครับ');
    expect(body.tool_calls.map((c) => c.name)).toEqual(['searchFurniture']);
    expect(body.iterations).toBe(2);

    // The search arguments become the stored preferences — the database is the
    // source of truth, not the model's memory of the conversation.
    const state = body.state as { preferences: { style: string | null; budget_thb: number | null } };
    expect(state.preferences.style).toBe('scandinavian');
    expect(state.preferences.budget_thb).toBe(15000);

    // Second call saw the tool result, in the user-role shape Gemini expects.
    expect(provider.seen).toHaveLength(2);
    expect(describeMessages(provider.seen[1].history)).toEqual([
      'user:text',
      'model:text+model:toolCall(searchFurniture)',
      'user:toolResult(searchFurniture)',
    ]);
  });

  it('persists the whole round trip so the next turn can rebuild from it', async () => {
    await seedProducts(2);
    const provider = scriptedProvider([
      { text: '', toolCalls: [call('searchFurniture', { category: 'sofa' })], finishReason: 'stop' },
      { text: 'มีสองรุ่นครับ', toolCalls: [], finishReason: 'stop' },
    ]);
    setLlmForTesting(provider);

    const sessionId = await newSessionId();
    expect((await send(sessionId, 'มีโซฟาอะไรบ้าง')).status).toBe(200);

    const stored = (await getDb().listMessages(sessionId)) as { role: string; content: Json }[];
    // user turn, model tool call, tool result, assistant reply
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);

    // Everything persisted must be JSON — this is what PostgREST stores in jsonb.
    for (const row of stored) {
      expect(() => JSON.stringify(row.content)).not.toThrow();
    }
  });

  it('carries prior turns into the next request', async () => {
    await seedProducts(1);
    const provider = scriptedProvider([{ text: 'ได้ครับ', toolCalls: [], finishReason: 'stop' }]);
    setLlmForTesting(provider);

    const sessionId = await newSessionId();
    await send(sessionId, 'ครั้งแรก');
    await send(sessionId, 'ครั้งที่สอง');

    expect(provider.seen).toHaveLength(2);
    expect(describeMessages(provider.seen[1].history)).toEqual(['user:text', 'model:text', 'user:text']);
  });

  it('rebuilds a tool round trip from storage on the following turn', async () => {
    await seedProducts(2);
    const provider = scriptedProvider([
      { text: 'กำลังหาให้ครับ', toolCalls: [call('searchFurniture', { category: 'sofa' })], finishReason: 'stop' },
      { text: 'เจอสองตัวครับ', toolCalls: [], finishReason: 'stop' },
      { text: 'มีอะไรให้ช่วยต่อครับ', toolCalls: [], finishReason: 'stop' },
    ]);
    setLlmForTesting(provider);

    const sessionId = await newSessionId();
    await send(sessionId, 'อยากได้โซฟา');
    await send(sessionId, 'ตัวไหนราคาถูกสุด');

    // The whole round trip has to come back, in order, from the database —
    // including the first question. Losing user turns here is silent: the model
    // just quietly forgets what it was asked.
    expect(describeMessages(provider.seen[2].history)).toEqual([
      'user:text',
      'model:text+model:toolCall(searchFurniture)',
      'user:toolResult(searchFurniture)',
      'model:text',
      'user:text',
    ]);
  });

  it('sends a system instruction that states the current session state', async () => {
    await seedProducts(1);
    const provider = scriptedProvider([{ text: 'ได้ครับ', toolCalls: [], finishReason: 'stop' }]);
    setLlmForTesting(provider);

    const sessionId = await newSessionId();
    await send(sessionId, 'งบ 12000 สไตล์มินิมอล');

    const instruction = provider.seen[0].systemInstruction;
    // Every one of the nine state fields is serialised, never a partial object.
    // (Preferences stay null here because no search ran — the database is the
    // source of truth, and the model only gets a preference once a tool set it.)
    for (const field of [
      'room_image_id',
      'room_analysis',
      'preferences',
      'reference_cm',
      'reference_line',
      'selected_area',
      'shown_products',
      'selected_product_id',
      'generated_image_ids',
    ]) {
      expect(instruction).toContain(field);
    }
  });

  // ----- rejections -----

  it('rejects a malformed body with 400', async () => {
    const res = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_json');
  });

  it('rejects an unknown session with 404', async () => {
    setLlmForTesting(scriptedProvider([{ text: 'x', toolCalls: [], finishReason: 'stop' }]));
    const res = await POST(chatRequest('00000000-0000-4000-8000-000000000000', 'สวัสดี'));
    expect(res.status).toBe(404);
  });

  it('rate limits by IP after the configured number of turns', async () => {
    setLlmForTesting(scriptedProvider([{ text: 'ได้ครับ', toolCalls: [], finishReason: 'stop' }]));
    const sessionId = await newSessionId();
    const ip = '198.51.100.4';

    const limit = Number(process.env.CHAT_TURNS_PER_HOUR ?? '20');
    for (let i = 0; i < limit; i += 1) {
      expect((await send(sessionId, `ครั้งที่ ${i}`, ip)).status).toBe(200);
    }

    const blocked = await POST(chatRequest(sessionId, 'เกินลิมิต', ip));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    const body = (await blocked.json()) as { error: string };
    expect(body.error).toBe('rate_limited');
  });

  it('reports a mid-stream failure as an error frame, never a stack', async () => {
    setLlmForTesting({
      id: 'broken',
      async runStep() {
        throw new Error('provider exploded');
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const sessionId = await newSessionId();
    const res = await POST(chatRequest(sessionId, 'สวัสดี'));

    // The turn already started streaming, so the status is spent. The failure
    // has to ride inside the stream instead.
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).toContain('chat_failed');
    expect(raw).not.toContain('at ');
  });

  it('sends the products of the search, so the client can offer them', async () => {
    await seedProducts(3);
    const provider = scriptedProvider([
      { text: 'กำลังหาให้ครับ', toolCalls: [call('searchFurniture', { category: 'sofa' })], finishReason: 'stop' },
      { text: 'เจอสามตัวครับ', toolCalls: [], finishReason: 'stop' },
    ]);
    setLlmForTesting(provider);

    const sessionId = await newSessionId();
    const done = await readDone(await POST(chatRequest(sessionId, 'มีโซฟาไหม')));

    // The cards the user presses to ask for a picture.
    expect(done.products?.length).toBeGreaterThan(0);
    expect(done.products?.map((p) => p.id)).toContain('p-0');
    expect(done.products?.[0]).toMatchObject({ id: 'p-0', name_th: 'โซฟา 0', price_thb: 9000 });
    expect(done.products?.[0]).toMatchObject({ width_cm: 200, depth_cm: 90, height_cm: 80 });
  });

  it('sends no products when the turn searched for nothing', async () => {
    const provider = scriptedProvider([{ text: 'ได้ครับ', toolCalls: [], finishReason: 'stop' }]);
    setLlmForTesting(provider);

    const sessionId = await newSessionId();
    const done = await readDone(await POST(chatRequest(sessionId, 'สวัสดี')));

    expect(done.products).toBeNull();
  });

  it('records the products it showed, so the model can refer back to them', async () => {
    await seedProducts(2);
    const provider = scriptedProvider([
      { text: 'กำลังหาให้ครับ', toolCalls: [call('searchFurniture', { category: 'sofa' })], finishReason: 'stop' },
      { text: 'มีสองตัวครับ', toolCalls: [], finishReason: 'stop' },
    ]);
    setLlmForTesting(provider);

    const sessionId = await newSessionId();
    const done = await readDone(await POST(chatRequest(sessionId, 'อยากได้โซฟา')));

    const state = done.state as { shown_products: string[] };
    // Exactly the products that were shown, in the order they were shown.
    expect(state.shown_products).toEqual(done.products?.map((p) => p.id));
    expect(state.shown_products).toContain('p-0');
  });

  it('emits a step frame before each model step so the UI can reset', async () => {    await seedProducts(1);
    const provider = scriptedProvider([
      { text: 'กำลังหาให้ครับ', toolCalls: [call('searchFurniture', { category: 'sofa' })], finishReason: 'stop' },
      { text: 'มีสองตัวครับ', toolCalls: [], finishReason: 'stop' },
    ]);
    setLlmForTesting(provider);

    const sessionId = await newSessionId();
    const events = await streamEvents(await POST(chatRequest(sessionId, 'มีโซฟาไหม')));

    // Two model steps means two resets: the preamble must not be concatenated
    // onto the reply.
    expect(events.filter((e) => e.type === 'step')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'step')[0].type).toBe('step');
    expect(events[events.length - 1].type).toBe('done');
  });
});
describe('POST /api/chat: tuning', () => {
  it('logs timings and token counts without logging message text', async () => {
    await seedProducts(1);
    const provider = scriptedProvider([{ text: 'ได้ครับ', toolCalls: [], finishReason: 'stop' }]);
    setLlmForTesting(provider);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const sessionId = await newSessionId();
    await send(sessionId, 'ข้อความลับที่ห้ามไปอยู่ใน log');

    expect(log).toHaveBeenCalled();
    const line = String(log.mock.calls[0][0]);
    expect(line).toMatch(/hist=\d+ steps=1/);
    expect(line).toMatch(/step_ms=\[\d+\]/);
    expect(line).toMatch(/tokens_in=\d+ tokens_out=\d+/);
    // The spec forbids logging chat contents.
    expect(line).not.toContain('ข้อความลับ');
  });

  it('records one duration per model step', async () => {
    await seedProducts(1);
    const provider = scriptedProvider([
      { text: 'หาให้', toolCalls: [call('searchFurniture', { category: 'sofa' })], finishReason: 'stop' },
      { text: 'เจอครับ', toolCalls: [], finishReason: 'stop' },
    ]);
    setLlmForTesting(provider);

    const sessionId = await newSessionId();
    const done = await readDone(await POST(chatRequest(sessionId, 'โซฟา')));

    expect(done.iterations).toBe(2);
  });

  it('honours a development-only ?history override', async () => {
    await seedProducts(1);
    const provider = scriptedProvider([{ text: 'ได้ครับ', toolCalls: [], finishReason: 'stop' }]);
    setLlmForTesting(provider);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const sessionId = await newSessionId();
    // Build up a conversation.
    for (let i = 0; i < 4; i += 1) await send(sessionId, `คำถาม ${i}`);

    const withCap = new Request('http://localhost/api/chat?history=2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.55' },
      body: JSON.stringify({ session_id: sessionId, message: 'สรุป' }),
    });
    await send(sessionId, 'สรุป');
    const before = provider.seen.at(-1)!.history.length;

    await streamEvents(await POST(withCap));
    const after = provider.seen.at(-1)!.history.length;

    // The override trims to 2 stored messages plus the current question.
    expect(after).toBeLessThan(before);
  });

  it('ignores a nonsense ?history value and uses the configured cap', async () => {
    await seedProducts(1);
    const provider = scriptedProvider([{ text: 'ได้ครับ', toolCalls: [], finishReason: 'stop' }]);
    setLlmForTesting(provider);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const sessionId = await newSessionId();
    for (let i = 0; i < 4; i += 1) await send(sessionId, `คำถาม ${i}`);

    const before = provider.seen.at(-1)!.history.length;

    const bogus = new Request('http://localhost/api/chat?history=abc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.56' },
      body: JSON.stringify({ session_id: sessionId, message: 'อีกครั้ง' }),
    });
    await streamEvents(await POST(bogus));

    // The turn stored two more messages, so a full (untrimmed) history is
    // exactly two longer than before. A wrongly-parsed tiny cap would be far
    // below that, which is what this is here to catch.
    expect(provider.seen.at(-1)!.history.length).toBe(before + 2);
  });
});
