/**
 * The brief: the user's own words, and the code that turns them into a room.
 *
 * The rule these tests exist for is the spec's rule: prices and dimensions
 * come from the database, never from model text. So the model passes "3.5 ฟุต"
 * and "24 ตารางเมตร" exactly as the user said them, and the code does every
 * conversion. If the parsing ever moved to the model, the numbers in a room
 * would stop being the numbers the catalogue says.
 */

import { describe, expect, it } from 'vitest';

import {
  checkBrief,
  dimensionsFromArea,
  mergeBrief,
  parseLength,
  parseRoomSize,
  resolveBrief,
  type ResolvedPiece,
} from '@/lib/design/brief';
import type {
  DbClient,
  Product,
  ProductFilter,
  RoomBrief,
} from '@/lib/db/types';

// ---------------------------------------------------------------------------
// Reading a length out of the user's words
// ---------------------------------------------------------------------------

describe('parseLength', () => {
  it('reads feet into centimetres', () => {
    // 3.5 feet is 106.68 cm, which is what a bed is actually sold as.
    expect(parseLength('เตียง 3.5 ฟุต')).toBeCloseTo(106.68, 2);
  });

  it('reads centimetres', () => {
    expect(parseLength('โต๊ะกว้าง 120 ซม.')).toBe(120);
  });

  it('reads metres', () => {
    expect(parseLength('กว้าง 2 เมตร')).toBe(200);
  });

  it('adds a foot and an inch the way a carpenter would', () => {
    // 3 feet is 91.44 cm and 6 inches is 15.24 cm.
    expect(parseLength('3 ฟุต 6 นิ้ว')).toBeCloseTo(106.68, 2);
  });

  it('does not read an area as a length', () => {
    // 24 square metres is not 24 metres long.
    expect(parseLength('ห้อง 24 ตารางเมตร')).toBeNull();
  });

  it('says nothing rather than guessing', () => {
    expect(parseLength('สไตล์มินิมอล')).toBeNull();
    expect(parseLength('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reading the size of the room
// ---------------------------------------------------------------------------

describe('parseRoomSize', () => {
  it('reads an area and derives the floor from it', () => {
    const size = parseRoomSize('ห้องใหญ่ 24 ตารางเมตร');

    expect(size?.area_m2).toBe(24);
    // A room of 24 square metres is not 24 by 24: at a ratio of 3:2 it is
    // 600 by 400.
    expect(size?.width_cm).toBe(600);
    expect(size?.depth_cm).toBe(400);
  });

  it('reads dimensions in metres', () => {
    const size = parseRoomSize('ห้อง 4x5 เมตร');

    expect(size?.width_cm).toBe(400);
    expect(size?.depth_cm).toBe(500);
    expect(size?.area_m2).toBe(20);
  });

  it('reads dimensions in centimetres', () => {
    const size = parseRoomSize('ห้อง 400x500 ซม.');

    expect(size?.width_cm).toBe(400);
    expect(size?.depth_cm).toBe(500);
  });

  it('reads a width and a depth that each carry their own word', () => {
    // The trap: "4 เมตร" on its own is a length, not an area. Read as an
    // area it would make the room four square metres.
    const size = parseRoomSize('กว้าง 4 เมตร ยาว 5 เมตร');

    expect(size?.width_cm).toBe(400);
    expect(size?.depth_cm).toBe(500);
    expect(size?.area_m2).toBe(20);
  });

  it('derives the depth from a width on its own', () => {
    const size = parseRoomSize('ห้องกว้าง 4 เมตร');

    expect(size?.width_cm).toBe(400);
    expect(size?.depth_cm).toBe(267);
  });

  it('says nothing when there is no size in the words', () => {
    expect(parseRoomSize('ห้องสไตล์มินิมอล')).toBeNull();
  });
});

describe('dimensionsFromArea', () => {
  it('gives a room of 24 square metres a floor of 600 by 400', () => {
    expect(dimensionsFromArea(24)).toEqual({ width_cm: 600, depth_cm: 400 });
  });

  it('keeps the area it was given', () => {
    const { width_cm, depth_cm } = dimensionsFromArea(24);
    expect((width_cm / 100) * (depth_cm / 100)).toBeCloseTo(24, 1);
  });
});

// ---------------------------------------------------------------------------
// Whether the brief is worth drawing
// ---------------------------------------------------------------------------

/** A brief with everything the room needs. */
function fullBrief(): RoomBrief {
  return {
    style: 'มินิมอล',
    theme: 'สีชมพู-ขาวพาสเทล',
    purpose: 'ห้องนอน',
    room_size: '24 ตารางเมตร',
    room_size_m2: 24,
    width_cm: 600,
    depth_cm: 400,
    budget_thb: 30000,
    items: [{ category: 'bed', note: 'เตียง 3.5 ฟุต', requested_width: '3.5 ฟุต', product_id: null }],
    instruction: null,
  };
}

describe('checkBrief', () => {
  it('accepts a brief with a style, a size and a piece', () => {
    const check = checkBrief(fullBrief());

    expect(check.ok).toBe(true);
    expect(check.missing).toEqual([]);
  });

  it('says which of the three essentials is missing', () => {
    const check = checkBrief({ ...fullBrief(), style: '  ', items: [] });

    expect(check.ok).toBe(false);
    expect(check.missing).toContain('สไตล์ที่ต้องการ');
    expect(check.missing).toContain('ชิ้นสินค้าที่ต้องมีในห้อง');
  });

  it('says when the size of the room is missing', () => {
    const check = checkBrief({ ...fullBrief(), room_size_m2: null, width_cm: null });

    expect(check.missing).toContain('ขนาดของห้อง');
  });

  it('does not make a colour theme essential', () => {
    const check = checkBrief({ ...fullBrief(), theme: null });

    expect(check.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Merging a change into the room the session already holds
// ---------------------------------------------------------------------------

describe('mergeBrief', () => {
  it('keeps the stored size when the change says nothing about it', () => {
    const merged = mergeBrief(fullBrief(), { instruction: 'เปลี่ยนเป็นสีฟ้า' });

    expect(merged.style).toBe('มินิมอล');
    expect(merged.room_size_m2).toBe(24);
    expect(merged.width_cm).toBe(600);
    expect(merged.items).toHaveLength(1);
    expect(merged.instruction).toBe('เปลี่ยนเป็นสีฟ้า');
  });

  it('reads the size again from the words, never from a stored number', () => {
    // A brief that was stored with a size still has one after the merge: the
    // numbers are parsed again from the user's own words.
    const merged = mergeBrief(fullBrief(), { theme: 'สีฟ้า' });

    expect(merged.room_size).toBe('24 ตารางเมตร');
    expect(merged.room_size_m2).toBe(24);
    expect(merged.width_cm).toBe(600);
  });

  it('takes a new size when the change gives one', () => {
    const merged = mergeBrief(fullBrief(), { room_size: '4x5 เมตร' });

    expect(merged.room_size_m2).toBe(20);
    expect(merged.width_cm).toBe(400);
  });

  it('takes new pieces when the change gives them', () => {
    const merged = mergeBrief(fullBrief(), {
      items: [{ category: 'lamp', note: 'โคมไฟ', requested_width: null, product_id: null }],
    });

    expect(merged.items).toHaveLength(1);
    expect(merged.items[0].category).toBe('lamp');
  });

  it('starts from nothing when there is nothing stored', () => {
    const merged = mergeBrief(null, { style: 'มินิมอล', room_size: '24 ตารางเมตร' });

    expect(merged.style).toBe('มินิมอล');
    expect(merged.room_size_m2).toBe(24);
    expect(merged.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Choosing the pieces
// ---------------------------------------------------------------------------

const BED_NEAR: Product = {
  id: 'bed-near',
  source: 'manual',
  source_url: 'https://example.test/bed-near',
  name_th: 'เตียง 106 ซม.',
  name_en: 'Bed 106',
  category: 'bed',
  style_tags: ['minimal'],
  color: 'สีขาว',
  material: 'ไม้',
  price_thb: 15000,
  width_cm: 106,
  depth_cm: 200,
  height_cm: 40,
  image_url: '/product-images/bed-near.svg',
  in_stock: true,
};

const BED_WIDE: Product = {
  ...BED_NEAR,
  id: 'bed-wide',
  name_th: 'เตียงกว้าง 150 ซม.',
  name_en: 'Bed 150',
  width_cm: 150,
  price_thb: 12000,
};

const LAMP_PASTEL: Product = {
  id: 'lamp-pastel',
  source: 'manual',
  source_url: 'https://example.test/lamp-pastel',
  name_th: 'โคมไฟพาสเทล',
  name_en: 'Pastel lamp',
  category: 'lamp',
  style_tags: ['minimal', 'pastel'],
  color: 'สีขาว',
  material: 'เซรามิก',
  price_thb: 2500,
  width_cm: 30,
  depth_cm: 30,
  height_cm: 150,
  image_url: '/product-images/lamp-pastel.svg',
  in_stock: true,
};

const LAMP_GOLD: Product = {
  ...LAMP_PASTEL,
  id: 'lamp-gold',
  name_th: 'โคมไฟสีทอง',
  name_en: 'Gold lamp',
  style_tags: ['modern'],
  color: 'สีทอง',
  price_thb: 9000,
};

/** A catalogue of rows, and a database that searches it. */
function fakeDb(rows: Product[]): DbClient {
  return {
    async getProduct(id: string) {
      return rows.find((row) => row.id === id) ?? null;
    },
    async searchProducts(filter: ProductFilter) {
      return rows.filter((row) => {
        if (filter.category && row.category !== filter.category) return false;
        if (filter.max_price_thb !== undefined && row.price_thb > filter.max_price_thb) return false;
        if (filter.in_stock_only && !row.in_stock) return false;
        return true;
      });
    },
  } as unknown as DbClient;
}

describe('resolveBrief', () => {
  it('picks the piece whose width is closest to what was asked for', async () => {
    const { pieces } = await resolveBrief(fakeDb([BED_WIDE, BED_NEAR]), {
      ...fullBrief(),
      items: [{ category: 'bed', note: '', requested_width: '3.5 ฟุต', product_id: null }],
    });

    // 3.5 feet is 106.68 cm, and the 106 cm bed is the one that answers it.
    expect(pieces[0].product_id).toBe('bed-near');
    expect(pieces[0].width_gap_cm).toBeCloseTo(0.68, 1);
  });

  it('keeps the piece that was chosen in an earlier version', async () => {
    // The user asked to change the colour, not to get a different bed.
    const { pieces } = await resolveBrief(fakeDb([BED_WIDE, BED_NEAR]), {
      ...fullBrief(),
      items: [
        { category: 'bed', note: '', requested_width: '3.5 ฟุต', product_id: 'bed-wide' },
      ],
    });

    expect(pieces[0].product_id).toBe('bed-wide');
  });

  it('prefers the piece that carries the style and the colour of the room', async () => {
    const { pieces } = await resolveBrief(fakeDb([LAMP_GOLD, LAMP_PASTEL]), {
      ...fullBrief(),
      items: [{ category: 'lamp', note: '', requested_width: null, product_id: null }],
    });

    // The pastel lamp is tagged minimal and pastel, and is white to match the
    // theme; the gold one is neither.
    expect(pieces[0].product_id).toBe('lamp-pastel');
  });

  it('keeps to the budget', async () => {
    const { pieces } = await resolveBrief(fakeDb([LAMP_GOLD, LAMP_PASTEL]), {
      ...fullBrief(),
      budget_thb: 5000,
      items: [{ category: 'lamp', note: '', requested_width: null, product_id: null }],
    });

    expect(pieces).toHaveLength(1);
    expect(pieces[0].price_thb).toBeLessThanOrEqual(5000);
  });

  it('reports a piece the catalogue cannot answer', async () => {
    const { pieces, problems } = await resolveBrief(fakeDb([BED_NEAR]), {
      ...fullBrief(),
      items: [{ category: 'table', note: 'โต๊ะกลาง', requested_width: null, product_id: null }],
    });

    expect(pieces).toHaveLength(0);
    expect(problems).toHaveLength(1);
    expect(problems[0].category).toBe('table');
    expect(problems[0].message).toContain('ไม่มี');
  });

  it('reads the price and the size from the row, never from the request', async () => {
    const { pieces } = await resolveBrief(fakeDb([BED_NEAR]), {
      ...fullBrief(),
      items: [{ category: 'bed', note: '', requested_width: null, product_id: null }],
    });

    const piece: ResolvedPiece = pieces[0];
    expect(piece.price_thb).toBe(BED_NEAR.price_thb);
    expect(piece.width_cm).toBe(BED_NEAR.width_cm);
    expect(piece.depth_cm).toBe(BED_NEAR.depth_cm);
  });
});
