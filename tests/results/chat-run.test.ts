/**
 * Reading the chat route's event stream, and what the turn left behind.
 *
 * The route answers with Server-Sent Events; the results script has to make
 * sense of them the same way the browser does. These tests use hand-written
 * frames rather than a real model, so a change in the route's frame shape
 * shows up here first.
 */

import { describe, expect, it } from 'vitest';

import type { Message } from '@/lib/db/types';
import {
  extractClearances,
  extractFitResults,
  parseSse,
  readSse,
  readTurn,
  runChatTurn,
} from '@/lib/results/chat-run';

function sse(...frames: unknown[]): string {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
}

describe('parseSse', () => {
  it('reads the frames out of a stream', () => {
    const frames = parseSse(
      sse({ type: 'step' }, { type: 'delta', text: 'สวัสดี' }, { type: 'done', reply: 'สวัสดีครับ' }),
    );

    expect(frames.map((frame) => frame.type)).toEqual(['step', 'delta', 'done']);
    expect(frames[1].text).toBe('สวัสดี');
  });

  it('skips anything that is not a frame', () => {
    const frames = parseSse(
      ': a comment\n\n' + 'data: [DONE]\n\n' + 'data: not json\n\n' + 'data: {"type":"nope"}\n\n' + sse({ type: 'done' }),
    );

    expect(frames.map((frame) => frame.type)).toEqual(['done']);
  });

  it('reads a frame that arrives in pieces', () => {
    // The stream is chunked at arbitrary byte boundaries, so a frame can be
    // split across two reads. The parser sees whole frames; the reader is
    // the part that assembles them.
    expect(parseSse('data: {"type":"del')).toEqual([]);
    expect(parseSse('data: {"type":"delta","text":"hi"}\n\n')).toEqual([{ type: 'delta', text: 'hi' }]);
  });
});

describe('readSse', () => {
  it('reads every frame of a response body', async () => {
    const response = new Response(sse({ type: 'step' }, { type: 'done', reply: 'เสร็จ' }), {
      headers: { 'Content-Type': 'text/event-stream' },
    });

    const read = await readSse(response, Date.now());
    expect(read.frames.map((frame) => frame.type)).toEqual(['step', 'done']);
    expect(read.total_ms).toBeGreaterThanOrEqual(0);
  });
});

describe('readTurn', () => {
  it('reads the answer out of the done frame', () => {
    const turn = readTurn(
      [
        { type: 'step' },
        { type: 'delta', text: 'วางได้' },
        {
          type: 'done',
          reply: 'วางได้ครับ',
          tool_calls: [{ name: 'checkFit', args: { product_id: 'p-1' } }],
          iterations: 2,
          hit_iteration_cap: false,
          state: { preferences: { style: 'scandinavian', budget_thb: 20000, category: 'sofa' } },
          products: [{ id: 'p-1' }],
          comparison: null,
          chat_turns_left: 19,
          usage: { in: 120, out: 45, think: 0 },
        },
      ],
      120,
      900,
    );

    expect(turn.ok).toBe(true);
    expect(turn.reply).toBe('วางได้ครับ');
    expect(turn.tool_calls).toEqual([{ name: 'checkFit', args: { product_id: 'p-1' } }]);
    expect(turn.iterations).toBe(2);
    expect(turn.preferences).toEqual({ style: 'scandinavian', budget_thb: 20000, category: 'sofa' });
    expect(turn.chat_turns_left).toBe(19);
    expect(turn.usage).toEqual({ in: 120, out: 45, think: 0 });
    expect(turn.first_token_ms).toBe(120);
  });

  it('fails the turn when the route reported an error', () => {
    const turn = readTurn([{ type: 'error', error: 'chat_failed', message: 'โมเดลล้มเหลว' }], null, 10);

    expect(turn.ok).toBe(false);
    expect(turn.error).toBe('โมเดลล้มเหลว');
    expect(turn.reply).toBe('');
  });

  it('reads the room the turn designed', () => {
    const turn = readTurn(
      [
        {
          type: 'done',
          reply: 'วาดให้แล้วครับ',
          design: {
            image_id: 'img-1',
            version: 1,
            style: 'มินิมอล',
            room_size_m2: 24,
            width_cm: 600,
            depth_cm: 400,
            total_price_thb: 14_390,
            pieces: [{ product_id: 'bed-1', price_thb: 10_900, width_cm: 105 }],
          },
        },
      ],
      120,
      900,
    );

    expect(turn.design?.image_id).toBe('img-1');
    expect(turn.design?.room_size_m2).toBe(24);
    expect(turn.design?.pieces[0].product_id).toBe('bed-1');
  });

  it('has no room when the turn drew none', () => {
    const turn = readTurn([{ type: 'done', reply: 'ได้ครับ' }], null, 10);

    expect(turn.design).toBeNull();
  });

  it('fails the turn when there is no done frame at all', () => {
    const turn = readTurn([{ type: 'step' }], null, 10);

    expect(turn.ok).toBe(false);
    expect(turn.error).toContain('done');
  });
});

describe('runChatTurn', () => {
  it('turns a transport into a turn', async () => {
    const turn = await runChatTurn(
      async () => new Response(sse({ type: 'done', reply: 'ตอบแล้ว', iterations: 1 }), {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
      'คำถาม',
    );

    expect(turn.ok).toBe(true);
    expect(turn.reply).toBe('ตอบแล้ว');
  });

  it('reports an HTTP failure instead of throwing', async () => {
    const turn = await runChatTurn(
      async () => Response.json({ error: 'rate_limited', message: 'ครบ 20 ครั้งแล้ว' }, { status: 429 }),
      'คำถาม',
    );

    expect(turn.ok).toBe(false);
    expect(turn.error).toBe('ครบ 20 ครั้งแล้ว');
  });
});

describe('extractFitResults', () => {
  function message(content: unknown): Message {
    return {
      id: 'm-1',
      session_id: 's-1',
      role: 'user',
      content: content as Message['content'],
      created_at: '2026-01-01T00:00:00.000Z',
    };
  }

  it('reads the checkFit results out of the transcript', () => {
    const results = extractFitResults([
      message({
        role: 'user',
        parts: [
          {
            kind: 'toolResult',
            callId: 'c-1',
            name: 'checkFit',
            result: {
              product: { id: 'p-1', name_th: 'โซฟาคัทจ้า 3 ที่นั่ง', width_cm: 210, depth_cm: 88, height_cm: 78 },
              space: { width_cm: 240, depth_cm: 120, height_cm: 260 },
              fit: { verdict: 'fits', rotation_deg: 0, reasons: ['พื้นที่วางได้'] },
              price_thb: 12900,
            },
          },
        ],
      }),
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      product_id: 'p-1',
      product_name: 'โซฟาคัทจ้า 3 ที่นั่ง',
      verdict: 'fits',
      price_thb: 12900,
    });
    expect(results[0].space).toEqual({ width_cm: 240, depth_cm: 120, height_cm: 260 });
  });

  it('ignores the results of other tools', () => {
    const results = extractFitResults([
      message({
        role: 'user',
        parts: [
          { kind: 'toolResult', callId: 'c-1', name: 'searchFurniture', result: { count: 2, products: [] } },
        ],
      }),
    ]);

    expect(results).toEqual([]);
  });

  it('survives a transcript row that is not what it should be', () => {
    expect(extractFitResults([message('not an object')])).toEqual([]);
    expect(extractFitResults([message({ role: 'user', parts: 'not a list' })])).toEqual([]);
    expect(
      extractFitResults([
        message({ role: 'user', parts: [{ kind: 'toolResult', name: 'checkFit', result: { fit: {} } }] }),
      ]),
    ).toEqual([]);
  });
});

describe('extractClearances', () => {
  function message(content: unknown): Message {
    return {
      id: 'm-1',
      session_id: 's-1',
      role: 'user',
      content: content as Message['content'],
      created_at: '2026-01-01T00:00:00.000Z',
    };
  }

  function toolResult(name: string, result: unknown): Message {
    return message({ role: 'user', parts: [{ kind: 'toolResult', callId: 'c-1', name, result }] });
  }

  it('reads the clearances of a fit check', () => {
    const clearances = extractClearances([
      toolResult('checkFit', {
        fit: {
          verdict: 'fits',
          width: { needed_cm: 210, available_cm: 240, clearance_cm: 30 },
          depth: { needed_cm: 88, available_cm: 120, clearance_cm: 32 },
          height: { needed_cm: 78, available_cm: 260, clearance_cm: 182 },
        },
      }),
    ]);

    expect(clearances).toEqual([30, 32, 182]);
  });

  it('reads the clearances of a comparison', () => {
    // A comparison judges each product by the same rule, so the bot may
    // quote those numbers as well.
    const clearances = extractClearances([
      toolResult('compareOptions', {
        products: [
          {
            id: 'a',
            fit: {
              verdict: 'fits',
              width: { clearance_cm: 30 },
              depth: { clearance_cm: 32 },
              height: { clearance_cm: 182 },
            },
          },
          {
            id: 'b',
            fit: {
              verdict: 'does_not_fit',
              width: { clearance_cm: -20 },
              depth: { clearance_cm: 40 },
              height: null,
            },
          },
        ],
      }),
    ]);

    expect(clearances).toEqual([30, 32, 182, -20, 40]);
  });

  it('reads nothing out of the tools that do not judge a fit', () => {
    expect(extractClearances([toolResult('searchFurniture', { count: 2, products: [] })])).toEqual([]);
    expect(extractClearances([toolResult('analyzeRoom', { style: 'modern' })])).toEqual([]);
  });
});
