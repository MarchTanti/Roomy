import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('sharp');

import { recolourToBrand } from './logo-colour.mjs';

/*
 * Builds the logo assets from the picture the logo came in.
 *
 * The picture is the mark on its own: a blue rounded square with a white
 * drawing of a room and a sofa in it. The app wants that square in its own
 * blue, so the picture is read twice — once for the shape of the mark, and
 * once for the drawing on top of it — and the drawing is painted back over a
 * flat ground of the house colour.
 *
 * The shape is found rather than assumed. The blue of the mark is the only
 * azure in the picture, and it is one piece: the square is closed around the
 * white drawing inside it, so the drawing is part of the mark and not a hole
 * in it. Anything else in the picture — the wordmark, if the picture has one
 * — is a separate piece and is left alone.
 *
 *   node scripts/make-logo.mjs [the picture the logo came in]
 *
 * It writes `public/roomyai-icon.png` (the mark) and `app/icon.png` (the
 * favicon).
 */

const SOURCE = process.argv[2] ?? 'assets/logo-source.png';

/** The size of the mark that the app uses. */
const SIZE = 512;

/**
 * How far a pixel has to lean blue before it is the mark and not the white
 * of the drawing inside it.
 */
const BLUE_CUT = 60;

const source = await sharp(SOURCE).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const SW = source.info.width;
const SH = source.info.height;
const at = (x, y) => (y * SW + x) * 4;

// --- where the mark is ---------------------------------------------------------
// The azure of the mark, and nothing else: the drawing is white and the
// paper is gone.
const azure = new Uint8Array(SW * SH);
for (let i = 0; i < SW * SH; i++) {
  const o = i * 4;
  const r = source.data[o];
  const b = source.data[o + 2];
  if (source.data[o + 3] < 128) continue;
  if (b - r < BLUE_CUT) continue;
  azure[i] = 1;
}

// The mark is the largest piece of azure: the square, not a letter.
const label = new Int32Array(SW * SH).fill(-1);
const stack = [];
let best = -1;
let bestSize = 0;
let next = 0;
for (let start = 0; start < SW * SH; start++) {
  if (!azure[start] || label[start] >= 0) continue;
  const id = next++;
  let size = 0;
  stack.push(start);
  label[start] = id;
  while (stack.length) {
    const p = stack.pop();
    size++;
    const px = p % SW;
    const py = (p / SW) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx;
        const ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= SW || ny >= SH) continue;
        const q = ny * SW + nx;
        if (azure[q] && label[q] < 0) {
          label[q] = id;
          stack.push(q);
        }
      }
    }
  }
  if (size > bestSize) {
    bestSize = size;
    best = id;
  }
}
if (best < 0) {
  console.error('no mark found in the picture');
  process.exit(1);
}

// The drawing is white and sits inside the square, so it is a hole in the
// azure. A hole that cannot be reached from the edge of the picture is part
// of the mark.
const outside = new Uint8Array(SW * SH);
for (let x = 0; x < SW; x++) {
  stack.push(x, (SH - 1) * SW + x);
}
for (let y = 0; y < SH; y++) {
  stack.push(y * SW, y * SW + SW - 1);
}
for (const p of stack) {
  if (label[p] === best || outside[p]) continue;
  outside[p] = 1;
  stack.push(p);
}
while (stack.length) {
  const p = stack.pop();
  const px = p % SW;
  const py = (p / SW) | 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = px + dx;
      const ny = py + dy;
      if (nx < 0 || ny < 0 || nx >= SW || ny >= SH) continue;
      const q = ny * SW + nx;
      if (label[q] !== best && !outside[q]) {
        outside[q] = 1;
        stack.push(q);
      }
    }
  }
}

// --- the shape of the mark -----------------------------------------------------
let minX = SW;
let maxX = -1;
let minY = SH;
let maxY = -1;
for (let y = 0; y < SH; y++) {
  for (let x = 0; x < SW; x++) {
    const p = y * SW + x;
    const inMark = label[p] === best || (!outside[p] && source.data[at(x, y) + 3] >= 128);
    if (!inMark) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
}

// The mark is a square, but it is not resized into one: it keeps its shape
// and sits on a square of its own, so the corners of the mark stay round.
const side = Math.max(maxX - minX + 1, maxY - minY + 1);
const cropX = minX + Math.floor((maxX - minX + 1 - side) / 2);
const cropY = minY + Math.floor((maxY - minY + 1 - side) / 2);
const CW = Math.min(SW - cropX, side);
const CH = Math.min(SH - cropY, side);

const mark = await sharp(source.data, { raw: { width: SW, height: SH, channels: 4 } })
  .extract({ left: cropX, top: cropY, width: CW, height: CH })
  .raw()
  .toBuffer();

// --- the mark, on the house blue -----------------------------------------------
// The blue of the picture is not the blue of the app, so the mark is
// repainted before it is saved. The white drawing stays white.
const rgba = Buffer.from(mark);
recolourToBrand(rgba, CW, CH);

// --- the assets ----------------------------------------------------------------
const picture = sharp(rgba, { raw: { width: CW, height: CH, channels: 4 } }).resize(
  SIZE,
  SIZE,
  { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } },
);

await picture.clone().png({ compressionLevel: 9, effort: 10 }).toFile('public/roomyai-icon.png');
await picture.clone().png({ compressionLevel: 9, effort: 10 }).toFile('app/icon.png');

// A proof sheet: the mark on the light canvas, on the dark one and on the
// blue of the band.
const small = await sharp('public/roomyai-icon.png').resize({ width: 160 }).toBuffer();
const tiny = await sharp('public/roomyai-icon.png').resize({ width: 32 }).toBuffer();
const tile = async (background, top) =>
  sharp({ create: { width: 200, height: 200, channels: 3, background } })
    .composite([{ input: small, left: 20, top }])
    .png()
    .toBuffer();
const light = await tile('#ebf3fa', 20);
const dark = await tile('#14213a', 20);
const band = await tile('#285098', 20);
await sharp({ create: { width: 600, height: 200, channels: 3, background: '#ebf3fa' } })
  .composite([
    { input: light, left: 0, top: 0 },
    { input: dark, left: 200, top: 0 },
    { input: band, left: 400, top: 0 },
    { input: tiny, left: 20, top: 150 },
  ])
  .png()
  .toFile('/tmp/logo-proof.png');

console.log('mark', CW, 'x', CH, 'at', cropX, cropY);
