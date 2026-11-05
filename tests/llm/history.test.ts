import { describe, expect, it } from 'vitest';

import { dropUnsignedToolCalls, isLlmMessage, trimHistory } from '@/lib/llm/history';
import type { LlmMessage } from '@/lib/llm/types';

const SIGNATURE = 'Cq0BdGh0U2ln';

function toolCall(name: string, signature?: string, id: string | null = null) {
  return { kind: 'toolCall' as const, call: { id, name, args: {}, signature } };
}

function shape(history: readonly LlmMessage[]): string[] {
  return history.map((m) =>
    m.parts
      .map((p) => {
        if (p.kind === 'text') return `${m.role}:text`;
        if (p.kind === 'toolCall') return `${m.role}:call(${p.call.name})`;
        return `${m.role}:result(${p.name})`;
      })
      .join('+'),
  );
}

const text = (t: string, role: 'user' | 'model'): LlmMessage => ({ role, parts: [{ kind: 'text', text: t }] });

/**
 * True when Gemini would accept this sequence.
 *
 * The API requires a `functionCall` turn to sit immediately after a user turn or
 * after a `functionResponse` turn, and rejects the whole request otherwise with
 * "function call turn comes immediately after a user turn or after a function
 * response turn". Mirrors that rule here so the trimming tests assert on the
 * property that matters rather than on one hand-picked outcome.
 */
function isLegal(history: readonly LlmMessage[]): boolean {
  if (history.length === 0) return true;

  const isCall = (m: LlmMessage) => m.role === 'model' && m.parts.some((p) => p.kind === 'toolCall');
  const isResult = (m: LlmMessage) =>
    m.role === 'user' && m.parts.length > 0 && m.parts.every((p) => p.kind === 'toolResult');

  // Nothing may precede the first message, so it cannot be a call.
  if (isCall(history[0])) return false;

  for (let i = 1; i < history.length; i += 1) {
    const message = history[i];
    const previous = history[i - 1];
    // "after a user turn or after a function response turn" — both are the
    // user role in our shape, since tool results ride on the user turn.
    if (isCall(message) && previous.role !== 'user') return false;
    if (isResult(message) && !previous.parts.some((p) => p.kind === 'toolCall')) return false;
  }
  return true;
}

describe('dropUnsignedToolCalls', () => {
  it('removes the call and its orphaned result, keeping the conversation', () => {
    const history: LlmMessage[] = [
      { role: 'user', parts: [{ kind: 'text', text: 'อยากได้โซฟา' }] },
      { role: 'model', parts: [{ kind: 'text', text: 'หาให้ครับ' }, toolCall('searchFurniture')] },
      { role: 'user', parts: [{ kind: 'toolResult', callId: 'searchFurniture', name: 'searchFurniture', result: {} }] },
      { role: 'model', parts: [{ kind: 'text', text: 'เจอสองตัวครับ' }] },
    ];

    const kept = dropUnsignedToolCalls(history);

    // The orphaned result goes too, or we send a functionResponse the model
    // never asked for. What survives is the plain conversation.
    expect(shape(kept)).toEqual(['user:text', 'model:text', 'model:text']);
    expect(kept.some((m) => m.parts.some((p) => p.kind === 'toolResult'))).toBe(false);
  });

  it('drops a model message that was nothing but the call', () => {
    const history: LlmMessage[] = [
      { role: 'user', parts: [{ kind: 'text', text: 'โซฟา' }] },
      { role: 'model', parts: [toolCall('searchFurniture')] },
      { role: 'model', parts: [{ kind: 'text', text: 'ครับ' }] },
    ];

    const kept = dropUnsignedToolCalls(history);
    expect(shape(kept)).toEqual(['user:text', 'model:text']);
  });

  it('matches the orphaned result by provider id when there is one', () => {
    const history: LlmMessage[] = [
      { role: 'model', parts: [toolCall('checkFit', undefined, 'fc-7')] },
      { role: 'user', parts: [{ kind: 'toolResult', callId: 'fc-7', name: 'checkFit', result: {} }] },
    ];

    expect(dropUnsignedToolCalls(history)).toEqual([]);
  });

  it('leaves signed calls alone', () => {
    const history: LlmMessage[] = [
      { role: 'user', parts: [{ kind: 'text', text: 'โซฟา' }] },
      { role: 'model', parts: [toolCall('searchFurniture', SIGNATURE)] },
      { role: 'user', parts: [{ kind: 'toolResult', callId: 'searchFurniture', name: 'searchFurniture', result: {} }] },
    ];

    expect(shape(dropUnsignedToolCalls(history))).toEqual([
      'user:text',
      'model:call(searchFurniture)',
      'user:result(searchFurniture)',
    ]);
  });

  it('keeps a result whose call survived, even mid-conversation', () => {
    const history: LlmMessage[] = [
      { role: 'model', parts: [toolCall('a'), toolCall('b', SIGNATURE)] },
      {
        role: 'user',
        parts: [
          { kind: 'toolResult', callId: 'a', name: 'a', result: {} },
          { kind: 'toolResult', callId: 'b', name: 'b', result: {} },
        ],
      },
    ];

    expect(shape(dropUnsignedToolCalls(history))).toEqual(['model:call(b)', 'user:result(b)']);
  });

  it('never emits a message with no parts', () => {
    const history: LlmMessage[] = [
      { role: 'model', parts: [toolCall('a')] },
      { role: 'user', parts: [{ kind: 'toolResult', callId: 'a', name: 'a', result: {} }] },
    ];

    expect(dropUnsignedToolCalls(history)).toEqual([]);
  });

  it('is a no-op on a plain text conversation', () => {
    const history: LlmMessage[] = [
      { role: 'user', parts: [{ kind: 'text', text: 'สวัสดี' }] },
      { role: 'model', parts: [{ kind: 'text', text: 'สวัสดีครับ' }] },
    ];
    expect(dropUnsignedToolCalls(history)).toEqual(history);
  });
});

describe('isLlmMessage', () => {
  it('accepts a stored turn that carries a signature', () => {
    const stored = {
      role: 'model',
      parts: [{ kind: 'toolCall', call: { id: null, name: 'searchFurniture', args: {}, signature: SIGNATURE } }],
    };
    expect(isLlmMessage(stored)).toBe(true);
  });

  it('rejects rows that are not our shape', () => {
    expect(isLlmMessage(null)).toBe(false);
    expect(isLlmMessage('hello')).toBe(false);
    expect(isLlmMessage({ role: 'assistant', parts: [] })).toBe(false);
    expect(isLlmMessage({ role: 'model', parts: [{ kind: 'unknown' }] })).toBe(false);
    expect(isLlmMessage({ role: 'model', parts: [{ kind: 'toolCall', call: {} }] })).toBe(false);
  });
});
describe('trimHistory', () => {
  const roundTrip: LlmMessage[] = [
    text('อยากได้โซฟา', 'user'),
    { role: 'model', parts: [toolCall('searchFurniture', SIGNATURE)] },
    { role: 'user', parts: [{ kind: 'toolResult', callId: 'searchFurniture', name: 'searchFurniture', result: {} }] },
    text('มีสองตัวครับ', 'model'),
  ];

  it('leaves a short conversation alone', () => {
    const history = [text('สวัสดี', 'user'), text('สวัสดีครับ', 'model')];
    expect(trimHistory(history, 16)).toEqual(history);
  });

  it('keeps only the most recent messages', () => {
    const history = Array.from({ length: 10 }, (_, i) => text(`m${i}`, i % 2 === 0 ? 'user' : 'model'));
    const trimmed = trimHistory(history, 4);
    expect(trimmed).toHaveLength(4);
    expect(trimmed[3]).toBe(history[9]);
  });

  it('never starts on an orphaned tool result', () => {
    // The naive cut would land on index 2 — the functionResponse whose call was
    // dropped. That is a 400, so the boundary moves forward past the result and
    // the orphaned call with it, leaving only the final turn.
    const trimmed = trimHistory(roundTrip, 2);
    expect(shape(trimmed)).toEqual(['model:text']);
  });

  it('gives up the whole round trip rather than start on a bare call', () => {
    // Cut would land on index 1: a model message whose result is being dropped.
    // Its call is gone, so Gemini rejects the request outright — and this is the
    // exact failure the live 400 came from. Sliding forward past the result is
    // no better, since that opens on an orphaned functionResponse. What is left
    // is the model's closing sentence.
    const trimmed = trimHistory(roundTrip, 3);
    expect(shape(trimmed)).toEqual(['model:text']);
    expect(isLegal(trimmed)).toBe(true);
  });

  it('returns nothing for a non-positive limit', () => {
    expect(trimHistory(roundTrip, 0)).toEqual([]);
    expect(trimHistory(roundTrip, -1)).toEqual([]);
  });

  it('does not mutate the input', () => {
    const history = Array.from({ length: 8 }, (_, i) => text(`m${i}`, 'user'));
    const copy = [...history];
    trimHistory(history, 2);
    expect(history).toEqual(copy);
  });

  it('caps a long plain conversation at the limit', () => {
    const history: LlmMessage[] = [];
    for (let i = 0; i < 40; i += 1) history.push(text(`m${i}`, i % 2 === 0 ? 'user' : 'model'));
    expect(trimHistory(history)).toHaveLength(16);
  });
});

describe('trimHistory: Gemini turn-ordering rules', () => {
  /**
   * Gemini rejects a request whose history breaks the call → response
   * alternation, with "function call turn comes immediately after a user turn or
   * after a function response turn". Every shape below has to survive trimming.
   */
  const conversation: LlmMessage[] = [
    { role: 'user', parts: [{ kind: 'text', text: 'โซฟา' }] },
    { role: 'model', parts: [toolCall('a', SIGNATURE)] },
    { role: 'user', parts: [{ kind: 'toolResult', callId: 'a', name: 'a', result: {} }] },
    { role: 'model', parts: [{ kind: 'text', text: 'ต่อไป' }] },
    { role: 'user', parts: [{ kind: 'text', text: 'อีกอัน' }] },
    { role: 'model', parts: [toolCall('b', SIGNATURE)] },
    { role: 'user', parts: [{ kind: 'toolResult', callId: 'b', name: 'b', result: {} }] },
    { role: 'model', parts: [{ kind: 'text', text: 'จบ' }] },
  ];

  it('always cuts legally, for every limit', () => {
    for (let limit = 1; limit <= conversation.length; limit += 1) {
      const trimmed = trimHistory(conversation, limit);
      expect(isLegal(trimmed), `limit=${limit} produced ${JSON.stringify(shape(trimmed))}`).toBe(true);
    }
  });

  it('keeps the whole legal tail when the cut lands on a plain turn', () => {
    // Cut lands on index 4 — a user question, with nothing but a model sentence
    // behind it. That is legal, so there is nothing to slide past and the tail
    // comes back intact.
    const trimmed = trimHistory(conversation, 4);
    expect(shape(trimmed)).toEqual(['user:text', 'model:call(b)', 'user:result(b)', 'model:text']);
    expect(isLegal(trimmed)).toBe(true);
  });

  it('keeps the original conversation untouched when it fits', () => {
    expect(trimHistory(conversation, conversation.length)).toEqual(conversation);
  });

  it('slides off a cut that lands on a functionCall', () => {
    // A model turn asking for a tool, with the turn that asked for it already
    // trimmed away. This is the shape that produced the live 400.
    const orphanedCall: LlmMessage[] = [
      text('โซฟา', 'user'),
      text('ต่อไป', 'model'),
      { role: 'model', parts: [toolCall('a', SIGNATURE)] },
      { role: 'user', parts: [{ kind: 'toolResult', callId: 'a', name: 'a', result: {} }] },
      text('จบ', 'model'),
    ];
    const trimmed = trimHistory(orphanedCall, 2);
    expect(shape(trimmed)).not.toContain('model:call(a)');
    expect(isLegal(trimmed)).toBe(true);
  });

  it('drops a call/result pair that has no legal start at all', () => {
    // There is no way to begin legally inside this pair — not on the call, not
    // on the result — so the whole thing goes and the model answers the new
    // question cold. Losing one round trip of memory beats a rejected request.
    const pair: LlmMessage[] = [
      { role: 'model', parts: [toolCall('a', SIGNATURE)] },
      { role: 'user', parts: [{ kind: 'toolResult', callId: 'a', name: 'a', result: {} }] },
    ];
    for (let limit = 1; limit <= 2; limit += 1) {
      expect(isLegal(trimHistory(pair, limit)), `limit=${limit}`).toBe(true);
    }
  });
});
