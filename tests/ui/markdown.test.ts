import { describe, expect, it } from 'vitest';

import { isSafeHref, parseInline, parseMarkdown } from '@/app/chat/markdown';

/**
 * The markdown parser.
 *
 * The model's answers are the only markdown in the app, and they arrive in a
 * handful of shapes: a name in bold, a price under it, a heading, a link. If
 * the parser mangles one of those, the chat becomes a wall of asterisks — so
 * the shapes are pinned here.
 */

function text(nodes: { kind: string; text?: string; children?: unknown[] }[]): string {
  return nodes
    .map((node) => {
      if (node.kind === 'text') return node.text ?? '';
      if (node.kind === 'code') return node.text ?? '';
      if (node.kind === 'strong' || node.kind === 'em') {
        return text(node.children as { kind: string; text?: string }[]);
      }
      if (node.kind === 'link') {
        return text(node.children as { kind: string; text?: string }[]);
      }
      return '';
    })
    .join('');
}

describe('parseInline', () => {
  it('reads bold and leaves the rest alone', () => {
    const nodes = parseInline('**ราคา:** 5,990 บาท');
    expect(nodes[0].kind).toBe('strong');
    expect(text([nodes[0]])).toBe('ราคา:');
    expect(text(nodes.slice(1))).toBe(' 5,990 บาท');
  });

  it('reads a link and keeps the label', () => {
    const nodes = parseInline('ดูที่ [เว็บ IKEA](https://www.ikea.com/th) ได้เลย');
    const link = nodes.find((n) => n.kind === 'link');
    expect(link).toBeDefined();
    expect(link && 'href' in link ? link.href : '').toBe('https://www.ikea.com/th');
    expect(text([link!])).toBe('เว็บ IKEA');
  });

  it('does not turn code into bold', () => {
    const nodes = parseInline('`a ** b`');
    expect(nodes[0].kind).toBe('code');
    expect(text(nodes)).toBe('a ** b');
  });

  it('leaves a lone asterisk as text', () => {
    expect(text(parseInline('5,990 บาท * 2'))).toBe('5,990 บาท * 2');
  });
});

describe('parseMarkdown', () => {
  it('reads the numbered product list the model writes', () => {
    const blocks = parseMarkdown(
      [
        '1. **POÄNG armchair (เก้าอี้นั่งปวง)**',
        '   - **ราคา:** 5,990 บาท',
        '   - **ขนาด:** กว้าง 83 ซม. × ลึก 72 ซม.',
        '2. **SALMI coffee table**',
        '   - **ราคา:** 4,490 บาท',
      ].join('\n'),
    );

    expect(blocks).toHaveLength(1);
    const list = blocks[0];
    expect(list.kind).toBe('list');
    if (list.kind !== 'list') return;
    expect(list.ordered).toBe(true);
    expect(list.items).toHaveLength(2);

    expect(text(list.items[0].children)).toBe('POÄNG armchair (เก้าอี้นั่งปวง)');
    expect(list.items[0].sub).toHaveLength(2);
    expect(text(list.items[0].sub[0].children)).toBe('ราคา: 5,990 บาท');
    expect(text(list.items[0].sub[1].children)).toBe('ขนาด: กว้าง 83 ซม. × ลึก 72 ซม.');
  });

  it('reads a heading, a paragraph and a rule', () => {
    const blocks = parseMarkdown('### สรุป\n\nวางได้พอดี\n\n---\n\nจบ');
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'rule', 'paragraph']);
    const heading = blocks[0];
    expect(heading.kind === 'heading' && heading.level).toBe(3);
  });

  it('keeps a bulleted list separate from the paragraph above it', () => {
    const blocks = parseMarkdown('ดังนี้ครับ:\n\n- สีเบจ\n- โครงไม้');
    expect(blocks).toHaveLength(2);
    const list = blocks[1];
    expect(list.kind).toBe('list');
    if (list.kind !== 'list') return;
    expect(list.ordered).toBe(false);
    expect(list.items.map((item) => text(item.children))).toEqual(['สีเบจ', 'โครงไม้']);
  });

  it('keeps a line break inside a paragraph', () => {
    const blocks = parseMarkdown('บรรทัดแรก\nบรรทัดที่สอง');
    expect(blocks).toHaveLength(1);
    expect(text(blocks[0].kind === 'paragraph' ? blocks[0].children : [])).toBe(
      'บรรทัดแรก\nบรรทัดที่สอง',
    );
  });
});

describe('isSafeHref', () => {
  it('allows the schemes a link in an answer may use', () => {
    expect(isSafeHref('https://www.ikea.com/th')).toBe(true);
    expect(isSafeHref('http://example.com')).toBe(true);
    expect(isSafeHref('/chat')).toBe(true);
  });

  it('refuses a scheme that would run code', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('  javascript:alert(1)')).toBe(false);
    expect(isSafeHref('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeHref('//example.com')).toBe(false);
  });
});
