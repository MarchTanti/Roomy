/**
 * The preferences the user can pick, and the phrases they stand for.
 *
 * The chips in the panel and the chips above the composer are the same list,
 * so they live here rather than in two places that would drift apart.
 *
 * Each one carries the sentence it sends. The sentence is the interface's
 * job, not the model's: the model only ever sees a turn of Thai text, and it
 * turns that into a tool call on its own.
 */

export interface Choice {
  id: string;
  label: string;
  /** The sentence the chip sends. */
  prompt: string;
}

/**
 * A style, with the picture of an example room.
 *
 * The picture is drawn once, by the image provider, and kept in the project
 * under `public/style-examples/`. It is a still of a room in that style — the
 * way the style is shown in Gemini's own gallery — so the user can see what
 * they are asking for before they ask.
 */
export interface StyleChoice extends Choice {
  /** The example room, from the project's own files. */
  image: string;
}

export const STYLES: StyleChoice[] = [
  {
    id: 'modern',
    label: 'โมเดิร์น',
    prompt: 'ชอบสไตล์โมเดิร์น',
    image: '/style-examples/modern.jpg',
  },
  {
    id: 'minimalist',
    label: 'มินิมอล',
    prompt: 'ชอบสไตล์มินิมอล',
    image: '/style-examples/minimalist.jpg',
  },
  {
    id: 'scandinavian',
    label: 'สแกนดินาเวีย',
    prompt: 'ชอบสไตล์สแกนดินาเวีย',
    image: '/style-examples/scandinavian.jpg',
  },
  {
    id: 'japandi',
    label: 'จาปันดิ',
    prompt: 'ชอบสไตล์จาปันดิ',
    image: '/style-examples/japandi.jpg',
  },
  {
    id: 'loft',
    label: 'ลอฟต์',
    prompt: 'ชอบสไตล์ลอฟต์',
    image: '/style-examples/loft.jpg',
  },
  {
    id: 'industrial',
    label: 'อินดัสทรีล',
    prompt: 'ชอบสไตล์อินดัสทรีล',
    image: '/style-examples/industrial.jpg',
  },
  {
    id: 'thai',
    label: 'ไทยร่วมสมัย',
    prompt: 'ชอบสไตล์ไทยร่วมสมัย',
    image: '/style-examples/thai.jpg',
  },
];

export const CATEGORIES: Choice[] = [
  { id: 'sofa', label: 'โซฟา', prompt: 'อยากได้โซฟาสำหรับห้องนั่งเล่น' },
  { id: 'armchair', label: 'เก้าอี้', prompt: 'อยากได้เก้าอี้นั่ง' },
  { id: 'table', label: 'โต๊ะ', prompt: 'อยากได้โต๊ะ' },
  { id: 'shelf', label: 'ชั้นวาง', prompt: 'อยากได้ชั้นวาง' },
  { id: 'lamp', label: 'โคมไฟ', prompt: 'อยากได้โคมไฟ' },
  { id: 'bed', label: 'เตียง', prompt: 'อยากได้เตียง' },
  { id: 'desk', label: 'โต๊ะทำงาน', prompt: 'อยากได้โต๊ะทำงาน' },
  { id: 'chair', label: 'เก้าอี้ทำงาน', prompt: 'อยากได้เก้าอี้ทำงาน' },
  { id: 'cabinet', label: 'ตู้', prompt: 'อยากได้ตู้เก็บของ' },
  { id: 'rug', label: 'พรม', prompt: 'อยากได้พรมปูพื้น' },
  { id: 'tv_stand', label: 'โต๊ะวางทีวี', prompt: 'อยากได้โต๊ะวางทีวี' },
  { id: 'dresser', label: 'ตู้แต่งตัว', prompt: 'อยากได้ตู้แต่งตัว' },
];

export interface Budget {
  thb: number;
  label: string;
  prompt: string;
}

export const BUDGETS: Budget[] = [
  { thb: 5000, label: '≤ 5,000', prompt: 'งบประมาณไม่เกิน 5,000 บาท' },
  { thb: 15000, label: '≤ 15,000', prompt: 'งบประมาณไม่เกิน 15,000 บาท' },
  { thb: 30000, label: '≤ 30,000', prompt: 'งบประมาณไม่เกิน 30,000 บาท' },
  { thb: 60000, label: '≤ 60,000', prompt: 'งบประมาณไม่เกิน 60,000 บาท' },
];

/**
 * The first questions a newcomer is likely to ask.
 *
 * They are full sentences, not keywords, because the model reads a turn of
 * text and answers it — a bare "โซฟา" leaves it guessing what the user
 * wants done with it.
 */
export const STARTERS: { title: string; detail: string; prompt: string }[] = [
  {
    title: 'โซฟาสำหรับห้องนั่งเล่น',
    detail: 'สไตล์โมเดิร์น งบ 15,000',
    prompt: 'ชอบสไตล์โมเดิร์น งบประมาณไม่เกิน 15,000 บาท อยากได้โซฟาสำหรับห้องนั่งเล่น',
  },
  {
    title: 'ห้องเล็กต้องการโต๊ะกลาง',
    detail: 'ขอทางเลือกที่พอดีกับพื้นที่',
    prompt: 'ห้องนั่งเล่นของฉันเล็กมาก อยากได้โต๊ะกลางที่ไม่ทำให้ห้องแน่นเกินไป',
  },
  {
    title: 'ชุดทำงานในห้อง',
    detail: 'โต๊ะ + เก้าอี้ เน้นสไตล์สแกนดินาเวีย',
    prompt: 'อยากจัดโต๊ะทำงานในห้อง ให้เป็นโต๊ะทำงานกับเก้าอี้ที่เข้ากัน สไตล์สแกนดินาเวีย งบประมาณรวม 20,000 บาท',
  },
  {
    title: 'เริ่มจากรูปห้อง',
    detail: 'อัปโหลดรูป แล้วผมจะดูสไตล์ให้',
    prompt: 'ฉันกำลังจะอัปโหลดรูปห้อง ช่วยดูสไตล์และสีในห้องให้หน่อย แล้วแนะนำเฟอร์นิเจอร์ที่เข้ากัน',
  },
];

/** The quick chips above the composer — the four things people ask for first. */
export const QUICK_CHIPS: { label: string; prompt: string }[] = [
  { label: 'โมเดิร์น', prompt: 'ชอบสไตล์โมเดิร์น' },
  { label: 'สแกนดินาเวีย', prompt: 'ชอบสไตล์สแกนดินาเวีย' },
  { label: 'งบ 15,000', prompt: 'งบประมาณไม่เกิน 15,000 บาท' },
  { label: 'อยากได้โซฟา', prompt: 'อยากได้โซฟาสำหรับห้องนั่งเล่น' },
];
