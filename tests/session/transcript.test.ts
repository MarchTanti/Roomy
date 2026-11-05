import { describe, expect, it } from 'vitest';

import type { Json, Message, MessageRole } from '@/lib/db/types';
import { messageText, toTranscript, transcriptTitle } from '@/lib/session/transcript';

/**
 * Reading a stored conversation back.
 *
 * The transcript is what a person sees when they reopen an old chat, so it
 * has to hold the conversation and nothing else: the tool plumbing stays
 * hidden, and a row that does not parse costs one line rather than the page.
 */

let counter = 0;

function row(role: MessageRole, content: unknown): Message {
  counter += 1;
  return {
    id: `m${counter}`,
    session_id: 'session-1',
    role,
    content: content as Json,
    created_at: new Date(2026, 0, 1, 0, counter).toISOString(),
  };
}

function userText(text: string) {
  return { role: 'user', parts: [{ kind: 'text', text }] };
}

function modelText(text: string) {
  return { role: 'model', parts: [{ kind: 'text', text }] };
}

const PRODUCT = {
  id: 'ikea-sofa-katja-3',
  name_th: 'โซฟาคัทจ้า 3 ที่นั่ง',
  name_en: 'KATJA 3-seat sofa',
  category: 'sofa',
  style_tags: ['modern'],
  color: 'beige',
  material: 'fabric',
  price_thb: 12900,
  width_cm: 218,
  depth_cm: 95,
  height_cm: 83,
  image_url: '/product-images/ikea-sofa-katja-3.svg',
  in_stock: true,
};

describe('toTranscript', () => {
  it('turns a conversation into the two sides of a chat', () => {
    const entries = toTranscript([
      row('user', userText('ห้องนั่งเล่น 3×4 เมตร งบ 30,000')),
      row('assistant', modelText('แนะนำโซฟาคัทจ้าครับ')),
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ role: 'user', text: 'ห้องนั่งเล่น 3×4 เมตร งบ 30,000' });
    expect(entries[1]).toMatchObject({ role: 'assistant', text: 'แนะนำโซฟาคัทจ้าครับ' });
  });

  it('hides the tool round trips', () => {
    const entries = toTranscript([
      row('user', userText('ช่วยหาโซฟาด้วย')),
      row('assistant', { role: 'model', parts: [{ kind: 'toolCall', call: { id: null, name: 'searchFurniture', args: {} } }] }),
      row('user', { role: 'user', parts: [{ kind: 'toolResult', callId: 'searchFurniture', name: 'searchFurniture', result: { products: [PRODUCT] } }] }),
      row('assistant', modelText('แนะนำโซฟาคัทจ้าครับ')),
    ]);

    expect(entries.map((entry) => entry.role)).toEqual(['user', 'assistant']);
    expect(entries[1].text).toBe('แนะนำโซฟาคัทจ้าครับ');
  });

  it('skips a row it cannot read', () => {
    const entries = toTranscript([
      row('user', userText('สวัสดี')),
      row('assistant', { nonsense: true }),
      row('assistant', modelText('สวัสดีครับ')),
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[1].text).toBe('สวัสดีครับ');
  });

  it('gives the answer the products it was about, so the pictures come back', () => {
    const entries = toTranscript([
      row('user', userText('ช่วยหาโซฟาด้วย')),
      row('user', { role: 'user', parts: [{ kind: 'toolResult', callId: 'searchFurniture', name: 'searchFurniture', result: { products: [PRODUCT] } }] }),
      row('assistant', modelText('แนะนำโซฟาคัทจ้าครับ')),
    ]);

    expect(entries[1].products).toHaveLength(1);
    expect(entries[1].products?.[0].id).toBe('ikea-sofa-katja-3');
    expect(entries[1].products?.[0].price_thb).toBe(12900);
  });

  it('copes with an empty conversation', () => {
    expect(toTranscript([])).toEqual([]);
  });
});

describe('messageText', () => {
  it('joins the text parts', () => {
    expect(
      messageText({ role: 'model', parts: [{ kind: 'text', text: 'บรรทัดแรก' }, { kind: 'text', text: 'บรรทัดที่สอง' }] }),
    ).toBe('บรรทัดแรก\nบรรทัดที่สอง');
  });

  it('is empty for a row that is not a message', () => {
    expect(messageText({ role: 'user' })).toBe('');
    expect(messageText('hello')).toBe('');
  });
});

describe('transcriptTitle', () => {
  it('is the first thing the person said', () => {
    const title = transcriptTitle([
      row('user', userText('  ห้องนั่งเล่น\n3×4 เมตร  ')),
      row('assistant', modelText('ได้ครับ')),
    ]);
    expect(title).toBe('ห้องนั่งเล่น 3×4 เมตร');
  });

  it('cuts a long first message short', () => {
    const title = transcriptTitle([row('user', userText('ก'.repeat(200)))]);
    expect(title.length).toBeLessThanOrEqual(71);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back when nobody has said anything yet', () => {
    expect(transcriptTitle([], 'บทสนทนาใหม่')).toBe('บทสนทนาใหม่');
  });
});
