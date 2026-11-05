/**
 * Thai words the shops use, and the English words the image prompt uses.
 *
 * The catalogue row keeps a colour and a material because the prompt has to
 * describe the piece: "a beige fabric sofa" is something a model can draw.
 * The shops write those words in Thai, so they are translated here, once.
 */

export const COLOURS: { th: string; en: string }[] = [
  { th: 'ขาว', en: 'white' },
  { th: 'ดำ', en: 'black' },
  { th: 'เทา', en: 'grey' },
  { th: 'เบจ', en: 'beige' },
  { th: 'ครีม', en: 'cream' },
  { th: 'น้ำตาล', en: 'brown' },
  { th: 'ไม้', en: 'wood' },
  { th: 'เขียว', en: 'green' },
  { th: 'น้ำเงิน', en: 'blue' },
  { th: 'แดง', en: 'red' },
  { th: 'เหลือง', en: 'yellow' },
  { th: 'ส้ม', en: 'orange' },
  { th: 'ม่วง', en: 'purple' },
  { th: 'ชมพู', en: 'pink' },
  { th: 'ทอง', en: 'gold' },
  { th: 'เงิน', en: 'silver' },
];

export const MATERIALS: { th: string; en: string }[] = [
  { th: 'ผ้าไม่ทอ', en: 'non-woven fabric' },
  { th: 'ผ้า', en: 'fabric' },
  { th: 'หนัง', en: 'leather' },
  { th: 'กำมะหยี่', en: 'velvet' },
  { th: 'ลินิน', en: 'linen' },
  { th: 'ไม้เนื้อแข็ง', en: 'solid wood' },
  { th: 'วีนีย์', en: 'veneer' },
  { th: 'ผิวไม้', en: 'wood veneer' },
  { th: 'ไม้', en: 'wood' },
  { th: 'หวายพลาสติก', en: 'plastic rattan' },
  { th: 'หวาย', en: 'rattan' },
  { th: 'โลหะ', en: 'metal' },
  { th: 'เหล็ก', en: 'steel' },
  { th: 'สแตนเลส', en: 'stainless steel' },
  { th: 'พลาสติก', en: 'plastic' },
  { th: 'แก้ว', en: 'glass' },
  { th: 'หิน', en: 'stone' },
  { th: 'ยาง', en: 'rubber' },
  { th: 'ไฟเบอร์', en: 'fibre' },
];

/**
 * The shop's own list, split into its parts.
 *
 * A product often has more than one colour or material — "เทา, ดำ", "หวาย,
 * โลหะ" — and the shop writes the one that describes the piece first. So the
 * parts are read in order, and the first part that is understood is the one
 * that counts.
 */
function parts(th: string): string[] {
  return th
    .split(/[,/]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** The English word for a Thai colour, or null when there is no match. */
export function translateColour(th: string | null | undefined): string | null {
  if (!th) return null;
  for (const part of parts(th)) {
    const known = COLOURS.find((candidate) => part.includes(candidate.th));
    if (known) return known.en;
  }
  return null;
}

/** The English word for a Thai material, or null when there is no match. */
export function translateMaterial(th: string | null | undefined): string | null {
  if (!th) return null;
  for (const part of parts(th)) {
    const known = MATERIALS.find((candidate) => part.includes(candidate.th));
    if (known) return known.en;
  }
  return null;
}
