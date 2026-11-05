/**
 * The checks of the chat scenarios.
 *
 * These are the rules the report is judged by, so they are pinned here: a
 * check that stops noticing a wrong answer is worse than no check at all.
 */

import { describe, expect, it } from 'vitest';

import type { Json, Preferences } from '@/lib/db/types';
import type { DesignView } from '@/lib/design/view';
import {
  CHAT_CASES,
  buildChatCases,
  buildTurnFacts,
  evaluateCase,
  extractBahtAmounts,
  globalChecks,
  type CatalogueProduct,
  type TurnFacts,
} from '@/lib/results/chat-cases';
import type { ChatTurn, FitToolResult } from '@/lib/results/chat-run';

const NO_PREFERENCES: Preferences = { style: null, budget_thb: null, category: null };

/** A catalogue row, with only the fields the checks look at. */
function product(overrides: Partial<CatalogueProduct> = {}): CatalogueProduct {
  return {
    id: 'p-1',
    category: 'sofa',
    name_th: 'โซฟา',
    name_en: 'Sofa',
    price_thb: 12_900,
    width_cm: 210,
    depth_cm: 88,
    height_cm: 78,
    in_stock: true,
    style_tags: ['scandinavian'],
    ...overrides,
  };
}

const CATALOGUE: CatalogueProduct[] = [
  product({ id: 'p-1', price_thb: 12_900 }),
  product({ id: 'p-2', price_thb: 18_900 }),
  product({ id: 'p-3', category: 'chair', name_th: 'เก้าอี้', price_thb: 6_990, style_tags: ['modern'] }),
];

function facts(overrides: Partial<TurnFacts> = {}): TurnFacts {
  return {
    reply: '',
    toolCalls: [],
    products: null,
    comparison: null,
    preferences: NO_PREFERENCES,
    fitResults: [],
    knownClearances: [],
    catalogue: CATALOGUE,
    statedNumbers: [20_000],
    design: null,
    previous: null,
    truncated: false,
    ...overrides,
  };
}

function fitResult(overrides: Partial<FitToolResult> = {}): FitToolResult {
  return {
    product_id: 'p-1',
    product_name: 'โซฟาคัทจ้า 3 ที่นั่ง',
    verdict: 'fits',
    reasons: ['พื้นที่วางได้'],
    space: { width_cm: 240, depth_cm: 120, height_cm: 260 },
    price_thb: 12_900,
    clearances: { width: 30, depth: 32, height: 182 },
    ...overrides,
  };
}

function checkNamed(checks: { name: string; ok: boolean; detail: string }[], name: string) {
  return checks.find((check) => check.name === name);
}

describe('extractBahtAmounts', () => {
  it('takes the amounts that sit next to a unit', () => {
    expect(extractBahtAmounts('ราคา 12,900 บาท')).toEqual([12_900]);
    expect(extractBahtAmounts('฿12,900')).toEqual([12_900]);
    expect(extractBahtAmounts('งบ 20,000 บาท และ 5,000 บาท')).toEqual([20_000, 5_000]);
  });

  it('leaves the numbers that are not money alone', () => {
    expect(extractBahtAmounts('กว้าง 240 ซม. ลึก 120 ซม.')).toEqual([]);
    expect(extractBahtAmounts('โซฟาคัทจ้า 3 ที่นั่ง')).toEqual([]);
  });
});

describe('evaluateCase', () => {
  it('passes when the tool the task needed was called', () => {
    const testCase = {
      name: 'x',
      title: 'x',
      intent: 'x',
      prompt: 'x',
      expect: { tools: ['searchFurniture'] },
    };

    const good = evaluateCase(testCase, facts({ toolCalls: [{ name: 'searchFurniture', args: {} }] }));
    expect(checkNamed(good, 'เรียกเครื่องมือ searchFurniture')?.ok).toBe(true);

    const bad = evaluateCase(testCase, facts({ toolCalls: [{ name: 'checkFit', args: {} }] }));
    expect(checkNamed(bad, 'เรียกเครื่องมือ searchFurniture')?.ok).toBe(false);
  });

  it('fails a price that is not in the database', () => {
    const testCase = {
      name: 'x',
      title: 'x',
      intent: 'x',
      prompt: 'x',
      expect: { expect_price_thb: 12_900 },
    };

    const good = evaluateCase(testCase, facts({ reply: 'ราคา 12,900 บาทครับ' }));
    expect(checkNamed(good, 'ราคาที่ตอบตรงกับฐานข้อมูล (12,900 บาท)')?.ok).toBe(true);

    const bad = evaluateCase(testCase, facts({ reply: 'ราคา 9,900 บาทครับ' }));
    expect(checkNamed(bad, 'ราคาที่ตอบตรงกับฐานข้อมูล (12,900 บาท)')?.ok).toBe(false);
  });

  it('fails a reply that denies a verdict the rule gave', () => {
    const testCase = {
      name: 'x',
      title: 'x',
      intent: 'x',
      prompt: 'x',
      expect: { agree_with_verdict: true },
    };

    const contradicting = evaluateCase(
      testCase,
      facts({ reply: 'อันนี้วางไม่ได้ครับ เกินพื้นที่', fitResults: [fitResult({ verdict: 'fits' })] }),
    );
    expect(checkNamed(contradicting, 'คำตอบไม่ขัดกับผลตรวจของกฎ')?.ok).toBe(false);

    const agreeing = evaluateCase(
      testCase,
      facts({ reply: 'วางได้ครับ เหลือช่องว่าง 30 ซม.', fitResults: [fitResult({ verdict: 'fits' })] }),
    );
    expect(checkNamed(agreeing, 'คำตอบไม่ขัดกับผลตรวจของกฎ')?.ok).toBe(true);
  });

  it('fails a reply that stays quiet about a piece that does not fit', () => {
    const testCase = {
      name: 'x',
      title: 'x',
      intent: 'x',
      prompt: 'x',
      expect: { agree_with_verdict: true },
    };

    const hiding = evaluateCase(
      testCase,
      facts({ reply: 'วางได้สบายๆ ครับ', fitResults: [fitResult({ verdict: 'does_not_fit' })] }),
    );
    expect(checkNamed(hiding, 'คำตอบไม่ขัดกับผลตรวจของกฎ')?.ok).toBe(false);
  });

  it('does not complain about a piece that is merely snug', () => {
    const testCase = {
      name: 'x',
      title: 'x',
      intent: 'x',
      prompt: 'x',
      expect: { agree_with_verdict: true },
    };

    const snug = evaluateCase(
      testCase,
      facts({ reply: 'วางได้ครับ แต่ชิดมาก เหลือช่องว่างแค่ 3 ซม.', fitResults: [fitResult({ verdict: 'tight' })] }),
    );
    expect(checkNamed(snug, 'คำตอบไม่ขัดกับผลตรวจของกฎ')?.ok).toBe(true);
  });

  it('checks the cheapest product of a comparison', () => {
    const testCase = {
      name: 'x',
      title: 'x',
      intent: 'x',
      prompt: 'x',
      expect: { comparison_cheapest_is_min: true },
    };

    const comparison = {
      products: [
        {
          id: 'a',
          name_th: 'เก้าอี้',
          name_en: 'chair',
          category: 'chair',
          color: null,
          material: null,
          price_thb: 6_990,
          width_cm: 50,
          depth_cm: 50,
          height_cm: 80,
          image_url: '',
          in_stock: true,
          verdict: null,
          reasons: [],
        },
        {
          id: 'b',
          name_th: 'โซฟา',
          name_en: 'sofa',
          category: 'sofa',
          color: null,
          material: null,
          price_thb: 12_900,
          width_cm: 210,
          depth_cm: 88,
          height_cm: 78,
          image_url: '',
          in_stock: true,
          verdict: null,
          reasons: [],
        },
      ],
      space: null,
      cheapest_id: 'a',
      best_fit_id: null,
    };

    const good = evaluateCase(testCase, facts({ comparison }));
    expect(checkNamed(good, 'ตัวที่ถูกสุดตรงกับราคาต่ำสุด')?.ok).toBe(true);

    const bad = evaluateCase(testCase, facts({ comparison: { ...comparison, cheapest_id: 'b' } }));
    expect(checkNamed(bad, 'ตัวที่ถูกสุดตรงกับราคาต่ำสุด')?.ok).toBe(false);
  });

  it('checks what the database remembered', () => {
    const testCase = {
      name: 'x',
      title: 'x',
      intent: 'x',
      prompt: 'x',
      expect: { preferences: { budget_thb: 25_000, style_in_catalogue: true } },
    };

    const good = evaluateCase(
      testCase,
      facts({ preferences: { style: 'scandinavian', budget_thb: 25_000, category: null } }),
    );
    expect(checkNamed(good, 'ฐานข้อมูลจำงบไว้เป็น 25,000 บาท')?.ok).toBe(true);
    expect(checkNamed(good, 'สไตล์ที่จำไว้เป็นสไตล์ที่แคตตาล็อกมีจริง')?.ok).toBe(true);

    const bad = evaluateCase(
      testCase,
      facts({ preferences: { style: 'สแกนดินาเวีย', budget_thb: 20_000, category: null } }),
    );
    expect(checkNamed(bad, 'ฐานข้อมูลจำงบไว้เป็น 25,000 บาท')?.ok).toBe(false);
    expect(checkNamed(bad, 'สไตล์ที่จำไว้เป็นสไตล์ที่แคตตาล็อกมีจริง')?.ok).toBe(false);
  });
});

describe('the checks of a room', () => {
  const BED = product({
    id: 'bed-1',
    category: 'bed',
    name_th: 'เตียงสแลท ขนาด 3 ฟุต',
    price_thb: 10_900,
    width_cm: 105,
    depth_cm: 200,
    height_cm: 40,
    style_tags: ['modern'],
  });
  const LAMP = product({
    id: 'lamp-1',
    category: 'lamp',
    name_th: 'โคมตั้งพื้นนอร์ดิก',
    price_thb: 3_490,
    width_cm: 40,
    depth_cm: 40,
    height_cm: 150,
    style_tags: ['scandinavian', 'minimalist'],
  });
  const WIDE_BED = product({
    id: 'bed-2',
    category: 'bed',
    name_th: 'เตียงอีดานัส ขนาด 4 ฟุต',
    price_thb: 19_900,
    width_cm: 140,
    depth_cm: 200,
    height_cm: 40,
    style_tags: ['classic'],
  });

  /** The room the tool drew: 24 square metres, a bed and a lamp. */
  function design(overrides: Partial<DesignView> = {}): DesignView {
    return {
      image_id: 'img-1',
      url: 'https://example.test/room.jpg',
      expires_at: null,
      version: 1,
      style: 'มินิมอล',
      theme: 'สีชมพู-ขาวพาสเทล',
      purpose: 'ห้องนอน',
      room_size_m2: 24,
      width_cm: 600,
      depth_cm: 400,
      total_price_thb: 14_390,
      pieces: [
        {
          product_id: 'bed-1',
          name_th: 'เตียงสแลท ขนาด 3 ฟุต',
          name_en: 'SLATT bed',
          category: 'bed',
          color: null,
          material: null,
          price_thb: 10_900,
          width_cm: 105,
          depth_cm: 200,
          height_cm: 40,
          image_url: '',
          note: 'เตียง 3.5 ฟุต',
          requested_width_cm: 106.68,
          width_gap_cm: 1.7,
        },
        {
          product_id: 'lamp-1',
          name_th: 'โคมตั้งพื้นนอร์ดิก',
          name_en: 'Nordic floor lamp',
          category: 'lamp',
          color: 'white',
          material: null,
          price_thb: 3_490,
          width_cm: 40,
          depth_cm: 40,
          height_cm: 150,
          image_url: '',
          note: 'โคมไฟที่เหมาะกับการเลี้ยงสัตว์',
          requested_width_cm: null,
          width_gap_cm: null,
        },
      ],
      instruction: null,
      notes: [],
      image_quota_left: 9,
      ...overrides,
    };
  }

  const testCase = {
    name: 'design_a_room',
    title: 'แต่งห้องทั้งห้องตามคำขอ',
    intent: 'ให้บอทถามยืนยันก่อนวาด',
    prompt: 'อยากได้ห้องนอนสไตล์มินิมอล 24 ตารางเมตร เตียง 3.5 ฟุต',
    follow_up: 'วาดให้ดูเลยครับ',
    expect: {
      design: {
        not_drawn_before: true,
        asked_before: ['ยืนยัน', 'วาดเลย', 'วาดให้', 'ไหม'],
        drawn: true,
        style: 'มินิมอล',
        room_size_m2: 24,
        width_cm: 600,
        depth_cm: 400,
        categories: ['bed', 'lamp'],
        pieces_from_catalogue: true,
        total_is_sum: true,
        max_total_thb: 30_000,
        requested_width: { category: 'bed', requested: '3.5 ฟุต' },
      },
    },
  };

  /** The facts of a room that was drawn only after the user said yes. */
  function roomFacts(overrides: Partial<TurnFacts> = {}): TurnFacts {
    return facts({
      catalogue: [BED, LAMP],
      design: design(),
      previous: { reply: 'แผนนี้ใช่ไหมครับ ถ้าใช่ผมวาดเลย', toolCalls: [], design: null },
      ...overrides,
    });
  }

  it('passes a room that was asked for, confirmed and drawn', () => {
    const checks = evaluateCase(testCase, roomFacts());

    for (const check of checks) {
      expect(check.ok, `${check.name}: ${check.detail}`).toBe(true);
    }
  });

  it('fails a room that was drawn before the user confirmed', () => {
    const checks = evaluateCase(
      testCase,
      roomFacts({ previous: { reply: 'กำลังวาดให้นะครับ', toolCalls: [], design: design() } }),
    );

    expect(checkNamed(checks, 'รอบแรกยังไม่วาดห้อง')?.ok).toBe(false);
  });

  it('fails a scenario with no turn before the drawing to look at', () => {
    const checks = evaluateCase(testCase, roomFacts({ previous: null }));

    expect(checkNamed(checks, 'รอบแรกยังไม่วาดห้อง')?.ok).toBe(false);
  });

  it('fails a first answer that never asked', () => {
    const checks = evaluateCase(
      testCase,
      roomFacts({ previous: { reply: 'เรียบร้อยครับ', toolCalls: [], design: null } }),
    );

    expect(checkNamed(checks, 'บอทถามยืนยันก่อนวาดห้อง')?.ok).toBe(false);
  });

  it('accepts a first answer that asked as a question', () => {
    const checks = evaluateCase(
      testCase,
      roomFacts({ previous: { reply: 'ให้วาดตามแผนนี้ไหม', toolCalls: [], design: null } }),
    );

    expect(checkNamed(checks, 'บอทถามยืนยันก่อนวาดห้อง')?.ok).toBe(true);
  });

  it('accepts a first answer that ended with a question mark', () => {
    // The wording is the model's own, so a question mark is enough.
    const checks = evaluateCase(
      { ...testCase, expect: { design: { asked_before: ['ยืนยัน'] } } },
      roomFacts({ previous: { reply: 'ทำให้เลยนะครับ? สรุปคือแบบนี้', toolCalls: [], design: null } }),
    );

    expect(checkNamed(checks, 'บอทถามยืนยันก่อนวาดห้อง')?.ok).toBe(true);
  });

  it('fails a room with no picture', () => {
    const checks = evaluateCase(testCase, roomFacts({ design: design({ image_id: '' }) }));

    expect(checkNamed(checks, 'ได้ภาพห้องที่วาดแล้ว')?.ok).toBe(false);
  });

  it('accepts the style in the model’s own words', () => {
    const checks = evaluateCase(testCase, roomFacts({ design: design({ style: 'minimal' }) }));

    expect(checkNamed(checks, 'สไตล์ห้องตรงกับที่ผู้ใช้บอก')?.ok).toBe(true);
  });

  it('accepts a style the model wrote in more than one word', () => {
    const checks = evaluateCase(testCase, roomFacts({ design: design({ style: 'มินิมอล พาสเทล' }) }));

    expect(checkNamed(checks, 'สไตล์ห้องตรงกับที่ผู้ใช้บอก')?.ok).toBe(true);
  });

  it('fails a style nobody asked for', () => {
    const checks = evaluateCase(testCase, roomFacts({ design: design({ style: 'loft' }) }));

    expect(checkNamed(checks, 'สไตล์ห้องตรงกับที่ผู้ใช้บอก')?.ok).toBe(false);
  });

  it('fails a size the user did not give', () => {
    const checks = evaluateCase(testCase, roomFacts({ design: design({ room_size_m2: 30 }) }));

    expect(checkNamed(checks, 'ขนาดห้องมาจากคำขอของผู้ใช้')?.ok).toBe(false);
  });

  it('fails a room that is missing a piece the user asked for', () => {
    const onlyBed = design();
    onlyBed.pieces = onlyBed.pieces.filter((piece) => piece.category === 'bed');

    const checks = evaluateCase(testCase, roomFacts({ design: onlyBed }));

    expect(checkNamed(checks, 'ห้องมีชิ้นที่ผู้ใช้ขอครบ')?.ok).toBe(false);
  });

  it('fails a piece that is not in the catalogue', () => {
    const invented = design();
    invented.pieces = [
      { ...invented.pieces[0], product_id: 'bed-from-nowhere' },
      invented.pieces[1],
    ];

    const checks = evaluateCase(testCase, roomFacts({ design: invented }));

    expect(checkNamed(checks, 'เฟอร์นิเจอร์ในห้องเป็นสินค้าจริงจากแคตตาล็อก')?.ok).toBe(false);
  });

  it('fails a price the catalogue does not have', () => {
    const cheap = design();
    cheap.pieces = [{ ...cheap.pieces[0], price_thb: 9_999 }, cheap.pieces[1]];

    const checks = evaluateCase(testCase, roomFacts({ design: cheap }));

    expect(checkNamed(checks, 'เฟอร์นิเจอร์ในห้องเป็นสินค้าจริงจากแคตตาล็อก')?.ok).toBe(false);
  });

  it('fails a total that is not the sum of the pieces', () => {
    const checks = evaluateCase(testCase, roomFacts({ design: design({ total_price_thb: 12_000 }) }));

    expect(checkNamed(checks, 'ราคารวมเท่ากับผลรวมของชิ้นสินค้า')?.ok).toBe(false);
  });

  it('fails a room that costs more than the budget', () => {
    const checks = evaluateCase(testCase, roomFacts({ design: design({ total_price_thb: 40_000 }) }));

    expect(checkNamed(checks, 'ราคารวมไม่เกินงบที่ผู้ใช้ให้')?.ok).toBe(false);
  });

  it('fails a width the model converted by itself', () => {
    const converted = design();
    // "3.5 ฟุต" is 106.68 cm. A model that did the arithmetic would have
    // passed "106 ซม." and the code would have read 106.
    converted.pieces = [{ ...converted.pieces[0], requested_width_cm: 106 }, converted.pieces[1]];

    const checks = evaluateCase(testCase, roomFacts({ design: converted }));

    expect(checkNamed(checks, 'ขนาดที่ขอมาจากคำพูดของผู้ใช้เอง')?.ok).toBe(false);
  });

  it('fails a bed that is not the catalogue’s closest to the width asked for', () => {
    const wide = design();
    wide.pieces = [
      { ...wide.pieces[0], product_id: 'bed-2', width_cm: 140, width_gap_cm: 33.32 },
      wide.pieces[1],
    ];

    const checks = evaluateCase(testCase, roomFacts({ design: wide, catalogue: [BED, WIDE_BED, LAMP] }));

    expect(checkNamed(checks, 'เลือกชิ้นที่ใกล้ขนาดที่ผู้ใช้ขอที่สุด')?.ok).toBe(false);
  });
});

describe('globalChecks', () => {
  const PRICE_CHECK = 'ตัวเลขเงินทุกตัวในคำตอบต้องมาจากฐานข้อมูลหรือคำนวณจากตัวเลขเหล่านั้น';
  const TRUNCATED_CHECK = 'โมเดลตอบได้จริง (ไม่ถูกตัดกลางคัน)';

  it('fails a turn the model never answered, even when the text is not empty', () => {
    // The loop says something rather than leave an empty bubble, so the text
    // is there — but the turn still happened without an answer.
    const checks = globalChecks(facts({ reply: 'ขออภัยครับ ตอบไม่ทัน ลองถามอีกครั้งนะครับ', truncated: true }));
    expect(checkNamed(checks, TRUNCATED_CHECK)?.ok).toBe(false);
    expect(checkNamed(checks, 'มีคำตอบกลับ')?.ok).toBe(true);
  });

  it('passes a turn that was answered', () => {
    const checks = globalChecks(facts({ reply: 'วางได้พอดีครับ', truncated: false }));
    expect(checkNamed(checks, TRUNCATED_CHECK)?.ok).toBe(true);
  });

  it('fails a made-up price', () => {
    const checks = globalChecks(facts({ reply: 'ราคา 7,777 บาทครับ' }));
    const check = checkNamed(checks, PRICE_CHECK);
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('7,777');
  });

  it('allows a price from the catalogue and a number the user typed', () => {
    const checks = globalChecks(facts({ reply: 'ราคา 12,900 บาท อยู่ในงบ 20,000 บาทครับ' }));
    expect(checkNamed(checks, PRICE_CHECK)?.ok).toBe(true);
  });

  it('allows a price the model rounded', () => {
    const checks = globalChecks(facts({ reply: 'ประมาณ 13,000 บาทครับ' }));
    expect(checkNamed(checks, PRICE_CHECK)?.ok).toBe(true);
  });

  it('allows a total the model added up from the database', () => {
    // 12,900 + 4,490 = 17,390 — arithmetic on the catalogue's numbers, not a
    // price the model made up.
    const checks = globalChecks(
      facts({
        reply: 'รวมกัน 17,390 บาทครับ',
        catalogue: [product({ id: 'a', price_thb: 12_900 }), product({ id: 'b', price_thb: 4_490 })],
      }),
    );
    expect(checkNamed(checks, PRICE_CHECK)?.ok).toBe(true);
  });

  it('fails an empty answer', () => {
    const checks = globalChecks(facts({ reply: '   ' }));
    expect(checkNamed(checks, 'มีคำตอบกลับ')?.ok).toBe(false);
  });

  it('fails a clearance the tool never gave', () => {
    const CLEARANCE_CHECK = 'ตัวเลขช่องว่างที่บอกในคำตอบต้องมาจากผลตรวจของเครื่องมือ';

    const good = globalChecks(
      facts({ reply: 'วางได้ครับ เหลือระยะ 30 ซม.', knownClearances: [30, 32, 182] }),
    );
    expect(checkNamed(good, CLEARANCE_CHECK)?.ok).toBe(true);

    const bad = globalChecks(
      facts({ reply: 'เหลือพื้นที่ด้านข้าง 40 ซม. ครับ', knownClearances: [30, 32, 182] }),
    );
    expect(checkNamed(bad, CLEARANCE_CHECK)?.ok).toBe(false);
    expect(checkNamed(bad, CLEARANCE_CHECK)?.detail).toContain('40');
  });

  it('does not mistake a width for a clearance', () => {
    const CLEARANCE_CHECK = 'ตัวเลขช่องว่างที่บอกในคำตอบต้องมาจากผลตรวจของเครื่องมือ';
    const checks = globalChecks(facts({ reply: 'กว้าง 210 ซม. ลึก 88 ซม. ราคา 12,900 บาท' }));
    expect(checkNamed(checks, CLEARANCE_CHECK)?.ok).toBe(true);
  });
});

describe('buildTurnFacts', () => {
  function turn(overrides: Partial<ChatTurn> = {}): ChatTurn {
    return {
      ok: true,
      error: null,
      reply: 'วาดให้แล้วครับ',
      tool_calls: [{ name: 'designRoom', args: { confirmed: true } }],
      iterations: 3,
      hit_iteration_cap: false,
      truncated: false,
      products: null,
      comparison: null,
      design: {
        image_id: 'img-1',
        url: null,
        expires_at: null,
        version: 1,
        style: 'มินิมอล',
        theme: null,
        purpose: null,
        room_size_m2: 24,
        width_cm: 600,
        depth_cm: 400,
        total_price_thb: 14_390,
        pieces: [],
        instruction: null,
        notes: [],
        image_quota_left: 9,
      },
      preferences: NO_PREFERENCES,
      chat_turns_left: 18,
      usage: { in: 10, out: 20, think: 0 },
      first_token_ms: 100,
      latency_ms: 900,
      ...overrides,
    };
  }

  it('reads the facts of a turn out of the turn', () => {
    const facts = buildTurnFacts(turn(), [], [30, 32], CATALOGUE, [20_000]);

    expect(facts.reply).toBe('วาดให้แล้วครับ');
    expect(facts.toolCalls.map((call) => call.name)).toEqual(['designRoom']);
    expect(facts.design?.image_id).toBe('img-1');
    expect(facts.knownClearances).toEqual([30, 32]);
    expect(facts.catalogue).toHaveLength(3);
    expect(facts.statedNumbers).toEqual([20_000]);
    expect(facts.previous).toBeNull();
  });

  it('carries the turn before it, when the scenario has two', () => {
    const previous = { reply: 'ให้วาดไหม', toolCalls: [], design: null };
    const facts = buildTurnFacts(turn(), [], [], CATALOGUE, [], previous);

    expect(facts.previous?.reply).toBe('ให้วาดไหม');
  });

  it('does not share the arrays with the caller', () => {
    const clearances = [30];
    const facts = buildTurnFacts(turn(), [], clearances, CATALOGUE, []);

    clearances.push(32);
    expect(facts.knownClearances).toEqual([30]);
  });
});

describe('CHAT_CASES', () => {
  it('gives every case a name, a prompt and a title', () => {
    for (const testCase of CHAT_CASES) {
      expect(testCase.name).toMatch(/^[a-z_]+$/);
      expect(testCase.prompt.trim().length).toBeGreaterThan(0);
      expect(testCase.title.trim().length).toBeGreaterThan(0);
      expect(testCase.intent.trim().length).toBeGreaterThan(0);
    }
  });

  it('has no two cases with the same name', () => {
    const names = CHAT_CASES.map((testCase) => testCase.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('has one scenario with a second turn, and it is the room', () => {
    // The room is drawn in the answer to "yes", so it needs two turns; the
    // others are a question and an answer.
    const twoTurns = CHAT_CASES.filter((testCase) => testCase.follow_up);
    expect(twoTurns.map((testCase) => testCase.name)).toEqual(['design_a_room']);
  });

  it('gives the room scenario a plan, a confirmation and a session of its own', () => {
    const room = CHAT_CASES.find((testCase) => testCase.name === 'design_a_room');

    expect(room).toBeDefined();
    expect(room?.follow_up?.trim().length).toBeGreaterThan(0);
    expect(room?.session).toBe('own');
    expect(room?.expect.tools).toContain('designRoom');
    expect(room?.expect.design?.drawn).toBe(true);
    expect(room?.expect.design?.not_drawn_before).toBe(true);
  });

  it('marks the prompt of every scenario that names a piece', () => {
    for (const testCase of CHAT_CASES) {
      if (!testCase.catalogue_pick) continue;
      expect(testCase.prompt).toContain('{catalogue_pick}');
    }
  });
});

describe('buildChatCases', () => {
  /**
   * A catalogue with the three pieces the scenarios care about: one that is
   * the dearest, one that is out of stock, and one that is in the catalogue
   * under the name the missing scenario would otherwise ask for.
   */
  const CATALOGUE: CatalogueProduct[] = [
    product({
      id: 'p-katja',
      name_th: 'โซฟาคัทจ้า 3 ที่นั่ง',
      name_en: 'KATJA 3-seat sofa',
      price_thb: 12_900,
    }),
    product({
      id: 'p-gate',
      name_th: 'โซฟากระดาน 3 ที่นั่ง',
      name_en: 'GATE 3-seat sofa',
      price_thb: 24_000,
    }),
    product({
      id: 'p-out',
      name_th: 'โซฟาไม่มีของ',
      name_en: 'OUT OF STOCK sofa',
      price_thb: 99_000,
      in_stock: false,
    }),
  ];

  it('asks about a piece the catalogue really has', () => {
    const cases = buildChatCases(CATALOGUE);
    const price = cases.find((testCase) => testCase.name === 'price_quote_from_db');

    // The dearest piece of the category that is in stock — not the out of
    // stock one, and not a name written into the scenario.
    expect(price?.prompt).toBe('ราคา โซฟากระดาน 3 ที่นั่ง เท่าไหร่');
    expect(price?.expect.expect_price_thb).toBe(24_000);
  });

  it('asks about a piece the catalogue does not have', () => {
    const cases = buildChatCases(CATALOGUE);
    const missing = cases.find((testCase) => testCase.name === 'price_of_missing_product');

    // "โซฟาคัทจ้า 3 ที่นั่ง" is in this catalogue, so the next name is used.
    expect(missing?.prompt).toBe('ราคา โซฟาลินเนส 3 ที่นั่ง เท่าไหร่');
  });

  it('leaves no marker behind in a prompt', () => {
    for (const testCase of buildChatCases(CATALOGUE)) {
      expect(testCase.prompt).not.toContain('{catalogue_pick}');
    }
  });

  it('keeps the scenarios that name nothing as they are', () => {
    const cases = buildChatCases(CATALOGUE);
    const search = cases.find((testCase) => testCase.name === 'search_by_style_and_budget');

    expect(search?.prompt).toBe(CHAT_CASES[0]?.prompt);
  });

  it('stops when the catalogue cannot support a scenario', () => {
    // No sofa in stock at all.
    expect(() => buildChatCases([product({ id: 'p-bed', category: 'bed' })])).toThrow();

    // Nothing in the catalogue, so no piece to ask about.
    expect(() => buildChatCases([])).toThrow();
  });
});
