/**
 * A small markdown parser.
 *
 * The model's answers are markdown: `**bold**`, numbered and bulleted lists,
 * `###` headings. The browser does not render any of that, so the raw asterisks
 * and dashes were showing up in the chat. Pulling in a markdown library for
 * this would be a dependency the spec does not name, and the subset we need
 * is small enough to own.
 *
 * Two rules shape the design:
 *
 *   - **Nothing becomes HTML.** The parser returns a tree of plain objects and
 *     the renderer turns that tree into React elements. There is no
 *     `dangerouslySetInnerHTML` anywhere, so a product description that
 *     contains `<script>` is text, and always text.
 *   - **Only a known subset is understood.** Anything else is left as literal
 *     text, which is what the model meant anyway.
 *
 * The parser is pure and has no React in it, so it is tested on its own.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: Inline[] };

export interface ListItem {
  children: Inline[];
  /** A list nested under this item — the model writes the size under the name. */
  sub: ListItem[];
}

export type Block =
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'heading'; level: 1 | 2 | 3; children: Inline[] }
  | { kind: 'list'; ordered: boolean; items: ListItem[] }
  | { kind: 'rule' };

const HEADING = /^(#{1,3})\s+(.*)$/;
const RULE = /^\s*([-*_])\s*(\1\s*){2,}$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const NUMBERED = /^(\s*)(\d+)[.)]\s+(.*)$/;

/**
 * Inline markers, in the order they have to win.
 *
 * `**` before `*`, and code before both, so `**a**` is bold rather than two
 * italics, and `` `**x**` `` is code rather than bold.
 */
const INLINE_SOURCE = '(`[^`]+`)|(\\*\\*[^*\\n]+\\*\\*)|(\\[[^\\]\\n]+\\]\\([^)\\s]+\\))|(\\*[^*\\n]+\\*)|(_[^_\\n]+_)';

/** Splits one line of text into inline nodes. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  // A fresh regex per call: the pattern is global, and `parseInline` recurses
  // into its own matches, which would otherwise share one `lastIndex` and
  // loop forever.
  const inline = new RegExp(INLINE_SOURCE, 'g');

  let match: RegExpExecArray | null;
  while ((match = inline.exec(text)) !== null) {
    if (match.index > last) out.push({ kind: 'text', text: text.slice(last, match.index) });

    const token = match[0];
    if (token.startsWith('`')) {
      out.push({ kind: 'code', text: token.slice(1, -1) });
    } else if (token.startsWith('**')) {
      out.push({ kind: 'strong', children: parseInline(token.slice(2, -2)) });
    } else if (token.startsWith('[')) {
      const split = token.indexOf('](');
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      out.push({ kind: 'link', href, children: parseInline(label) });
    } else if (token.startsWith('*')) {
      out.push({ kind: 'em', children: parseInline(token.slice(1, -1)) });
    } else {
      out.push({ kind: 'em', children: parseInline(token.slice(1, -1)) });
    }

    last = match.index + token.length;
  }

  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/** A line that starts a list item, whatever its marker. */
function listItem(line: string): { indent: number; content: string } | null {
  const bullet = BULLET.exec(line);
  if (bullet) return { indent: bullet[1].length, content: bullet[3] };
  const numbered = NUMBERED.exec(line);
  if (numbered) return { indent: numbered[1].length, content: numbered[3] };
  return null;
}

/**
 * Reads the list that starts at `start`, including anything nested under it.
 *
 * Nesting is by indentation, which is how the model writes: the name of a
 * product on one line, its price and size on the lines below.
 */
function parseList(
  lines: string[],
  start: number,
  indent: number,
): { items: ListItem[]; next: number } {
  const items: ListItem[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      // A blank line ends the list, unless the next line is still part of it.
      let next = i + 1;
      while (next < lines.length && !lines[next].trim()) next += 1;
      if (next >= lines.length) break;
      const deeper = listItem(lines[next]);
      if (!deeper || deeper.indent < indent) break;
      i = next;
      continue;
    }

    const item = listItem(line);
    if (!item) break;

    if (item.indent > indent) {
      // Deeper than this level: a nested list under the item above it.
      const nested = parseList(lines, i, item.indent);
      if (items.length > 0) items[items.length - 1].sub = nested.items;
      i = nested.next;
      continue;
    }

    if (item.indent < indent) break;

    // A new item on this level. Its own text continues on the following lines
    // until the next item or a blank line.
    const own: string[] = [item.content];
    i += 1;
    while (i < lines.length) {
      const next = lines[i];
      if (!next.trim()) break;
      if (listItem(next)) break;
      own.push(next.trim());
      i += 1;
    }

    items.push({ children: parseInline(own.join('\n')), sub: [] });
  }

  return { items, next: i };
}

/** Parses a whole answer into blocks. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        children: parseInline(heading[2]),
      });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    if (listItem(line)) {
      const ordered = NUMBERED.test(line);
      const { items, next } = parseList(lines, i, listItem(line)!.indent);
      blocks.push({ kind: 'list', ordered, items });
      i = next;
      continue;
    }

    // A paragraph: every line up to the next blank line or block marker.
    const paragraph: string[] = [];
    while (i < lines.length) {
      const current = lines[i];
      if (!current.trim()) break;
      if (HEADING.test(current) || RULE.test(current) || listItem(current)) break;
      paragraph.push(current);
      i += 1;
    }
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join('\n')) });
    }
  }

  return blocks;
}

/**
 * The link schemes we are willing to render as a link.
 *
 * A `javascript:` URL in an answer would be an attack on the user, and the
 * model has no business producing one — but the answer is text it wrote, and
 * text can be anything.
 */
export function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return true;
  return /^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed);
}
