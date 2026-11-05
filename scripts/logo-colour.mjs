/*
 * The house colour of the mark.
 *
 * The picture the logo came in was a light azure; the app's own blue is the
 * deep one of the buttons and the links (#0058c8). This is where the mark is
 * brought back to that colour.
 *
 * The mark is one flat ground with a white drawing painted over it, so the
 * two have to be taken apart before the colour can change — otherwise the
 * drawing turns blue as well and the mark stops being a drawing.
 *
 * The ground of the picture is one colour, so it can be measured: the median
 * of the azure pixels is the ground, and every pixel is then read against it.
 * What is left on top of the ground — read against it — is the white of the
 * drawing, and it is painted back over the new ground, which is flat.
 */

/** The colour of the buttons and the links: the house blue. */
export const BRAND_HEX = '#0058c8';

/** The house blue, as red, green and blue. */
const BASE = [0, 88, 200];

/**
 * How far a pixel has to lean blue before it counts as the ground and not the
 * drawing on top of it. The drawing is white, so it is nowhere near blue.
 */
const CHROMA_MIN = 60;

/**
 * Below this a pixel is the ground itself, and it is painted the house blue
 * exactly. The ground of the picture is not perfectly even, and a flat ground
 * is the whole point of the change.
 */
const GROUND_FLAT = 0.02;

const clamp = (value, low, high) => (value < low ? low : value > high ? high : value);

/** The middle value of a list, which the median of the ground is. */
function median(values) {
  values.sort((a, b) => a - b);
  return values[values.length >> 1];
}

/**
 * Repaints a mark in the house blue.
 *
 * The buffer is the raw RGBA of the mark, and it is changed in place.
 */
export function recolourToBrand(rgba, width, height) {
  // --- the ground of the picture ----------------------------------------------
  const reds = [];
  const greens = [];
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    if (rgba[o + 3] < 250) continue;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    if (b - r < CHROMA_MIN) continue;
    reds.push(r);
    greens.push(g);
  }
  if (reds.length < 16) return rgba;
  const groundR = median(reds);
  const groundG = median(greens);

  // --- the mark, in the house blue ---------------------------------------------
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    if (rgba[o + 3] === 0) continue;
    const r = rgba[o];
    const g = rgba[o + 1];

    // What sits on top of the ground: the white of the drawing. It is read
    // from the red and the green, which have room to spare; the blue of the
    // picture is nearly saturated and would say nothing.
    const white = clamp(
      ((r - groundR) / (255 - groundR) + (g - groundG) / (255 - groundG)) / 2,
      0,
      1,
    );
    const paint = white < GROUND_FLAT ? 0 : white;

    for (let k = 0; k < 3; k++) {
      rgba[o + k] = paint * 255 + (1 - paint) * BASE[k];
    }
  }

  return rgba;
}
