/**
 * A 5x7 bitmap font, drawn as SVG rectangles.
 *
 * Why not a real font: this container has no fonts installed and no
 * fontconfig, so librsvg renders every `<text>` element as an empty tofu box.
 * A label that reads "□□□□□□□□□□□□" is not a label, and the spec requires
 * every generated image to carry a readable "Simulated image" mark.
 *
 * The bitmap below is the smallest thing that always works — no dependency, no
 * system state, and the same pixels on every machine. Only the characters the
 * label needs are defined; anything else is an error rather than a blank box.
 */

/** Glyphs are 5 columns wide. */
export const GLYPH_WIDTH = 5;
/** …and 7 rows tall. */
export const GLYPH_HEIGHT = 7;

/**
 * One row per text line, one character per column: '#' is a lit pixel, '.' is
 * background.
 */
const GLYPHS: Record<string, string[]> = {
  S: ['.###.', '#...#', '#....', '.###.', '....#', '#...#', '.###.'],
  i: ['..#..', '.....', '.##..', '..#..', '..#..', '..#..', '.###.'],
  m: ['.....', '.....', '##.#.', '#.#.#', '#.#.#', '#.#.#', '#.#.#'],
  u: ['.....', '.....', '#...#', '#...#', '#...#', '#..##', '.##.#'],
  l: ['.##..', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  a: ['.....', '.....', '.###.', '....#', '.####', '#...#', '.####'],
  t: ['..#..', '..#..', '.###.', '..#..', '..#..', '..#..', '...##'],
  e: ['.....', '.....', '.###.', '#...#', '#####', '#....', '.###.'],
  d: ['....#', '....#', '.###.', '#...#', '#...#', '#...#', '.###.'],
  g: ['.....', '.....', '.###.', '#...#', '.####', '....#', '.###.'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

/** The rows of one character, or null when the character has no glyph. */
export function glyphRows(char: string): string[] | null {
  return GLYPHS[char] ?? null;
}

/** Every character in the font, for a caller that wants to check support. */
export function supportedCharacters(): string[] {
  return Object.keys(GLYPHS);
}

/**
 * The columns the string occupies, including the one-pixel gap between
 * glyphs. A trailing gap is not counted.
 */
export function textColumns(text: string): number {
  if (text.length === 0) return 0;
  return text.length * GLYPH_WIDTH + (text.length - 1);
}

/** How many lit pixels the string has, in font pixels. */
export function litPixelCount(text: string): number {
  let count = 0;
  for (const char of text) {
    const rows = glyphRows(char);
    if (!rows) throw new Error(`No glyph for "${char}"`);
    for (const row of rows) {
      for (const cell of row) {
        if (cell === '#') count += 1;
      }
    }
  }
  return count;
}

/**
 * SVG rectangles for the text, one per lit pixel.
 *
 * The caller positions the result: the returned fragments are in the same
 * coordinate space as the rest of the label, and each font pixel becomes a
 * `scale` × `scale` block of device pixels.
 */
export function textRects(
  text: string,
  options: { x: number; y: number; scale: number; fill: string },
): string {
  const { x, y, scale, fill } = options;
  const rects: string[] = [];
  let col = 0;

  for (const char of text) {
    const rows = glyphRows(char);
    if (!rows) throw new Error(`No glyph for "${char}"`);
    rows.forEach((row, rowIndex) => {
      [...row].forEach((cell, colIndex) => {
        if (cell !== '#') return;
        rects.push(
          `<rect x="${x + (col + colIndex) * scale}" y="${y + rowIndex * scale}" ` +
            `width="${scale}" height="${scale}" fill="${fill}"/>`,
        );
      });
    });
    col += GLYPH_WIDTH + 1;
  }

  return rects.join('');
}
