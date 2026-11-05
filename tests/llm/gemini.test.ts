/**
 * Gemini adapter tests — no network.
 *
 * The SDK client is replaced with a recorder, so these assert on the exact
 * request objects the adapter builds. That matters for one case in particular:
 * Gemini returns an opaque `thoughtSignature` alongside each `functionCall` and
 * rejects any later request whose functionCall lacks it (HTTP 400). Losing that
 * field produces a confusing failure — the *first* turn succeeds, the model
 * visibly asks for a tool, and only the follow-up request dies. These tests
 * make the round trip explicit so it cannot silently regress.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

import type { LlmPart, LlmMessage } from '@/lib/llm/types';

const h = vi.hoisted(() => ({
  seen: [] as unknown[],
  responses: [] as Record<string, unknown>[],
  streamChunks: [] as Record<string, unknown>[],
  streamError: null as Error | null,
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (request: unknown) => {
        h.seen.push(request);
        return h.responses[Math.min(h.seen.length - 1, h.responses.length - 1)];
      },
      generateContentStream: async (request: unknown) => {
        h.seen.push(request);
        if (h.streamError) throw h.streamError;
        const chunks = h.streamChunks;
        return (async function* () {
          for (const chunk of chunks) yield chunk;
        })();
      },
    };
  },
}));

const { createGeminiProvider } = await import('@/lib/llm/gemini');
const { runToolLoop } = await import('@/lib/llm/loop');
const { userText } = await import('@/lib/llm/types');

const SIGNATURE = 'Cq0BdGh0U2lnbmF0dXJlLXBsYWNlaG9sZGVy';

/**
 * Mirrors the real response object: `.text` is a getter that concatenates the
 * text parts, so a plain `text` property would not exercise the same path.
 */
function modelResponse(parts: unknown[], finishReason = 'STOP', usageMetadata?: unknown) {
  const text = parts
    .filter((p): p is { text: string } => typeof (p as { text?: unknown }).text === 'string')
    .map((p) => p.text)
    .join('');
  return {
    text,
    candidates: [{ content: { role: 'model', parts }, finishReason }],
    ...(usageMetadata ? { usageMetadata } : {}),
  };
}

/** The shape of the second request: `contents` is what we actually sent. */
function contentsOf(index: number): { role: string; parts: Record<string, unknown>[] }[] {
  const request = h.seen[index] as { contents: { role: string; parts: Record<string, unknown>[] }[] };
  return request.contents;
}

beforeEach(() => {
  h.seen.length = 0;
  h.responses.length = 0;
  h.streamChunks = [];
  h.streamError = null;
});

describe('gemini adapter: thought signatures', () => {
  it('carries the signature off the functionCall part', async () => {
    h.responses.push(
      modelResponse([
        { text: 'กำลังหาให้ครับ' },
        { functionCall: { name: 'searchFurniture', args: { category: 'sofa' } }, thoughtSignature: SIGNATURE },
      ]),
    );

    const provider = createGeminiProvider('test-key');
    const step = await provider.runStep({
      history: [userText('อยากได้โซฟา')],
      systemInstruction: 'sys',
      tools: [],
    });

    expect(step.toolCalls).toEqual([
      { id: null, name: 'searchFurniture', args: { category: 'sofa' }, signature: SIGNATURE },
    ]);
  });

  it('echoes the signature back on the next request', async () => {
    h.responses.push(
      modelResponse([
        { functionCall: { name: 'searchFurniture', args: { category: 'sofa' } }, thoughtSignature: SIGNATURE },
      ]),
      modelResponse([{ text: 'เจอสองตัวครับ' }]),
    );

    const provider = createGeminiProvider('test-key');
    await runToolLoop({
      provider,
      history: [userText('อยากได้โซฟา')],
      systemInstruction: 'sys',
      tools: [],
      executeTool: async () => ({ count: 0, products: [] }),
    });

    expect(h.seen).toHaveLength(2);

    // The functionCall part must carry the signature on the same part — this is
    // the assertion that was missing when the API answered 400.
    const modelParts = contentsOf(1)[1].parts;
    const callPart = modelParts.find((p) => p.functionCall !== undefined);
    expect(callPart).toBeDefined();
    expect(callPart?.functionCall).toEqual({ name: 'searchFurniture', args: { category: 'sofa' } });
    expect(callPart?.thoughtSignature).toBe(SIGNATURE);
  });

  it('omits the key entirely when the model sent no signature', async () => {
    // Hand-built history with no signature — we must not invent an empty one,
    // because Gemini treats a present-but-blank signature differently from an
    // absent one.
    h.responses.push(modelResponse([{ text: 'ครับ' }]));
    await createGeminiProvider('test-key').runStep({
      history: [
        userText('โซฟา'),
        {
          role: 'model',
          parts: [{ kind: 'toolCall', call: { id: null, name: 'searchFurniture', args: {} } }],
        },
        {
          role: 'user',
          parts: [{ kind: 'toolResult', callId: 'searchFurniture', name: 'searchFurniture', result: {} }],
        },
      ],
      systemInstruction: 'sys',
      tools: [],
    });

    const parts = contentsOf(0).flatMap((c) => c.parts);
    const calls = parts.filter((p) => p.functionCall !== undefined);
    expect(calls).toHaveLength(1);
    expect(calls.some((p) => 'thoughtSignature' in p)).toBe(false);
  });

  it('reads the provider id when the functionCall carries one', async () => {
    h.responses.push(modelResponse([{ functionCall: { id: 'fc-1', name: 'checkFit', args: {} } }]));

    const step = await createGeminiProvider('test-key').runStep({
      history: [userText('พอดีไหม')],
      systemInstruction: 'sys',
      tools: [],
    });

    expect(step.toolCalls[0].id).toBe('fc-1');
    expect(step.toolCalls[0].signature).toBeUndefined();
  });

  it('ignores non-functionCall parts', async () => {
    h.responses.push(
      modelResponse([
        { text: 'คำตอบปกติ' },
        { inlineData: { mimeType: 'text/plain', data: 'aGk=' } },
      ]),
    );

    const step = await createGeminiProvider('test-key').runStep({
      history: [userText('สวัสดี')],
      systemInstruction: 'sys',
      tools: [],
    });

    expect(step.toolCalls).toEqual([]);
    expect(step.text).toBe('คำตอบปกติ');
  });
});

describe('gemini adapter: message shaping', () => {
  it('sends tool results as a user-role message', async () => {
    h.responses.push(modelResponse([{ text: 'สรุปแล้ว' }]));

    const history: LlmMessage[] = [
      userText('อยากได้โซฟา'),
      {
        role: 'model',
        parts: [{ kind: 'toolCall', call: { id: null, name: 'searchFurniture', args: {}, signature: SIGNATURE } }],
      },
      {
        role: 'user',
        parts: [{ kind: 'toolResult', callId: 'searchFurniture', name: 'searchFurniture', result: { count: 1 } }],
      },
    ];

    await createGeminiProvider('test-key').runStep({
      history,
      systemInstruction: 'sys',
      tools: [],
    });

    const contents = contentsOf(0);
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    expect(contents[2].parts[0].functionResponse).toEqual({
      name: 'searchFurniture',
      response: { count: 1 },
    });
  });

  it('wraps a non-object tool result so Gemini accepts it', async () => {
    h.responses.push(modelResponse([{ text: 'ครับ' }]));

    const parts: LlmPart[] = [{ kind: 'toolResult', callId: 'x', name: 'searchFurniture', result: null }];
    await createGeminiProvider('test-key').runStep({
      history: [
        userText('โซฟา'),
        { role: 'user', parts },
      ],
      systemInstruction: 'sys',
      tools: [],
    });

    expect(contentsOf(0)[1].parts[0].functionResponse).toEqual({
      name: 'searchFurniture',
      response: { result: null },
    });
  });

  it('passes the system instruction and tool declarations through', async () => {
    h.responses.push(modelResponse([{ text: 'ครับ' }]));

    await createGeminiProvider('test-key').runStep({
      history: [userText('สวัสดี')],
      systemInstruction: 'กฎของระบบ',
      tools: [
        {
          name: 'searchFurniture',
          description: 'ค้นหา',
          parameters: {
            type: 'object',
            properties: { category: { type: 'string', description: 'หมวดหมู่' } },
          },
        },
      ],
    });

    const request = h.seen[0] as {
      config: {
        systemInstruction: string;
        tools: { functionDeclarations: { name: string; parametersJsonSchema: unknown }[] }[];
      };
    };
    expect(request.config.systemInstruction).toBe('กฎของระบบ');
    expect(request.config.tools[0].functionDeclarations[0].name).toBe('searchFurniture');
    // Full JSON Schema, not the OpenAPI subset.
    expect(request.config.tools[0].functionDeclarations[0].parametersJsonSchema).toEqual({
      type: 'object',
      properties: { category: { type: 'string', description: 'หมวดหมู่' } },
    });
  });

  it('refuses to run with an empty history', async () => {
    await expect(
      createGeminiProvider('test-key').runStep({
        history: [],
        systemInstruction: 'sys',
        tools: [],
      }),
    ).rejects.toThrow('history is empty');
  });
});

describe('gemini adapter: the output budget', () => {
  it('leaves room for the answer after the model has thought', async () => {
    // Gemini 3 counts a thought token against the same budget as a written
    // one. At 1,024 the model spent ~980 tokens thinking and had nothing left
    // to write with, so the turn came back empty — every answer after the
    // first one in a session was blank. The budget has to cover both.
    h.responses.push(modelResponse([{ text: 'ครับ' }]));

    await createGeminiProvider('test-key').runStep({
      history: [userText('สวัสดี')],
      systemInstruction: 'sys',
      tools: [],
    });

    const request = h.seen[0] as { config: { maxOutputTokens: number } };
    expect(request.config.maxOutputTokens).toBe(4096);
  });
});

describe('gemini adapter: streaming', () => {
  /** The fake client has to hand back an async generator, not a response. */
  function stubStream(chunks: Record<string, unknown>[]) {
    h.streamChunks = chunks;
  }

  it('emits deltas and returns the same result as runStep would', async () => {
    stubStream([
      modelResponse([{ text: 'เจอสองตัว' }]),
      modelResponse([{ text: 'สไตล์สแกน' }]),
      modelResponse([{ text: 'ดินาเวียครับ' }]),
    ]);

    const deltas: string[] = [];
    const step = await createGeminiProvider('test-key').runStepStream!(
      { history: [userText('โซฟา')], systemInstruction: 'sys', tools: [] },
      (d) => deltas.push(d),
    );

    expect(deltas).toEqual(['เจอสองตัว', 'สไตล์สแกน', 'ดินาเวียครับ']);
    expect(step.text).toBe('เจอสองตัวสไตล์สแกนดินาเวียครับ');
    expect(step.toolCalls).toEqual([]);
    expect(step.finishReason).toBe('stop');
  });

  it('collects a function call that arrives in a later chunk', async () => {
    stubStream([
      modelResponse([{ text: 'กำลังหา' }]),
      modelResponse([
        { functionCall: { name: 'searchFurniture', args: { category: 'sofa' } }, thoughtSignature: SIGNATURE },
      ]),
    ]);

    const step = await createGeminiProvider('test-key').runStepStream!(
      { history: [userText('โซฟา')], systemInstruction: 'sys', tools: [] },
      () => undefined,
    );

    expect(step.text).toBe('กำลังหา');
    expect(step.toolCalls[0].name).toBe('searchFurniture');
    expect(step.toolCalls[0].signature).toBe(SIGNATURE);
  });

  it('keeps the model reasoning out of the deltas', async () => {
    // Streaming delivers thought parts too; the non-streaming `.text` getter
    // filters them and streaming has to match, or the reasoning shows up in the
    // chat bubble.
    stubStream([
      modelResponse([
        { text: 'internal reasoning', thought: true },
        { text: 'คำตอบจริง' },
      ]),
    ]);

    const deltas: string[] = [];
    const step = await createGeminiProvider('test-key').runStepStream!(
      { history: [userText('โซฟา')], systemInstruction: 'sys', tools: [] },
      (d) => deltas.push(d),
    );

    expect(deltas).toEqual(['คำตอบจริง']);
    expect(step.text).toBe('คำตอบจริง');
  });

  it('reports a failure mid-stream as an LlmError', async () => {
    h.streamError = new Error('connection reset');
    stubStream([]);

    await expect(
      createGeminiProvider('test-key').runStepStream!(
        { history: [userText('โซฟา')], systemInstruction: 'sys', tools: [] },
        () => undefined,
      ),
    ).rejects.toThrow('connection reset');
  });
});
describe('gemini adapter: usage reporting', () => {
  const USAGE = { promptTokenCount: 1240, candidatesTokenCount: 210, thoughtsTokenCount: 900 };

  it('reports usage from a non-streaming response', async () => {
    h.responses.push(modelResponse([{ text: 'ครับ' }], 'STOP', USAGE));

    const step = await createGeminiProvider('test-key').runStep({
      history: [userText('สวัสดี')],
      systemInstruction: 'sys',
      tools: [],
    });

    expect(step.usage).toEqual({ promptTokens: 1240, outputTokens: 210, thoughtTokens: 900 });
  });

  it('reports usage from the last streaming chunk that carries it', async () => {
    h.streamChunks = [modelResponse([{ text: 'ครั' }]), modelResponse([{ text: 'บ' }], 'STOP', USAGE)];

    const step = await createGeminiProvider('test-key').runStepStream!(
      { history: [userText('สวัสดี')], systemInstruction: 'sys', tools: [] },
      () => undefined,
    );

    expect(step.usage).toEqual({ promptTokens: 1240, outputTokens: 210, thoughtTokens: 900 });
  });

  it('leaves usage undefined when the provider sends none', async () => {
    h.responses.push(modelResponse([{ text: 'ครับ' }]));

    const step = await createGeminiProvider('test-key').runStep({
      history: [userText('สวัสดี')],
      systemInstruction: 'sys',
      tools: [],
    });

    expect(step.usage).toBeUndefined();
  });
});
