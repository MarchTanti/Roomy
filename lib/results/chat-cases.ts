/**
 * The chat scenarios, and the checks that say whether each one behaved.
 *
 * These are the end-to-end conversations of step 8: real prompts, sent through
 * the real `/api/chat` route, against the real catalogue. Each one states
 * what it is looking for, and the checks below turn what came back into a
 * list of pass/fail lines that end up in `results.json`.
 *
 * The checks are deliberately about *facts*, not about phrasing. The model's
 * wording is its own; what has to be true is that it used the database's
 * numbers, that it called the tool the task needed, and that what it said
 * about fitting agrees with what the fit rule said. A check that tried to
 * match the exact sentence would fail on wording and say nothing about
 * whether the system is right.
 */

import type { Json, Preferences, Product } from '../db/types';
import { canonicalStyle, parseLength } from '../design/brief';
import type { DesignView } from '../design/view';
import type { ComparisonView, SearchProduct } from '../llm/tools';
import type { ChatTurn, FitToolResult } from './chat-run';
import type { ScenarioCheck } from './types';

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

/**
 * What a designed room has to be.
 *
 * The room feature has one rule above the others — the assistant asks before
 * it draws — and one rule underneath all of them: the numbers of a room come
 * from the database and from the user's own words, never from the model. Both
 * are checkable, and these are the checks.
 */
export interface DesignExpectation {
  /** The room must not have been drawn in the turn before the confirmation. */
  not_drawn_before?: boolean;
  /**
   * The first reply must ask for confirmation.
   *
   * A question mark counts, and so does one of these words — the wording is
   * the model's own, so the check asks for the *meaning* and not a sentence.
   */
  asked_before?: string[];
  /** The room must have been drawn in this turn. */
  drawn?: boolean;
  /** The style the room must carry, in the user's or the model's words. */
  style?: string;
  /** The size of the room, in square metres, from the user's own words. */
  room_size_m2?: number;
  /** The width of the floor, in centimetres, from the user's own words. */
  width_cm?: number;
  /** The depth of the floor, in centimetres, from the user's own words. */
  depth_cm?: number;
  /** The room must hold a piece of each of these categories. */
  categories?: string[];
  /**
   * Every piece must be a row the catalogue holds, at the catalogue's own
   * price and size.
   */
  pieces_from_catalogue?: boolean;
  /** The total must be the sum of the pieces. */
  total_is_sum?: boolean;
  /** The room must not cost more than this. */
  max_total_thb?: number;
  /**
   * The piece of this category must be the catalogue's closest to the width
   * the user asked for — and that width must be the one the code read out of
   * the user's own words.
   */
  requested_width?: {
    category: string;
    /** The width, in the user's own words: "3.5 ฟุต". */
    requested: string;
    /**
     * How much further from the request the chosen row may be than the
     * closest row. The style and colour of a brief are worth 30 and 10 points
     * in the code's scoring, and ten points is one centimetre of width — so
     * four centimetres is the most a tie can cost. Five leaves room.
     */
    tolerance_cm?: number;
  };
}

export interface CaseExpectation {
  /** Tools that must have been called in this turn. */
  tools?: string[];
  /** At least this many products in the search result. */
  min_products?: number;
  /** The comparison must exist and hold at least this many products. */
  min_compared?: number;
  /** At least this many `checkFit` results in the turn. */
  min_fit_results?: number;
  /**
   * Groups of alternatives the reply must contain.
   *
   * Every group has to match at least one of its alternatives — so
   * `[['อัปโหลด', 'ส่งรูป']]` is satisfied by either word, while two groups
   * are two separate requirements.
   */
  reply_has?: string[][];
  /** Words the reply must not contain. */
  reply_excludes?: string[];
  /** What the database should have kept as the session's preferences. */
  preferences?: {
    category?: string;
    budget_thb?: number;
    /** The remembered style must be one the catalogue actually uses. */
    style_in_catalogue?: boolean;
  };
  /** The price the reply has to quote, straight from the database. */
  expect_price_thb?: number;
  /** The reply must not contradict the fit rule's verdict. */
  agree_with_verdict?: boolean;
  /** The cheapest id in the comparison must be the cheapest product in it. */
  comparison_cheapest_is_min?: boolean;
  /** What the room has to be, when the scenario designs one. */
  design?: DesignExpectation;
}

/**
 * How a scenario names a piece of furniture.
 *
 * The catalogue is re-seeded from the live shops, so a product written into a
 * scenario goes stale — and a scenario that asks for the price of a product
 * the database does not hold asks the bot for something it cannot know. The
 * scenarios that name a piece say *how* it is chosen here, and
 * `buildChatCases` fills them in from the rows that are actually there.
 */
export type CataloguePick =
  /**
   * The dearest piece of the category that is in stock.
   *
   * The price the bot has to quote is that row's own price, and the scenario
   * runs in a session of its own, so the answer cannot come out of an earlier
   * turn of the conversation.
   */
  | { kind: 'in_stock'; category: string }
  /**
   * A real piece the catalogue does not hold.
   *
   * The names are tried in order and the first one the catalogue does not
   * have is used, so a re-seed that brings one of them back does not break
   * the scenario.
   */
  | { kind: 'absent'; names: readonly string[] };

export interface ChatCase {
  /** A slug, used as the key in `results.json`. */
  name: string;
  /** The Thai label the report shows. */
  title: string;
  /** Why this scenario is in the set — one line, for the report. */
  intent: string;
  /** Exactly what gets sent. */
  prompt: string;
  /**
   * The piece of furniture this scenario names.
   *
   * The prompt carries the marker `{catalogue_pick}`, and the run fills it in
   * with a row the catalogue really has before the scenario is sent.
   */
  catalogue_pick?: CataloguePick;
  /**
   * The second message of the scenario, sent in the same session.
   *
   * A scenario that needs two turns has it: the first message asks for
   * something, the second one agrees. The room is like that — the assistant
   * asks before it draws, so the drawing happens in the answer to "yes".
   */
  follow_up?: string;
  /**
   * Which session the scenario runs in.
   *
   * `main` is the shared one, so a scenario can lean on what an earlier one
   * established. `own` is a session of its own, for a scenario that has to be
   * judged on a clean slate and would otherwise leave state behind for the
   * others.
   */
  session?: 'main' | 'own';
  expect: CaseExpectation;
}

/**
 * The eight scenarios, in the order they run.
 *
 * The first five share one session, the way a real conversation does, so the
 * later turns can lean on what the earlier ones established — that is also how
 * the memory check works: turn 5 only makes sense if turn 1 happened.
 *
 * The last three are the exception. The two price scenarios and the room each
 * run in a session of their own, because each of them has to be judged on a
 * clean slate: a price answered out of an earlier answer is not a price the
 * database was asked for, a style remembered from an earlier turn would be a
 * style nobody asked for in that room, and the room a scenario leaves behind
 * would change what the scenarios after it see.
 */
export const CHAT_CASES: readonly ChatCase[] = [
  {
    name: 'search_by_style_and_budget',
    title: 'ค้นหาตามสไตล์และงบประมาณ',
    intent: 'ให้บอทแปลงความต้องการของผู้ใช้เป็นเงื่อนไขของเครื่องมือค้นหา และเก็บไว้ในสถานะเซสชัน',
    prompt: 'ชอบสไตล์สแกนดินาเวีย งบประมาณ 20,000 บาท อยากได้เฟอร์นิเจอร์สำหรับห้องนั่งเล่น',
    expect: {
      tools: ['searchFurniture'],
      min_products: 1,
      preferences: { budget_thb: 20_000, style_in_catalogue: true },
    },
  },
  {
    name: 'fit_check_with_measurement',
    title: 'เช็คขนาดด้วยพื้นที่ที่ผู้ใช้บอก',
    intent: 'ให้บอทส่งขนาดที่ผู้ใช้พิมพ์มาเข้าเครื่องมือ แล้วเล่าผลตามกฎ ไม่ใช่ตามความเดาของโมเดล',
    prompt: 'ห้องนั่งเล่นกว้าง 240 ซม. ลึก 120 ซม. ความสูงพืดาน 260 ซม. ช่วยเช็คว่าโซฟาที่แนะนำมาวางลงไปได้ไหม',
    expect: {
      tools: ['checkFit'],
      min_fit_results: 1,
      agree_with_verdict: true,
    },
  },
  {
    name: 'compare_two_products',
    title: 'เทียบสินค้าสองตัว',
    intent: 'ให้บอทเทียบจากแถวในฐานข้อมูลเท่านั้น และชี้ว่าตัวไหนถูกสุด',
    prompt: 'เทียบสินค้าที่แนะนำมาสองตัวให้หน่อยว่าตัวไหนคุ้มกว่า',
    expect: {
      tools: ['compareOptions'],
      min_compared: 2,
      comparison_cheapest_is_min: true,
    },
  },
  {
    name: 'room_style_without_photo',
    title: 'ถามสไตล์ห้องตอนยังไม่มีรูป',
    intent: 'ให้บอทขอรูปห้องแทนที่จะแต่งสไตล์ของห้องที่ยังไม่เคยเห็น',
    prompt: 'ช่วยดูสไตล์ห้องนั่งเล่นของฉันให้หน่อยว่าเป็นสไตล์อะไร',
    expect: {
      reply_has: [['อัปโหลด', 'ส่งรูป', 'รูปห้อง', 'รูปภาพ', 'ถ่ายรูป', 'เพิ่มรูป']],
    },
  },
  {
    name: 'budget_follow_up',
    title: 'งบประมาณเปลี่ยนไปในบทสนทนาเดิม',
    intent: 'ให้บอทจำสไตล์ที่เคยบอกไว้ไว้ในฐานข้อมูล แล้วอัปเดตงบใหม่โดยไม่ลืมของเดิม',
    prompt: 'งบเพิ่มเป็น 25,000 บาทได้ไหม',
    expect: {
      preferences: { budget_thb: 25_000, style_in_catalogue: true },
    },
  },
  {
    name: 'price_quote_from_db',
    title: 'ราคามาจากฐานข้อมูลเท่านั้น',
    intent:
      'ให้บอทตอบราคาของสินค้าที่ระบุชื่อ โดยตัวเลขต้องตรงกับแถวในฐานข้อมูล ' +
      '(สินค้าที่ถามถูกเลือกจากแคตตาล็อกจริงตอนรัน เพราะแคตตาล็อกถูก seed ใหม่แล้ว)',
    prompt: 'ราคา {catalogue_pick} เท่าไหร่',
    catalogue_pick: { kind: 'in_stock', category: 'sofa' },
    session: 'own',
    expect: {},
  },
  {
    name: 'price_of_missing_product',
    title: 'สินค้าที่ไม่มีในแคตตาล็อก',
    intent:
      'ให้บอทบอกตรง ๆ ว่าไม่มีชิ้นนั้นในฐานข้อมูล แทนที่จะกุราคาขึ้นมาเอง ' +
      '(ชื่อที่ถามถูกเลือกจากรายการที่แคตตาล็อกไม่มีจริงตอนรัน)',
    prompt: 'ราคา {catalogue_pick} เท่าไหร่',
    catalogue_pick: {
      kind: 'absent',
      names: [
        'โซฟาคัทจ้า 3 ที่นั่ง',
        'โซฟาลินเนส 3 ที่นั่ง',
        'โซฟามาริ 3 ที่นั่ง',
        'โซฟาเฮมเนส 3 ที่นั่ง',
        'โซฟาวิตาน 3 ที่นั่ง',
      ],
    },
    session: 'own',
    expect: {
      tools: ['searchFurniture'],
      reply_has: [
        [
          'ไม่มีข้อมูล',
          'ไม่มีในแคตตาล็อก',
          'ไม่มีในฐานข้อมูล',
          'ไม่มีในระบบ',
          'ไม่มีแคตตาล็อก',
          'ไม่มีสินค้า',
          'ไม่มีชิ้น',
          'ไม่มีตัว',
          'ไม่พบ',
          'ยังไม่มี',
          'ไม่อยู่ใน',
        ],
      ],
    },
  },
  {
    name: 'design_a_room',
    title: 'แต่งห้องทั้งห้องตามคำขอ',
    intent:
      'ให้บอทถามยืนยันก่อนวาด แล้ววาดห้องที่มีเฟอร์นิเจอร์จริงจากแคตตาล็อก ' +
      'โดยขนาดห้องและขนาดชิ้นสินค้าต้องมาจากคำพูดของผู้ใช้เอง',
    prompt:
      'ฉันอยากได้ห้องนอนสไตล์มินิมอล ขนาด 24 ตารางเมตร ธีมสีชมพู-ขาวพาสเทล ' +
      'ในนั้นต้องมีเตียง 3.5 ฟุต และโคมไฟที่เหมาะกับการเลี้ยงสัตว์',
    follow_up: 'งบประมาณ 30,000 บาทครับ เอาแบบนี้เลย วาดให้ดูหน่อย',
    session: 'own',
    expect: {
      tools: ['designRoom'],
      design: {
        not_drawn_before: true,
        asked_before: [
          'ยืนยัน',
          'วาดเลย',
          'วาดให้',
          'ให้วาด',
          'ให้เลย',
          'เริ่มวาด',
          'วาดต่อ',
          'โอเค',
          'ได้เลย',
          'ทำเลย',
          'ตกลง',
          'ไหม',
        ],
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
  },
];

// ---------------------------------------------------------------------------
// Filling the catalogue into the scenarios
// ---------------------------------------------------------------------------

/** Where in a prompt the name of the piece goes. */
const CATALOGUE_MARKER = '{catalogue_pick}';

/**
 * The scenarios, ready to run against this catalogue.
 *
 * The scenarios that name a piece of furniture get their prompt — and the
 * price they expect — from the rows the database actually has. A scenario
 * that asks for a piece the catalogue does not hold asks the bot for a price
 * it cannot know, and the bot would be right to refuse; the run would then
 * report a failure that says nothing about the system.
 *
 * @throws when the catalogue cannot support one of the scenarios — there is
 *   no in-stock piece of the category, or no name the catalogue is without.
 */
export function buildChatCases(catalogue: readonly CatalogueProduct[]): ChatCase[] {
  return CHAT_CASES.map((testCase) => {
    const pick = testCase.catalogue_pick;
    if (!pick) return testCase;

    if (pick.kind === 'in_stock') {
      const row = pickInStock(catalogue, pick.category);
      return {
        ...testCase,
        prompt: withName(testCase, row.name_th),
        // The price the bot has to quote is the row's own price — the check
        // reads it from here, so the scenario and the database cannot drift
        // apart.
        expect: { ...testCase.expect, expect_price_thb: row.price_thb },
      };
    }

    return { ...testCase, prompt: withName(testCase, pickAbsent(catalogue, pick.names)) };
  });
}

/**
 * The dearest piece of the category that is in stock.
 *
 * The catalogue decides which one it is, so the scenario does not go stale
 * when the catalogue is re-seeded.
 */
function pickInStock(
  catalogue: readonly CatalogueProduct[],
  category: string,
): CatalogueProduct {
  const dearest = catalogue
    .filter((row) => row.category === category && row.in_stock)
    .reduce<CatalogueProduct | null>(
      (best, row) => (best === null || row.price_thb > best.price_thb ? row : best),
      null,
    );

  if (!dearest) {
    throw new Error(`ไม่มีสินค้าหมวด "${category}" ที่มีของในสต็อกในแคตตาล็อก`);
  }
  return dearest;
}

/** The first of the names the catalogue does not hold. */
function pickAbsent(catalogue: readonly CatalogueProduct[], names: readonly string[]): string {
  const absent = names.find((name) => !catalogueHolds(catalogue, name));
  if (!absent) {
    throw new Error('ไม่มีชื่อสินค้าที่แคตตาล็อกไม่มี เหลือไว้ให้ถามในสถานการณ์');
  }
  return absent;
}

/**
 * True when the catalogue holds a piece under that name.
 *
 * The name in the scenario is a full one ("โซฟาคัทจ้า 3 ที่นั่ง"), so a row
 * that carries it is that piece — and a row that carries only a part of it,
 * like "โซฟาคัทจ้า", is that piece too. A row that merely starts with the
 * same word ("โซฟา BOFA SOUTH") is not, and a row named just "โซฟา" is too
 * short to be the piece.
 */
function catalogueHolds(catalogue: readonly CatalogueProduct[], name: string): boolean {
  const wanted = name.trim().toLowerCase();
  return catalogue.some((row) => {
    const th = row.name_th.toLowerCase();
    const en = row.name_en.toLowerCase();
    return (
      th.includes(wanted) ||
      en.includes(wanted) ||
      (th.length >= 6 && wanted.includes(th)) ||
      (en.length >= 6 && wanted.includes(en))
    );
  });
}

/** Puts the name of the piece where the marker is. */
function withName(testCase: ChatCase, name: string): string {
  const prompt = testCase.prompt.replace(CATALOGUE_MARKER, () => name);
  if (prompt === testCase.prompt) {
    throw new Error(`สถานการณ์ "${testCase.name}" ไม่มีที่ว่าง "${CATALOGUE_MARKER}" ใน prompt`);
  }
  return prompt;
}

// ---------------------------------------------------------------------------
// The facts of one turn
// ---------------------------------------------------------------------------


/**
 * A catalogue row, as far as the checks need to see it.
 *
 * The whole row and not only the prices: "is this piece a real product?" and
 * "is this price the catalogue's?" are the same question, and a room's pieces
 * have to be real products at the database's own numbers.
 */
export type CatalogueProduct = Pick<
  Product,
  | 'id'
  | 'category'
  | 'name_th'
  | 'name_en'
  | 'price_thb'
  | 'width_cm'
  | 'depth_cm'
  | 'height_cm'
  | 'in_stock'
  | 'style_tags'
>;

/** Every price the catalogue holds. */
export function cataloguePrices(catalogue: readonly CatalogueProduct[]): number[] {
  return [...new Set(catalogue.map((product) => product.price_thb))];
}

/** Every style tag the catalogue uses. */
export function catalogueStyles(catalogue: readonly CatalogueProduct[]): string[] {
  return [...new Set(catalogue.flatMap((product) => product.style_tags))].sort();
}

/** What the turn before this one did, when the scenario has two turns. */
export interface PreviousFacts {
  reply: string;
  toolCalls: { name: string; args: Json }[];
  /** The room the earlier turn drew, if it drew one. */
  design: DesignView | null;
}

export interface TurnFacts {
  reply: string;
  toolCalls: { name: string; args: Json }[];
  products: SearchProduct[] | null;
  comparison: ComparisonView | null;
  preferences: Preferences;
  /** The `checkFit` results of this turn, in order. */
  fitResults: FitToolResult[];
  /**
   * Every clearance the tool has produced so far in this session.
   *
   * A turn is allowed to repeat a number the tool gave it in an earlier turn
   * — that is how a conversation stays coherent — but not a number it worked
   * out itself.
   */
  knownClearances: number[];
  /** The catalogue the checks measure the answers against. */
  catalogue: CatalogueProduct[];
  /** Numbers the user has typed so far — their own figures. */
  statedNumbers: number[];
  /** The room this turn drew, when it drew one. */
  design: DesignView | null;
  /** The turn before this one, when the scenario has two. */
  previous: PreviousFacts | null;
  /**
   * True when the model could not finish and the reply is an apology.
   *
   * The text is not empty, so a check that only looked at the words would
   * pass a turn that never happened.
   */
  truncated: boolean;
}

/**
 * The facts of one turn, read out of the turn and the transcript.
 *
 * The clearances are the ones the session has produced *so far*, this turn
 * included, and the catalogue is the whole of it — a check has to be able to
 * look a row up by id, not only compare prices.
 */
export function buildTurnFacts(
  turn: ChatTurn,
  fitResults: readonly FitToolResult[],
  knownClearances: readonly number[],
  catalogue: readonly CatalogueProduct[],
  statedNumbers: readonly number[],
  previous: PreviousFacts | null = null,
): TurnFacts {
  return {
    reply: turn.reply,
    toolCalls: turn.tool_calls,
    products: turn.products,
    comparison: turn.comparison,
    preferences: turn.preferences,
    fitResults: [...fitResults],
    knownClearances: [...knownClearances],
    catalogue: [...catalogue],
    statedNumbers: [...statedNumbers],
    design: turn.design,
    previous,
    truncated: turn.truncated,
  };
}

// ---------------------------------------------------------------------------
// Reading the numbers out of the reply
// ---------------------------------------------------------------------------

/** How far a quoted price may drift from the catalogue's before it is a lie. */
const PRICE_TOLERANCE = 0.01;

/**
 * The amounts of money the reply quotes.
 *
 * Only numbers that sit next to a unit are taken: "12,900 บาท" and "฿12,900"
 * are prices, "3 ที่นั่ง" and "240 ซม." are not.
 */
export function extractBahtAmounts(text: string): number[] {
  const amounts: number[] = [];

  const take = (raw: string): void => {
    const value = Number(raw.replace(/,/g, ''));
    if (Number.isFinite(value)) amounts.push(value);
  };

  for (const match of text.matchAll(/(\d[\d,]*)\s*(?:บาท|฿|THB)/gi)) take(match[1]);
  for (const match of text.matchAll(/(?:฿|บาท)\s*(\d[\d,]*)/gi)) take(match[1]);

  return amounts;
}

/** Every number in the text, with the thousands separators removed. */
export function extractNumbers(text: string): number[] {
  const numbers: number[] = [];
  for (const match of text.matchAll(/\d[\d,]*/g)) {
    const value = Number(match[0].replace(/,/g, ''));
    if (Number.isFinite(value)) numbers.push(value);
  }
  return numbers;
}

/** True when `value` is the same figure as `target`, give or take rounding. */
function sameAmount(value: number, target: number): boolean {
  if (target === 0) return value === 0;
  return Math.abs(value - target) <= Math.max(1, Math.abs(target) * PRICE_TOLERANCE);
}

/**
 * The amounts a reply is allowed to quote.
 *
 * A product's price, a number the user typed, and the sums and differences
 * of those. "สองชิ้นรวม 17,390 บาท" is arithmetic on the database's numbers,
 * not a price the model made up — and refusing to allow it would make the
 * check complain about the bot doing sums correctly. Everything else is
 * invented.
 */
export function buildAllowedAmounts(prices: readonly number[], stated: readonly number[]): number[] {
  const base = [...new Set([...prices, ...stated])];
  const allowed = new Set(base);

  for (const a of base) {
    for (const b of base) {
      allowed.add(a + b);
      allowed.add(Math.abs(a - b));
    }
  }
  for (const a of base) {
    for (const b of base) {
      for (const c of base) allowed.add(a + b + c);
    }
  }

  return [...allowed];
}

// ---------------------------------------------------------------------------
// The wording of a verdict
// ---------------------------------------------------------------------------

/** Words that say the piece does not go. */
const NEGATIVE_WORDS = ['ไม่พอดี', 'วางไม่ได้', 'เกินพื้นที่', 'ใหญ่เกิน', 'ไม่เข้าพอดี'];

/** Words that say the piece goes. */
const POSITIVE_WORDS = ['วางได้', 'พอดี', 'เหลือช่องว่าง'];

/**
 * The clearances the reply quotes: "เหลือระยะ 30 ซม.", "เหลือพื้นที่ด้านข้าง 40 ซม.".
 *
 * The number has to sit right after the word — "เหลือ" — and right before the
 * unit, so a price or a width is not swept up by accident.
 */
const CLEARANCE_PATTERN = /เหลือ[^0-9]{0,30}(\d+(?:\.\d+)?)\s*ซม/g;

/** The room left on each axis, in centimetres, that the reply quotes. */
export function extractQuotedClearances(text: string): number[] {
  const values: number[] = [];
  for (const match of text.matchAll(CLEARANCE_PATTERN)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

/** The same text with the negative words taken out. */
function withoutNegative(text: string): string {
  return NEGATIVE_WORDS.reduce((rest, word) => rest.split(word).join(' '), text);
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

function check(name: string, ok: boolean, detail: string): ScenarioCheck {
  return { name, ok, detail };
}

/**
 * The checks of one scenario.
 *
 * Every check is independent: a scenario fails when any one of them fails,
 * and the list says which — which is the point of the exercise.
 */
export function evaluateCase(testCase: ChatCase, facts: TurnFacts): ScenarioCheck[] {
  const checks: ScenarioCheck[] = [];
  const called = facts.toolCalls.map((call) => call.name);

  // --- the tools the task needed -----------------------------------------
  for (const tool of testCase.expect.tools ?? []) {
    const ok = called.includes(tool);
    checks.push(
      check(
        `เรียกเครื่องมือ ${tool}`,
        ok,
        ok ? `เรียกไป ${called.filter((name) => name === tool).length} ครั้ง` : `ไม่ได้เรียก (ที่เรียกไป: ${called.join(', ') || 'ไม่มี'})`,
      ),
    );
  }

  // --- the search result -------------------------------------------------
  if (testCase.expect.min_products !== undefined) {
    const count = facts.products?.length ?? 0;
    const ok = count >= (testCase.expect.min_products ?? 0);
    checks.push(
      check(
        'ได้สินค้ามาให้เลือก',
        ok,
        `${count} รายการ (ต้องการอย่างน้อย ${testCase.expect.min_products})`,
      ),
    );
  }

  // --- the comparison ----------------------------------------------------
  if (testCase.expect.min_compared !== undefined) {
    const count = facts.comparison?.products.length ?? 0;
    const ok = count >= (testCase.expect.min_compared ?? 0);
    checks.push(
      check(
        'ได้ตารางเทียบมา',
        ok,
        `${count} รายการ (ต้องการอย่างน้อย ${testCase.expect.min_compared})`,
      ),
    );
  }

  if (testCase.expect.comparison_cheapest_is_min) {
    const comparison = facts.comparison;
    if (!comparison || comparison.products.length === 0) {
      checks.push(check('ตัวที่ถูกสุดตรงกับราคาต่ำสุด', false, 'ไม่มีตารางเทียบให้ตรวจ'));
    } else {
      const cheapest = comparison.products.reduce((a, b) => (a.price_thb <= b.price_thb ? a : b));
      const ok = comparison.cheapest_id === cheapest.id;
      checks.push(
        check(
          'ตัวที่ถูกสุดตรงกับราคาต่ำสุด',
          ok,
          ok
            ? `${cheapest.name_th} (${cheapest.price_thb.toLocaleString('th-TH')} บาท)`
            : `บอกว่า ${comparison.cheapest_id} แต่ราคาต่ำสุดคือ ${cheapest.name_th} (${cheapest.price_thb.toLocaleString('th-TH')} บาท)`,
        ),
      );
    }
  }

  // --- the fit check -----------------------------------------------------
  if (testCase.expect.min_fit_results !== undefined) {
    const count = facts.fitResults.length;
    const ok = count >= (testCase.expect.min_fit_results ?? 0);
    checks.push(
      check(
        'ได้ผลตรวจขนาดจากเครื่องมือ',
        ok,
        `${count} รายการ (ต้องการอย่างน้อย ${testCase.expect.min_fit_results})`,
      ),
    );
  }

  if (testCase.expect.agree_with_verdict) {
    checks.push(verdictAgrees(facts));
  }

  // --- what the reply says ----------------------------------------------
  for (const [index, alternatives] of (testCase.expect.reply_has ?? []).entries()) {
    const hit = alternatives.find((word) => facts.reply.includes(word));
    checks.push(
      check(
        `คำตอบมีคำว่า "${alternatives.join('" หรือ "')}"`,
        hit !== undefined,
        hit !== undefined ? `เจอคำว่า "${hit}"` : 'ไม่เจอคำใดในกลุ่มนี้',
      ),
    );
  }

  for (const word of testCase.expect.reply_excludes ?? []) {
    const hit = facts.reply.includes(word);
    checks.push(check(`คำตอบไม่ควรมีคำว่า "${word}"`, !hit, hit ? 'เจอคำนี้ในคำตอบ' : 'ไม่เจอ'));
  }

  // --- what the database kept -------------------------------------------
  const preferences = testCase.expect.preferences;
  if (preferences?.category !== undefined) {
    const ok = facts.preferences.category === preferences.category;
    checks.push(
      check(
        `ฐานข้อมูลจำหมวดหมู่ไว้เป็น "${preferences.category}"`,
        ok,
        `ได้ ${facts.preferences.category ?? 'ไม่มี'}`,
      ),
    );
  }

  if (preferences?.budget_thb !== undefined) {
    const ok = facts.preferences.budget_thb === preferences.budget_thb;
    checks.push(
      check(
        `ฐานข้อมูลจำงบไว้เป็น ${preferences.budget_thb.toLocaleString('th-TH')} บาท`,
        ok,
        `ได้ ${facts.preferences.budget_thb?.toLocaleString('th-TH') ?? 'ไม่มี'}`,
      ),
    );
  }

  if (preferences?.style_in_catalogue) {
    const style = facts.preferences.style;
    const ok = style !== null && catalogueStyles(facts.catalogue).includes(style);
    checks.push(
      check(
        'สไตล์ที่จำไว้เป็นสไตล์ที่แคตตาล็อกมีจริง',
        ok,
        ok ? `"${style}"` : `ได้ ${style ?? 'ไม่มี'} (แคตตาล็อกมี: ${catalogueStyles(facts.catalogue).join(', ')})`,
      ),
    );
  }

  // --- the price ---------------------------------------------------------
  if (testCase.expect.expect_price_thb !== undefined) {
    const expected = testCase.expect.expect_price_thb;
    const numbers = extractNumbers(facts.reply);
    const hit = numbers.find((value) => sameAmount(value, expected));
    checks.push(
      check(
        `ราคาที่ตอบตรงกับฐานข้อมูล (${expected.toLocaleString('th-TH')} บาท)`,
        hit !== undefined,
        hit !== undefined ? `พบ ${hit.toLocaleString('th-TH')} บาท` : 'ไม่พบราคานี้ในคำตอบ',
      ),
    );
  }

  // --- the room ----------------------------------------------------------
  if (testCase.expect.design) {
    checks.push(...designChecks(testCase.expect.design, facts));
  }

  return checks;
}

// ---------------------------------------------------------------------------
// The checks of a room
// ---------------------------------------------------------------------------

/**
 * Two style words that mean the same style.
 *
 * The model quotes the user ("มินิมอล") and the catalogue tags in English
 * ("minimalist"), so the comparison goes through the same aliases the code
 * uses when it matches a row to a brief. The words are compared one by one,
 * so "มินิมอล พาสเทล" still answers "มินิมอล".
 */
function sameStyle(left: string, right: string): boolean {
  const words = (text: string) =>
    text
      // The marks count as letters here: a Thai vowel sign is part of the
      // word it sits on, and splitting "มินิมอล" would break it in three.
      .split(/[^\p{L}\p{M}\p{N}]+/u)
      .map((word) => canonicalStyle(word))
      .filter((word) => word !== '');

  const a = words(left);
  const b = words(right);
  if (a.length === 0 || b.length === 0) return false;

  return a.some((word) => b.some((other) => word === other || word.includes(other) || other.includes(word)));
}

/**
 * The checks of a designed room.
 *
 * Two rules are measured here. The first is the one the user asked for: the
 * assistant asks before it draws. The second is the one everything else rests
 * on — the numbers of a room are the database's and the user's own words,
 * never the model's.
 */
function designChecks(expect: DesignExpectation, facts: TurnFacts): ScenarioCheck[] {
  const checks: ScenarioCheck[] = [];
  const design = facts.design;

  // --- it did not draw before the user said so ---------------------------
  if (expect.not_drawn_before) {
    const previous = facts.previous;
    if (!previous) {
      checks.push(
        check(
          'รอบแรกยังไม่วาดห้อง',
          false,
          'ไม่มีรอบก่อนหน้าให้ตรวจว่าวาดก่อนยืนยันหรือไม่',
        ),
      );
    } else {
      const drew = previous.design !== null;
      checks.push(
        check(
          'รอบแรกยังไม่วาดห้อง',
          !drew,
          drew
            ? 'มีภาพห้องแล้วในรอบที่ผู้ใช้ยังไม่ได้ยืนยัน'
            : 'รอบแรกมีแต่คำตอบ ยังไม่มีภาพห้อง',
        ),
      );
    }
  }

  // --- it asked before it drew -------------------------------------------
  if (expect.asked_before) {
    const reply = facts.previous?.reply ?? '';
    const hit = expect.asked_before.find((word) => reply.includes(word));
    const asked = hit !== undefined || reply.includes('?');
    checks.push(
      check(
        'บอทถามยืนยันก่อนวาดห้อง',
        asked,
        asked
          ? hit !== undefined
            ? `ถามด้วยคำว่า "${hit}"`
            : 'ถามเป็นคำถาม'
          : 'คำตอบรอบแรกไม่ได้ถามให้ยืนยัน',
      ),
    );
  }

  // --- the room was drawn -------------------------------------------------
  if (expect.drawn) {
    const ok = design !== null && design.image_id !== '';
    checks.push(
      check(
        'ได้ภาพห้องที่วาดแล้ว',
        ok,
        design === null
          ? 'รอบนี้ไม่มีภาพห้อง'
          : ok
            ? `ได้ภาพห้องเวอร์ชันที่ ${design.version} (${design.pieces.length} ชิ้น)`
            : 'มีข้อมูลห้องแต่ไม่มีภาพ',
      ),
    );
  }

  // --- the style ----------------------------------------------------------
  if (expect.style !== undefined) {
    const ok = design !== null && sameStyle(design.style, expect.style);
    checks.push(
      check(
        'สไตล์ห้องตรงกับที่ผู้ใช้บอก',
        ok,
        design === null
          ? 'ไม่มีห้องให้ตรวจ'
          : ok
            ? `"${design.style}"`
            : `ได้ "${design.style}" แต่ที่ขอไว้คือ "${expect.style}"`,
      ),
    );
  }

  // --- the size of the room ----------------------------------------------
  if (
    expect.room_size_m2 !== undefined ||
    expect.width_cm !== undefined ||
    expect.depth_cm !== undefined
  ) {
    const ok =
      design !== null &&
      (expect.room_size_m2 === undefined || design.room_size_m2 === expect.room_size_m2) &&
      (expect.width_cm === undefined || design.width_cm === expect.width_cm) &&
      (expect.depth_cm === undefined || design.depth_cm === expect.depth_cm);
    checks.push(
      check(
        'ขนาดห้องมาจากคำขอของผู้ใช้',
        ok,
        design === null
          ? 'ไม่มีห้องให้ตรวจ'
          : `ได้ ${design.room_size_m2 ?? '?'} ตร.ม. (${design.width_cm ?? '?'}×${design.depth_cm ?? '?'} ซม.) ` +
            `· ควรได้ ${expect.room_size_m2 ?? '-'} ตร.ม. (${expect.width_cm ?? '-'}×${expect.depth_cm ?? '-'} ซม.)`,
      ),
    );
  }

  // --- the pieces the user asked for --------------------------------------
  if (expect.categories) {
    const have = design?.pieces.map((piece) => piece.category) ?? [];
    const missing = expect.categories.filter((category) => !have.includes(category));
    checks.push(
      check(
        'ห้องมีชิ้นที่ผู้ใช้ขอครบ',
        missing.length === 0,
        missing.length === 0
          ? `มีครบ: ${have.join(', ')}`
          : `ไม่มี ${missing.join(', ')} (ที่มี: ${have.join(', ') || 'ไม่มี'})`,
      ),
    );
  }

  // --- the pieces are real rows, at the database's own numbers -------------
  if (expect.pieces_from_catalogue) {
    const rows = new Map(facts.catalogue.map((product) => [product.id, product]));
    const wrong: string[] = [];

    for (const piece of design?.pieces ?? []) {
      const row = rows.get(piece.product_id);
      if (!row) {
        wrong.push(`${piece.name_th} (ไม่มีในแคตตาล็อก)`);
        continue;
      }
      if (row.price_thb !== piece.price_thb) {
        wrong.push(`${piece.name_th} (บอกราคา ${piece.price_thb} แต่ในแคตตาล็อก ${row.price_thb})`);
        continue;
      }
      if (
        row.width_cm !== piece.width_cm ||
        row.depth_cm !== piece.depth_cm ||
        row.height_cm !== piece.height_cm
      ) {
        wrong.push(`${piece.name_th} (ขนาดไม่ตรงกับแถวในแคตตาล็อก)`);
      }
    }

    const count = design?.pieces.length ?? 0;
    checks.push(
      check(
        'เฟอร์นิเจอร์ในห้องเป็นสินค้าจริงจากแคตตาล็อก',
        design !== null && count > 0 && wrong.length === 0,
        design === null
          ? 'ไม่มีห้องให้ตรวจ'
          : count === 0
            ? 'ห้องไม่มีชิ้นสินค้าเลย'
            : wrong.length === 0
              ? `ทั้ง ${count} ชิ้นตรงกับแถวในแคตตาล็อก`
              : wrong.join('; '),
      ),
    );
  }

  // --- the total ----------------------------------------------------------
  if (expect.total_is_sum) {
    const sum = (design?.pieces ?? []).reduce((total, piece) => total + piece.price_thb, 0);
    const ok = design !== null && design.total_price_thb === sum;
    checks.push(
      check(
        'ราคารวมเท่ากับผลรวมของชิ้นสินค้า',
        ok,
        design === null
          ? 'ไม่มีห้องให้ตรวจ'
          : `บอก ${design.total_price_thb.toLocaleString('th-TH')} บาท · ผลรวม ${sum.toLocaleString('th-TH')} บาท`,
      ),
    );
  }

  if (expect.max_total_thb !== undefined) {
    const ok = design !== null && design.total_price_thb <= expect.max_total_thb;
    checks.push(
      check(
        'ราคารวมไม่เกินงบที่ผู้ใช้ให้',
        ok,
        design === null
          ? 'ไม่มีห้องให้ตรวจ'
          : `${design.total_price_thb.toLocaleString('th-TH')} บาท (งบ ${expect.max_total_thb.toLocaleString('th-TH')} บาท)`,
      ),
    );
  }

  // --- the width the user asked for ----------------------------------------
  if (expect.requested_width) {
    const { category, requested } = expect.requested_width;
    const tolerance = expect.requested_width.tolerance_cm ?? 5;
    // The code reads the length out of the user's own words. If the model had
    // converted "3.5 ฟุต" itself, the number here would not match.
    const wanted = parseLength(requested);
    const piece = design?.pieces.find((candidate) => candidate.category === category);

    const wordsOk =
      wanted !== null &&
      piece !== undefined &&
      piece.requested_width_cm !== null &&
      Math.abs(piece.requested_width_cm - wanted) < 0.05;
    checks.push(
      check(
        'ขนาดที่ขอมาจากคำพูดของผู้ใช้เอง',
        wordsOk,
        piece === undefined
          ? `ไม่มีชิ้นหมวด ${category} ในห้องให้ตรวจ`
          : wordsOk
            ? `"${requested}" อ่านได้ ${wanted} ซม.`
            : `โมเดลส่งมา ${piece.requested_width_cm ?? 'ไม่มี'} ซม. แต่ "${requested}" คือ ${wanted ?? '?'} ซม.`,
      ),
    );

    // The row the code picked has to be the catalogue's closest one.
    const rows = facts.catalogue.filter(
      (product) => product.category === category && product.in_stock,
    );
    const bestGap = rows.reduce(
      (best, product) => Math.min(best, Math.abs(product.width_cm - (wanted ?? 0))),
      Number.POSITIVE_INFINITY,
    );
    const gap = piece?.width_gap_cm ?? null;
    const closestOk = gap !== null && bestGap !== Number.POSITIVE_INFINITY && gap <= bestGap + tolerance;
    checks.push(
      check(
        'เลือกชิ้นที่ใกล้ขนาดที่ผู้ใช้ขอที่สุด',
        closestOk,
        piece === undefined
          ? `ไม่มีชิ้นหมวด ${category} ในห้องให้ตรวจ`
          : gap === null
            ? 'ห้องไม่ได้บันทึกขนาดที่ขอไว้'
            : `ขอ ${wanted ?? '?'} ซม. · ของที่แคตตาล็อกมีใกล้สุด ${bestGap} ซม. · ชิ้นที่ได้ต่าง ${gap} ซม.`,
      ),
    );
  }

  return checks;
}

/**
 * The reply must not contradict the rule.
 *
 * Two contradictions matter, and only two: saying a piece does not fit when
 * the rule says it does, and staying quiet about a piece that does not fit.
 * Anything else — a piece that is merely snug, a mention that it has to be
 * turned — is a wording difference, not a wrong fact.
 */
function verdictAgrees(facts: TurnFacts): ScenarioCheck {
  const verdicts = facts.fitResults.map((result) => result.verdict);
  const name = 'คำตอบไม่ขัดกับผลตรวจของกฎ';

  if (verdicts.length === 0) {
    return check(name, true, 'รอบนี้ไม่มีผลตรวจขนาดให้เทียบ');
  }

  const negative = NEGATIVE_WORDS.some((word) => facts.reply.includes(word));
  const positive = POSITIVE_WORDS.some((word) => withoutNegative(facts.reply).includes(word));
  const allFit = verdicts.every((verdict) => verdict === 'fits');
  const noneFit = verdicts.every((verdict) => verdict === 'does_not_fit');

  if (negative && allFit) {
    return check(name, false, `กฎบอกว่า "วางได้" แต่คำตอบบอกว่าวางไม่ได้ (${verdicts.join(', ')})`);
  }
  if (!negative && noneFit && positive) {
    return check(name, false, `กฎบอกว่า "วางไม่ได้" แต่คำตอบบอกว่าวางได้ (${verdicts.join(', ')})`);
  }
  return check(name, true, `ผลตรวจ: ${verdicts.join(', ')}`);
}

/**
 * The checks that apply to every turn, whatever the scenario.
 *
 * The price one is the spec's rule made measurable: every amount of money the
 * model says has to be a price the database holds, a number the user typed,
 * or arithmetic on those. Anything else was made up.
 *
 * `label` marks the turn a set of checks belongs to, for a scenario that
 * needed more than one: "รอบที่ 2: " in front of the name.
 */
export function globalChecks(facts: TurnFacts, label = ''): ScenarioCheck[] {
  const checks: ScenarioCheck[] = [];

  checks.push(
    check(`${label}มีคำตอบกลับ`, facts.reply.trim().length > 0, `${facts.reply.trim().length} ตัวอักษร`),
  );

  // The reply is not empty when the model could not finish — the loop says
  // something so the user is not left staring at a blank bubble. That makes the
  // first check pass a turn that never happened, so the flag has its own.
  checks.push(
    check(
      `${label}โมเดลตอบได้จริง (ไม่ถูกตัดกลางคัน)`,
      !facts.truncated,
      facts.truncated
        ? 'โมเดลไม่ได้ตอบอะไร — คำตอบที่เห็นเป็นคำขอโทษ ไม่ใช่คำตอบ'
        : 'โมเดลตอบเอง',
    ),
  );

  const amounts = extractBahtAmounts(facts.reply);
  const allowed = buildAllowedAmounts(cataloguePrices(facts.catalogue), facts.statedNumbers);
  const invented = amounts.filter((amount) => !allowed.some((value) => sameAmount(amount, value)));

  checks.push(
    check(
      `${label}ตัวเลขเงินทุกตัวในคำตอบต้องมาจากฐานข้อมูลหรือคำนวณจากตัวเลขเหล่านั้น`,
      invented.length === 0,
      invented.length === 0
        ? amounts.length > 0
          ? `ตรวจไป ${amounts.length} จำนวน ไม่มีตัวไหนนอกฐานข้อมูล`
          : 'คำตอบไม่มีตัวเลขราคาให้ตรวจ'
        : `เจอ ${invented.map((amount) => amount.toLocaleString('th-TH')).join(', ')} ที่ไม่มีในฐานข้อมูล`,
    ),
  );

  // The fit numbers are the rule's, not the model's. A clearance the model
  // worked out itself is a number nobody checked — and the spec's promise is
  // that the fit check is a rule.
  const quoted = extractQuotedClearances(facts.reply);
  const known = facts.knownClearances;
  const unsourced = quoted.filter((value) => !known.some((clearance) => Math.abs(clearance - value) < 0.05));

  checks.push(
    check(
      `${label}ตัวเลขช่องว่างที่บอกในคำตอบต้องมาจากผลตรวจของเครื่องมือ`,
      unsourced.length === 0,
      unsourced.length === 0
        ? quoted.length > 0
          ? `ตรวจไป ${quoted.length} ตัวเลข เป็นของที่เครื่องมือบอกทั้งหมด`
          : 'คำตอบไม่ได้บอกตัวเลขช่องว่าง'
        : `บอก ${unsourced.map((value) => `${value} ซม.`).join(', ')} ซึ่งไม่ใช่ตัวเลขที่เครื่องมือเคยให้`,
    ),
  );

  return checks;
}
