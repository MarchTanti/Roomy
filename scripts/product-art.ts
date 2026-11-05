/**
 * Drawing the catalogue.
 *
 * Every product in the catalogue needs a picture, and the picture is what the
 * user looks at when the bot recommends something — a card with a name and a
 * price says nothing about what the piece looks like.
 *
 * So each product gets a small flat illustration of its own shape, drawn in
 * the colour the catalogue row says it is. The shapes are deliberately simple:
 * a sofa is a sofa, a lamp is a lamp, and the user can tell them apart at
 * thumbnail size. Nothing here talks to the network or to the database, so
 * the drawings can be regenerated at any time.
 *
 * The file is written to `public/product-images/<id>.svg`. The name never
 * changes, so a catalogue row that already points at a picture keeps pointing
 * at a picture — only the picture inside it changes.
 */

/** The rows this module needs. Structurally a subset of `Product`. */
export interface ArtProduct {
  id: string;
  name_th: string;
  name_en: string;
  category: string;
  color: string | null;
  material: string | null;
  width_cm: number;
  depth_cm: number;
  height_cm: number;
}

const W = 640;
const H = 480;
/** Where the floor is. Everything stands on it. */
const FLOOR = 372;

const INK = '#3a332a';
const METAL = '#b0b5ba';
const GLASS = '#d9e2e6';

/** The catalogue's colour names, turned into paint. */
const PALETTE: Record<string, string> = {
  white: '#efebe3',
  black: '#3f3f43',
  beige: '#dcc9ac',
  natural: '#d8c19c',
  walnut: '#7c5636',
  oak: '#c9a877',
  'light-oak': '#ddc79e',
  gray: '#a7abb0',
  charcoal: '#4e525a',
  cream: '#eee2cd',
  green: '#93a888',
  blue: '#8ba3c1',
  brass: '#c9a44c',
};

function paint(product: ArtProduct): string {
  return PALETTE[product.color ?? ''] ?? '#c9bda9';
}

/** A leg is metal when the material says so, and wood otherwise. */
function legColour(product: ArtProduct): string {
  const material = product.material ?? '';
  if (material.includes('โลหะ')) return METAL;
  // A wooden leg a shade darker than its piece, so a white table does not
  // dissolve into the background.
  if (material.includes('ไม้')) return shade(paint(product), 0.78);
  return '#8d7c66';
}

/**
 * A rounded rectangle, with an optional light wash over it.
 *
 * The hairline outline is what keeps a white piece of furniture visible on a
 * cream background — without it, a white shelf on a cream wall is a smudge.
 */
function box(
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  radius = 8,
  extra = '',
): string {
  const outline = extra.includes('stroke=')
    ? ''
    : `stroke="${INK}" stroke-opacity="0.13" stroke-width="2.5"`;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" ${outline} ${extra}/>`;
}

/** A colour a little darker than the piece — for shelves and shadowed edges. */
function shade(colour: string, amount = 0.84): string {
  const n = parseInt(colour.replace('#', ''), 16);
  const r = Math.round(((n >> 16) & 255) * amount);
  const g = Math.round(((n >> 8) & 255) * amount);
  const b = Math.round((n & 255) * amount);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/**
 * A highlight: the same shape in white, partly transparent.
 *
 * The shape itself is drawn in white — this is only the opacity, so it can be
 * laid over any colour without repeating the `fill` attribute.
 */
const GLAZE = 'fill-opacity="0.26"';

// ---------------------------------------------------------------------------
// One shape per category
// ---------------------------------------------------------------------------

function sofa(fill: string, leg: string): string {
  return [
    box(120, 150, 400, 104, fill, 24),
    box(142, 168, 174, 64, '#ffffff', 16, GLAZE),
    box(324, 168, 174, 64, '#ffffff', 16, GLAZE),
    box(140, 242, 360, 78, fill, 18),
    box(158, 258, 162, 48, '#ffffff', 14, GLAZE),
    box(320, 258, 162, 48, '#ffffff', 14, GLAZE),
    box(96, 190, 48, 130, fill, 20),
    box(496, 190, 48, 130, fill, 20),
    box(128, 320, 16, 46, leg, 5),
    box(496, 320, 16, 46, leg, 5),
  ].join('');
}

function armchair(fill: string, leg: string): string {
  return [
    box(212, 158, 216, 116, fill, 24),
    box(232, 176, 176, 74, '#ffffff', 16, GLAZE),
    box(188, 198, 42, 122, fill, 18),
    box(410, 198, 42, 122, fill, 18),
    box(214, 250, 212, 74, fill, 18),
    box(232, 266, 176, 44, '#ffffff', 12, GLAZE),
    box(206, 324, 14, 42, leg, 5),
    box(420, 324, 14, 42, leg, 5),
  ].join('');
}

function table(fill: string, leg: string): string {
  return [
    box(140, 196, 360, 24, fill, 10),
    box(140, 196, 360, 12, '#ffffff', 6, GLAZE),
    box(162, 220, 316, 16, fill, 4),
    box(168, 236, 18, 130, leg, 5),
    box(454, 236, 18, 130, leg, 5),
  ].join('');
}

function desk(fill: string, leg: string): string {
  return [
    box(110, 202, 420, 22, fill, 10),
    box(110, 202, 420, 11, '#ffffff', 6, GLAZE),
    box(148, 224, 150, 66, fill, 8),
    box(162, 240, 122, 16, '#ffffff', 4, GLAZE),
    box(160, 290, 14, 76, leg, 5),
    box(466, 290, 14, 76, leg, 5),
  ].join('');
}

function chair(fill: string, leg: string): string {
  return [
    box(228, 132, 184, 118, fill, 20),
    box(248, 150, 144, 82, '#ffffff', 14, GLAZE),
    box(214, 246, 212, 30, fill, 12),
    box(214, 246, 212, 15, '#ffffff', 8, GLAZE),
    box(222, 276, 14, 90, leg, 5),
    box(404, 276, 14, 90, leg, 5),
  ].join('');
}

function shelf(fill: string, leg: string): string {
  const board = shade(fill, 0.88);
  const book = (x: number, w: number, h: number, colour: string) =>
    box(x, 254 - h, w, h, colour, 3);
  return [
    box(166, 104, 308, 262, fill, 12),
    box(142, 104, 24, 262, board, 8),
    box(474, 104, 24, 262, board, 8),
    box(166, 104, 308, 12, board, 4),
    book(196, 22, 62, '#c9a44c'),
    book(222, 18, 74, '#93a888'),
    book(244, 20, 54, '#8ba3c1'),
    box(186, 248, 268, 14, board, 4),
    book(196, 26, 48, '#b6c2ce'),
    book(226, 20, 58, '#d9a441'),
    box(186, 298, 268, 14, board, 4),
    box(206, 316, 84, 34, '#ffffff', 6, 'fill-opacity="0.5"'),
    box(166, 366, 16, 6, leg, 3),
    box(458, 366, 16, 6, leg, 3),
  ].join('');
}

function cabinet(fill: string, leg: string): string {
  return [
    box(166, 118, 308, 238, fill, 12),
    box(184, 134, 134, 206, '#ffffff', 8, GLAZE),
    box(322, 134, 134, 206, '#ffffff', 8, GLAZE),
    box(314, 226, 6, 24, INK, 3, 'fill-opacity="0.45"'),
    box(320, 226, 6, 24, INK, 3, 'fill-opacity="0.45"'),    box(178, 356, 16, 16, leg, 4),
    box(446, 356, 16, 16, leg, 4),
  ].join('');
}

function dresser(fill: string, leg: string): string {
  return [
    box(176, 146, 288, 214, fill, 12),
    box(194, 162, 252, 54, '#ffffff', 8, GLAZE),
    box(194, 226, 252, 54, '#ffffff', 8, GLAZE),
    box(194, 290, 252, 54, '#ffffff', 8, GLAZE),
    box(310, 184, 20, 8, INK, 4, 'fill-opacity="0.4"'),
    box(310, 248, 20, 8, INK, 4, 'fill-opacity="0.4"'),
    box(310, 312, 20, 8, INK, 4, 'fill-opacity="0.4"'),
    box(188, 360, 16, 12, leg, 4),
    box(436, 360, 16, 12, leg, 4),
  ].join('');
}

function bed(fill: string, leg: string): string {
  return [
    box(152, 96, 336, 130, fill, 18),
    box(172, 114, 296, 94, '#ffffff', 12, GLAZE),
    box(128, 222, 384, 96, fill, 16),
    box(150, 190, 156, 52, '#ffffff', 16, GLAZE),
    box(334, 190, 156, 52, '#ffffff', 16, GLAZE),
    box(128, 282, 384, 52, '#ffffff', 12, 'fill-opacity="0.16"'),
    box(144, 318, 18, 54, leg, 5),
    box(478, 318, 18, 54, leg, 5),
  ].join('');
}

function lamp(fill: string, leg: string): string {
  return [
    `<path d="M238 104 L402 104 L370 202 L270 202 Z" fill="${fill}" stroke="${INK}" stroke-opacity="0.16" stroke-width="4" stroke-linejoin="round"/>`,
    `<path d="M238 104 L402 104 L392 128 L248 128 Z" fill="#ffffff" fill-opacity="0.34"/>`,
    box(314, 202, 12, 140, leg, 5),
    `<ellipse cx="320" cy="348" rx="58" ry="13" fill="${leg}"/>`,
    `<ellipse cx="320" cy="346" rx="58" ry="13" fill="${fill}" fill-opacity="0.5"/>`,
  ].join('');
}

function tvStand(fill: string, leg: string): string {
  return [
    box(206, 96, 228, 136, INK, 10, 'fill-opacity="0.82"'),
    box(216, 106, 208, 116, GLASS, 6, 'fill-opacity="0.55"'),
    box(146, 248, 348, 76, fill, 12),
    box(146, 248, 348, 20, '#ffffff', 10, GLAZE),
    box(182, 292, 74, 12, '#ffffff', 4, GLAZE),
    box(170, 324, 16, 42, leg, 5),
    box(454, 324, 16, 42, leg, 5),
  ].join('');
}

function rug(fill: string, leg: string): string {
  // The fringe runs along the two short ends, the way a woven rug is made.
  const fringe = (x: number) => `<line x1="${x}" y1="258" x2="${x}" y2="280"/>`;
  const fringeBottom = (x: number) => `<line x1="${x}" y1="344" x2="${x}" y2="366"/>`;
  const xs = [116, 146, 176, 206, 236, 266, 296, 326, 356, 386, 416, 446, 476, 506];
  return [
    box(96, 254, 448, 116, fill, 18),
    box(118, 268, 404, 88, '#ffffff', 12, 'fill-opacity="0.3"'),
    box(140, 286, 360, 52, fill, 8, 'fill-opacity="0.55"'),
    `<g stroke="${INK}" stroke-opacity="0.3" stroke-width="4" stroke-linecap="round">`,
    xs.map(fringe).join(''),
    xs.map(fringeBottom).join(''),
    '</g>',
  ].join('');
}

const SHAPES: Record<string, (fill: string, leg: string) => string> = {
  sofa,
  armchair,
  table,
  desk,
  chair,
  shelf,
  cabinet,
  dresser,
  bed,
  lamp,
  tv_stand: tvStand,
  rug,
};

/**
 * The illustration of one product.
 *
 * A shape is chosen by category; a product in a category we have no drawing
 * for falls back to a plain box, which is still better than nothing.
 */
export function buildProductSvg(product: ArtProduct): string {
  const fill = paint(product);
  const leg = legColour(product);
  const shape = SHAPES[product.category];

  const body = shape
    ? shape(fill, leg)
    : `${box(160, 160, 320, 200, fill, 14)}${box(160, 160, 320, 40, '#ffffff', 12, GLAZE)}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${escapeXml(product.name_th)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fffdf9"/>
      <stop offset="1" stop-color="#f4ecdf"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.42" r="0.6">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.85"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <ellipse cx="${W / 2}" cy="${FLOOR - 118}" rx="250" ry="170" fill="url(#glow)"/>
  <line x1="0" y1="${FLOOR}" x2="${W}" y2="${FLOOR}" stroke="#e2d6c1" stroke-width="3"/>
  <ellipse cx="${W / 2}" cy="${FLOOR + 4}" rx="212" ry="16" fill="${INK}" fill-opacity="0.07"/>

  ${body}

  <g font-family="'Noto Sans Thai', -apple-system, 'Segoe UI', sans-serif" fill="${INK}" fill-opacity="0.5">
    <text x="30" y="${H - 24}" font-size="18">${escapeXml(product.name_th)}</text>
    <text x="30" y="${H - 6}" font-size="13" fill-opacity="0.38">${escapeXml(product.name_en)} · ${product.width_cm} × ${product.depth_cm} × ${product.height_cm} ซม.</text>
  </g>
</svg>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
