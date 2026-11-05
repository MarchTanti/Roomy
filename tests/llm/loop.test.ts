/**
 * Tool-use loop tests. No network: the provider is a fake, so this runs in CI
 * and proves the loop, the executors, and the persistence shape.
 *
 * These cover the exact code path /api/chat uses, which is how the loop was
 * debugged after a 500 in the live route.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getDb, resetDb } from '@/lib/db';
import { resetLlm, setRoomAnalyzerForTesting } from '@/lib/llm';
import { runToolLoop, extractUserText, type ToolContext } from '@/lib/llm/loop';
import { TOOL_SPECS, executeToolCall } from '@/lib/llm/tools';
import { buildSystemInstruction, serializeSessionState } from '@/lib/llm/prompt';
import { emptySessionState, type Json, type Session } from '@/lib/db/types';
import { resetPhotoStore, setPhotoStoreForTesting, type PhotoStore } from '@/lib/storage';
import type { LlmMessage, LlmProvider, LlmStepInput, LlmStepResult } from '@/lib/llm/types';
import { isLlmMessage } from '@/lib/llm/history';

/** A scripted provider: returns queued steps in order, then repeats the last. */
function fakeProvider(steps: LlmStepResult[]): LlmProvider & { calls: LlmStepInput[] } {
  let index = 0;
  const calls: LlmStepInput[] = [];
  return {
    id: 'fake',
    calls,
    async runStep(input: LlmStepInput): Promise<LlmStepResult> {
      calls.push(input);
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      return step;
    },
  };
}

const STOP: LlmStepResult = { text: 'เสร็จแล้วครับ', toolCalls: [], finishReason: 'stop' };

// --- analyzeRoom fixtures ---------------------------------------------------

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const IMAGE_ID = '22222222-2222-4222-8222-222222222222';
const STORAGE_PATH = `${SESSION_ID}/${IMAGE_ID}.jpg`;

/**
 * A tool context with one room photo already recorded, via the real local
 * adapter — so `getImage` resolves the same way it does in production.
 */
async function contextFor(state: Partial<Session['state']>): Promise<ToolContext> {
  const image = await getDb().addImage({
    session_id: SESSION_ID,
    kind: 'room',
    storage_path: STORAGE_PATH,
  });
  return {
    db: getDb(),
    session: {
      id: SESSION_ID,
      state: { ...emptySessionState(), ...state, room_image_id: image.id },
      image_quota_left: 10,
      created_at: '2026-01-01T00:00:00.000Z',
    },
  };
}

function stubStore(bytes: string): PhotoStore {
  return {
    id: 'local',
    async put() {
      throw new Error('put() is not used in these tests');
    },
    async get() {
      return Buffer.from(bytes);
    },
    async remove() {},
  };
}

describe('tool-use loop', () => {
  beforeEach(() => {
    resetDb();
    resetLlm();
    resetPhotoStore();
  });

  afterEach(() => {
    resetDb();
    resetLlm();
    resetPhotoStore();
    setRoomAnalyzerForTesting(null);
    setPhotoStoreForTesting(null);
  });

  it('returns plain text in one iteration when no tool is called', async () => {
    const provider = fakeProvider([STOP]);
    const result = await runToolLoop({
      provider,
      history: [{ role: 'user', parts: [{ kind: 'text', text: 'สวัสดี' }] }],
      systemInstruction: 'sys',
      tools: TOOL_SPECS,
      executeTool: executeToolCall,
    });

    expect(result.text).toBe('เสร็จแล้วครับ');
    expect(result.toolCalls).toHaveLength(0);
    expect(result.iterations).toBe(1);
    expect(result.hitIterationCap).toBe(false);
  });

  it('runs a tool, feeds the result back, and returns the final text', async () => {
    const provider = fakeProvider([
      {
        text: 'กำลังหาให้นะครับ',
        toolCalls: [{ id: null, name: 'searchFurniture', args: { category: 'sofa' } }],
        finishReason: 'stop',
      },
      { text: 'เจอแล้วครับ มีโซฟาหลายตัว', toolCalls: [], finishReason: 'stop' },
    ]);

    const result = await runToolLoop({
      provider,
      history: [{ role: 'user', parts: [{ kind: 'text', text: 'อยากได้โซฟา' }] }],
      systemInstruction: 'sys',
      tools: TOOL_SPECS,
      executeTool: executeToolCall,
    });

    expect(result.iterations).toBe(2);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe('searchFurniture');
    // The preamble from iteration 1 is replaced by the final answer.
    expect(result.text).toBe('เจอแล้วครับ มีโซฟาหลายตัว');

    // The history must contain a model toolCall (carrying its text preamble)
    // followed by a user toolResult.
    const kinds = result.history.map((m) => `${m.role}:${m.parts.map((p) => p.kind).join('+')}`);
    expect(kinds).toEqual(['user:text', 'model:text+toolCall', 'user:toolResult', 'model:text']);
  });

  it('persists every produced message as valid JSON rows', async () => {
    const session = await getDb().createSession();
    const provider = fakeProvider([
      {
        text: '',
        toolCalls: [{ id: null, name: 'searchFurniture', args: { category: 'bed', limit: 2 } }],
        finishReason: 'stop',
      },
      STOP,
    ]);

    const result = await runToolLoop({
      provider,
      history: [{ role: 'user', parts: [{ kind: 'text', text: 'เตียง' }] }],
      systemInstruction: 'sys',
      tools: TOOL_SPECS,
      executeTool: executeToolCall,
    });

    for (const message of result.history) {
      await getDb().addMessage(session.id, {
        role: message.role === 'model' ? 'assistant' : 'user',
        content: message as unknown as Json,
      });
    }

    const stored = await getDb().listMessages(session.id);
    expect(stored).toHaveLength(result.history.length);
    // Every row must survive the type guard used when rebuilding history.
    for (const row of stored) expect(isLlmMessage(row.content)).toBe(true);
  });

  it('stops at the iteration cap instead of looping forever', async () => {
    // Always asks for a tool → would loop indefinitely.
    const provider = fakeProvider([
      {
        text: '',
        toolCalls: [{ id: null, name: 'searchFurniture', args: {} }],
        finishReason: 'stop',
      },
    ]);

    const result = await runToolLoop({
      provider,
      history: [{ role: 'user', parts: [{ kind: 'text', text: 'หาไม่จบ' }] }],
      systemInstruction: 'sys',
      tools: TOOL_SPECS,
      executeTool: executeToolCall,
      maxIterations: 3,
    });

    expect(result.hitIterationCap).toBe(true);
    expect(result.iterations).toBe(3);
    expect(result.toolCalls).toHaveLength(3);
  });

  it('returns a tool error as data rather than throwing', async () => {
    const provider = fakeProvider([
      {
        text: '',
        toolCalls: [{ id: null, name: 'nopeNotATool', args: {} }],
        finishReason: 'stop',
      },
      STOP,
    ]);

    const result = await runToolLoop({
      provider,
      history: [{ role: 'user', parts: [{ kind: 'text', text: 'x' }] }],
      systemInstruction: 'sys',
      tools: TOOL_SPECS,
      executeTool: executeToolCall,
    });

    const toolResult = result.history.find((m) => m.parts.some((p) => p.kind === 'toolResult'));
    const part = toolResult?.parts.find((p) => p.kind === 'toolResult');
    expect(part).toBeDefined();
    if (part?.kind === 'toolResult') {
      expect(part.result).toMatchObject({ error: 'unknown_tool', requested: 'nopeNotATool' });
    }
  });

  it('extractUserText reads the leading user message', () => {
    const history: LlmMessage[] = [{ role: 'user', parts: [{ kind: 'text', text: '  ห้องเล็ก  ' }] }];
    expect(extractUserText(history)).toBe('ห้องเล็ก');
    expect(extractUserText([])).toBe('');
  });
});

describe('a turn the model could not finish', () => {
  beforeEach(() => {
    resetDb();
    resetLlm();
  });

  afterEach(() => {
    resetDb();
    resetLlm();
  });

  /**
   * The empty answer.
   *
   * When the model's output budget runs out while it is still thinking, it
   * comes back with neither text nor a tool call. The user must not be left
   * with an empty bubble, and the caller must be able to tell that nothing was
   * actually said.
   */
  it('says something and admits the answer was cut off', async () => {
    const provider = fakeProvider([{ text: '', toolCalls: [], finishReason: 'max_tokens' }]);

    const result = await runToolLoop({
      provider,
      history: [{ role: 'user', parts: [{ kind: 'text', text: 'ห้องนอน 24 ตร.ม.' }] }],
      systemInstruction: 'sys',
      tools: TOOL_SPECS,
      executeTool: executeToolCall,
    });

    expect(result.text.trim()).not.toBe('');
    expect(result.truncated).toBe(true);
  });

  it('does not pass off a preamble as the answer', async () => {
    // The model opens with "กำลังหาให้นะครับ", calls a tool, and then the
    // step that should carry the answer comes back empty. The preamble is not
    // an answer, so the loop has to say so rather than hand it over.
    const provider = fakeProvider([
      {
        text: 'กำลังหาให้นะครับ',
        toolCalls: [{ id: null, name: 'searchFurniture', args: {} }],
        finishReason: 'stop',
      },
      { text: '', toolCalls: [], finishReason: 'max_tokens' },
    ]);

    const result = await runToolLoop({
      provider,
      history: [{ role: 'user', parts: [{ kind: 'text', text: 'หาโซฟาให้หน่อย' }] }],
      systemInstruction: 'sys',
      tools: TOOL_SPECS,
      executeTool: executeToolCall,
    });

    expect(result.text).not.toContain('กำลังหาให้นะครับ');
    expect(result.truncated).toBe(true);
  });

  it('apologises when the answer was blocked', async () => {
    const provider = fakeProvider([{ text: '', toolCalls: [], finishReason: 'safety' }]);

    const result = await runToolLoop({
      provider,
      history: [{ role: 'user', parts: [{ kind: 'text', text: '...' }] }],
      systemInstruction: 'sys',
      tools: TOOL_SPECS,
      executeTool: executeToolCall,
    });

    expect(result.text).toContain('ขออภัย');
    expect(result.truncated).toBe(true);
  });

  it('leaves an ordinary answer alone', async () => {
    const provider = fakeProvider([STOP]);

    const result = await runToolLoop({
      provider,
      history: [{ role: 'user', parts: [{ kind: 'text', text: 'สวัสดี' }] }],
      systemInstruction: 'sys',
      tools: TOOL_SPECS,
      executeTool: executeToolCall,
    });

    expect(result.text).toBe('เสร็จแล้วครับ');
    expect(result.truncated).toBe(false);
  });

  it('says something when the summary after the iteration cap is empty too', async () => {
    // Always asks for a tool, so the loop runs out of iterations and then
    // asks for a plain-text summary — which comes back empty as well.
    const provider = fakeProvider([
      { text: '', toolCalls: [{ id: null, name: 'searchFurniture', args: {} }], finishReason: 'stop' },
    ]);

    const result = await runToolLoop({
      provider,
      history: [{ role: 'user', parts: [{ kind: 'text', text: 'หาไม่จบ' }] }],
      systemInstruction: 'sys',
      tools: TOOL_SPECS,
      executeTool: executeToolCall,
      maxIterations: 2,
    });

    expect(result.hitIterationCap).toBe(true);
    expect(result.text.trim()).not.toBe('');
    expect(result.truncated).toBe(true);
  });
});

describe('searchFurniture executor', () => {
  beforeEach(() => {
    resetDb();
  });

  it('returns real rows from the catalog with prices and dimensions', async () => {
    const result = await executeToolCall({
      id: null,
      name: 'searchFurniture',
      args: { category: 'sofa', limit: 3 },
    });

    expect(result).toMatchObject({ count: expect.any(Number) });
    const products = (result as { products: { id: string; price_thb: number; width_cm: number }[] })
      .products;
    expect(products.length).toBeGreaterThan(0);
    for (const p of products) {
      expect(p.price_thb).toBeGreaterThan(0);
      expect(p.width_cm).toBeGreaterThan(0);
    }
  });

  it('filters by style', async () => {
    const result = (await executeToolCall({
      id: null,
      name: 'searchFurniture',
      args: { style: 'scandinavian', limit: 5 },
    })) as { products: { style_tags: string[] }[] };

    expect(result.products.length).toBeGreaterThan(0);
    for (const p of result.products) {
      expect(p.style_tags.join(',')).toContain('scandinavian');
    }
  });

  it('rejects a bad limit with a field-level error object', async () => {
    const result = await executeToolCall({
      id: null,
      name: 'searchFurniture',
      args: { limit: 999 },
    });
    expect(result).toMatchObject({ error: 'invalid_arguments' });
    expect(JSON.stringify(result)).toContain('limit');
  });

  it('defaults in_stock_only to true', async () => {
    const result = (await executeToolCall({
      id: null,
      name: 'searchFurniture',
      args: { category: 'sofa', limit: 12 },
    })) as { products: { in_stock: boolean }[] };
    for (const p of result.products) expect(p.in_stock).toBe(true);
  });
});

describe('analyzeRoom', () => {
  /**
   * The upload route analyses the photo and stores the result, so this tool is
   * the "look again" path. What matters is that every way it can be wrong comes
   * back as readable data the model can route around — not a thrown error, and
   * not a hallucinated analysis.
   */
  beforeEach(() => {
    resetDb();
    resetLlm();
    resetPhotoStore();
  });

  afterEach(() => {
    resetDb();
    resetLlm();
    setRoomAnalyzerForTesting(null);
    setPhotoStoreForTesting(null);
  });

  it('says so plainly when it has no session to work with', async () => {
    const result = await executeToolCall({ id: null, name: 'analyzeRoom', args: {} });
    expect(result).toMatchObject({ error: 'unavailable' });
    expect(JSON.stringify(result)).toContain('อัปโหลดรูปห้อง');
  });

  it('tells the model to ask for a photo when the session has none', async () => {
    const result = await executeToolCall(
      { id: null, name: 'analyzeRoom', args: {} },
      {
        db: getDb(),
        session: {
          id: SESSION_ID,
          state: emptySessionState(),
          image_quota_left: 10,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      },
    );
    expect(result).toMatchObject({ error: 'no_room_photo' });
    expect(JSON.stringify(result)).toContain('อัปโหลดรูปห้อง');
  });

  it('reports an unknown image id instead of analysing nothing', async () => {
    const context = await contextFor({});
    const result = await executeToolCall(
      { id: null, name: 'analyzeRoom', args: { image_id: '33333333-3333-4333-8333-333333333333' } },
      context,
    );
    expect(result).toMatchObject({ error: 'image_not_found' });
  });

  it('validates its arguments before touching storage', async () => {
    const result = await executeToolCall(
      { id: null, name: 'analyzeRoom', args: { image_id: '' } },
      await contextFor({}),
    );
    expect(result).toMatchObject({ error: 'invalid_arguments' });
  });

  it('analyses the session photo when no id is given', async () => {
    const analyzed: string[] = [];
    setRoomAnalyzerForTesting({
      id: 'stub',
      async analyze(b64) {
        analyzed.push(b64);
        return { style: 'japandi', colors: ['สีขาว'], lighting: 'แสงธรรมชาติ' };
      },
    });
    setPhotoStoreForTesting(stubStore('jpeg-bytes'));

    const context = await contextFor({});
    const result = await executeToolCall({ id: null, name: 'analyzeRoom', args: {} }, context);

    expect(result).toMatchObject({ style: 'japandi' });
    // Raw bytes as inlineData — never a signed URL, which would export a
    // capability token to the model provider.
    expect(analyzed).toEqual([Buffer.from('jpeg-bytes').toString('base64')]);
  });

  it('turns a vision failure into guidance rather than an error frame', async () => {
    setRoomAnalyzerForTesting({
      id: 'stub',
      analyze: () => Promise.reject(new Error('Gemini vision request failed')),
    });
    setPhotoStoreForTesting(stubStore('x'));

    const result = await executeToolCall(
      { id: null, name: 'analyzeRoom', args: {} },
      await contextFor({}),
    );

    expect(result).toMatchObject({ error: 'analysis_failed' });
    // The model needs a next move, not just a failure code.
    expect(JSON.stringify(result)).toContain('guidance');
  });

  it('hands the session id down so the store can enforce ownership', async () => {
    const readSession: (string | undefined)[] = [];
    setPhotoStoreForTesting({
      id: 'local',
      async put() {
        throw new Error('not used');
      },
      async get(_p, session) {
        readSession.push(session);
        return Buffer.from('x');
      },
      async remove() {},
    });
    setRoomAnalyzerForTesting({
      id: 'stub',
      analyze: () => Promise.resolve({ style: 'x', colors: ['y'], lighting: 'z' }),
    });

    const context = await contextFor({});
    await executeToolCall({ id: null, name: 'analyzeRoom', args: {} }, context);

    // The storage path is a capability: the tool must not hand it over without
    // saying who is asking.
    expect(readSession).toEqual([SESSION_ID]);
  });
});

// `checkFit` has its own file — `tests/llm/tools-fit.test.ts` — because what it
// has to prove is where each number comes from, not that the loop can call it.

describe('session state serialisation', () => {
  it('emits exactly the fields the spec defines', () => {
    const state = emptySessionState();
    const parsed = JSON.parse(serializeSessionState(state)) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'generated_image_ids',
        'preferences',
        'reference_cm',
        'reference_line',
        'room_analysis',
        'room_image_id',
        'selected_area',
        'selected_product_id',
        'shown_products',
      ].sort(),
    );
  });

  it('folds the current state into the system instruction', () => {
    const state = emptySessionState();
    state.preferences.style = 'scandinavian';
    const instruction = buildSystemInstruction(state);
    expect(instruction).toContain('scandinavian');
    expect(instruction).toContain('ราคาและขนาดต้องมาจากฐานข้อมูลเท่านั้น');
  });
});