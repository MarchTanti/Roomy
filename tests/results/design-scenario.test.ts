/**
 * The room scenario, the way the harness runs it.
 *
 * The checks in `chat-cases.test.ts` are pinned one by one. This one runs the
 * whole thing: the case as it is written in `CHAT_CASES`, two turns of
 * frames, the reader, the facts, and the checks — and asks whether a system
 * that behaves the way the user asked for passes.
 *
 * The frames are written by hand rather than produced by a model, so the test
 * is about the harness: does it measure what it says it measures?
 */

import { describe, expect, it } from 'vitest';

import type { DesignView } from '@/lib/design/view';
import { CHAT_CASES, buildTurnFacts, evaluateCase, globalChecks, type CatalogueProduct } from '@/lib/results/chat-cases';
import { readTurn, type ChatFrame } from '@/lib/results/chat-run';

const ROOM_CASE = CHAT_CASES.find((testCase) => testCase.name === 'design_a_room');

const CATALOGUE: CatalogueProduct[] = [
  {
    id: 'ikea-bed-slatt-3',
    category: 'bed',
    name_th: 'เตียงสแลท ขนาด 3 ฟุต',
    name_en: 'SLATT bed frame 3 ft',
    price_thb: 10_900,
    width_cm: 105,
    depth_cm: 200,
    height_cm: 40,
    in_stock: true,
    style_tags: ['modern', 'industrial'],
  },
  {
    id: 'ikea-lamp-nordic-floor',
    category: 'lamp',
    name_th: 'โคมตั้งพื้นนอร์ดิก',
    name_en: 'NORDIC floor lamp',
    price_thb: 3_490,
    width_cm: 40,
    depth_cm: 40,
    height_cm: 150,
    in_stock: true,
    style_tags: ['scandinavian', 'minimalist'],
  },
];

const DESIGN: DesignView = {
  image_id: 'img-room-1',
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
      product_id: 'ikea-bed-slatt-3',
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
      product_id: 'ikea-lamp-nordic-floor',
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
};

/** The first turn: the assistant summarises the plan and asks. */
const PLAN_REPLY =
  'ได้ครับ ผมวางห้องนอนสไตล์มินิมอล โทนสีชมพู-ขาวพาสเทล ขนาด 24 ตร.ม. (600×400 ซม.) ' +
  'ใส่เตียงสแลท ขนาด 3 ฟุต ในแคตตาล็อกกว้าง 105 ซม. (ที่ขอไว้ 106.68 ซม.) และโคมตั้งพื้นนอร์ดิก ' +
  'รวม 14,390 บาท ถ้าตรงตามนี้ผมวาดให้เลยไหมครับ';

/** The second turn: the room has been drawn. */
const DRAWN_REPLY =
  'วาดให้แล้วครับ ห้องนอนสไตล์มินิมอล โทนสีชมพู-ขาวพาสเทล ขนาด 24 ตร.ม. (600×400 ซม.) ' +
  'มีเตียงสแลท ขนาด 3 ฟุต ในแคตตาล็อกกว้าง 105 ซม. (ที่ขอไว้ 106.68 ซม.) และโคมตั้งพื้นนอร์ดิก ' +
  'รวม 14,390 บาท';

function doneFrame(reply: string, extra: Record<string, unknown>): ChatFrame {
  return {
    type: 'done',
    reply,
    tool_calls: [],
    iterations: 2,
    hit_iteration_cap: false,
    state: { preferences: { style: null, budget_thb: 30_000, category: null } },
    products: null,
    comparison: null,
    design: null,
    usage: { in: 100, out: 50, think: 0 },
    ...extra,
  };
}

/** The two turns, read the way the runner reads them. */
function readTurns(design: DesignView | null) {
  const first = readTurn([doneFrame(PLAN_REPLY, {})], 100, 900);
  const second = readTurn(
    [
      doneFrame(DRAWN_REPLY, {
        design,
        tool_calls: [{ name: 'designRoom', args: { confirmed: true } }],
      }),
    ],
    100,
    900,
  );

  const stated = [24, 3.5, 30_000];
  const firstFacts = buildTurnFacts(first, [], [], CATALOGUE, stated);
  const secondFacts = buildTurnFacts(
    second,
    [],
    [],
    CATALOGUE,
    stated,
    { reply: first.reply, toolCalls: first.tool_calls, design: first.design },
  );

  return { first, second, firstFacts, secondFacts };
}

describe('the room scenario', () => {
  it('is in the set, with a plan and a confirmation', () => {
    expect(ROOM_CASE).toBeDefined();
    expect(ROOM_CASE?.follow_up).toBeTruthy();
    expect(ROOM_CASE?.session).toBe('own');
  });

  it('passes a room the assistant asked about and then drew', () => {
    const { firstFacts, secondFacts } = readTurns(DESIGN);
    const checks = [
      ...globalChecks(firstFacts),
      ...globalChecks(secondFacts, 'รอบที่ 2: '),
      ...evaluateCase(ROOM_CASE!, secondFacts),
    ];

    for (const check of checks) {
      expect(check.ok, `${check.name}: ${check.detail}`).toBe(true);
    }
  });

  it('fails when the room was never drawn', () => {
    const { secondFacts } = readTurns(null);
    const checks = evaluateCase(ROOM_CASE!, secondFacts);

    const drawn = checks.find((check) => check.name === 'ได้ภาพห้องที่วาดแล้ว');
    expect(drawn?.ok).toBe(false);
  });

  it('fails when the room was drawn before the user said yes', () => {
    const { first, second } = readTurns(DESIGN);
    // The first turn drew a room as well — the tool would have refused, but a
    // check that cannot see the difference is not a check.
    const firstWithRoom = readTurn([doneFrame(PLAN_REPLY, { design: DESIGN })], 100, 900);
    expect(firstWithRoom.design).not.toBeNull();

    const facts = buildTurnFacts(
      second,
      [],
      [],
      CATALOGUE,
      [],
      { reply: first.reply, toolCalls: first.tool_calls, design: firstWithRoom.design },
    );
    const checks = evaluateCase(ROOM_CASE!, facts);

    expect(checks.find((check) => check.name === 'รอบแรกยังไม่วาดห้อง')?.ok).toBe(false);
  });

  it('does not let a made-up price into the room', () => {
    const { firstFacts } = readTurns(DESIGN);
    const checks = globalChecks({
      ...firstFacts,
      reply: 'รวม 7,777 บาทครับ',
    });

    expect(
      checks.find((check) => check.name.includes('ตัวเลขเงินทุกตัว'))?.ok,
    ).toBe(false);
  });
});
