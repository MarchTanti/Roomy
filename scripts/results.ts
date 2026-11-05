/**
 * The step 8 script: `npm run results`
 *
 * Writes `results.json` — the record of what the system actually did:
 *
 *   1. The catalogue sweep: every product in the catalogue put against one
 *      measured space and judged by the fit rule. No model, no API cost.
 *   2. The chat scenarios: eight conversations run through the real
 *      `/api/chat` route, each with the checks that say whether it behaved.
 *      The room scenario takes two turns — the assistant asks before it
 *      draws, so the drawing is the answer to "yes" — and runs in a session
 *      of its own, so it is judged on a clean slate. The two price scenarios
 *      run in sessions of their own too: they name a piece of furniture, and
 *      the piece is picked from the catalogue when the run starts.
 *
 *   npm run results                        # everything
 *   npm run results -- --space=300x200x260  # a different room for the sweep
 *   npm run results -- --skip-chat           # the sweep only, no API calls
 *   npm run results -- --out=results.json    # where to write it
 *   npm run results -- --keep-session        # leave the test sessions in the db
 *
 * The chat half costs real tokens and creates real sessions. The sessions are
 * deleted at the end of the run, so the database is left as it was; the
 * `--keep-session` flag says otherwise.
 *
 * Exit code 0 when every check passed, 1 when one did not, 2 when the run
 * could not finish at all (no API key, no catalogue, and so on).
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { ChatTurn, TokenUsage } from '../lib/results/chat-run';
import type { ChatCase } from '../lib/results/chat-cases';
import type { ChatScenarioResult, ResultsFile } from '../lib/results/types';
import { loadEnvLocal } from './_load-env';

// ---------------------------------------------------------------------------
// The room the sweep is run against
// ---------------------------------------------------------------------------

/**
 * A normal living room: wide enough for a three-seat sofa, deep enough to
 * walk past it, and a ceiling that is not interesting.
 */
const DEFAULT_SPACE = { width_cm: 240, depth_cm: 120, height_cm: 260 as number | null };

interface Options {
  space: { width_cm: number; depth_cm: number; height_cm: number | null };
  spaceSource: string;
  out: string;
  skipChat: boolean;
  keepSession: boolean;
}

function parseSpace(raw: string): { width_cm: number; depth_cm: number; height_cm: number | null } {
  const parts = raw.split(/[x×]/i).map((part) => Number(part.trim()));
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n) || n <= 0)) {
    throw new Error(`--space ต้องเป็น WxDxH เช่น 240x120x260 (ได้ "${raw}")`);
  }
  return {
    width_cm: parts[0],
    depth_cm: parts[1],
    height_cm: parts.length === 3 ? parts[2] : null,
  };
}

function parseOptions(argv: readonly string[]): Options {
  const options: Options = {
    space: DEFAULT_SPACE,
    spaceSource: `ห้องตัวอย่างเริ่มต้นของสคริปต์ (${DEFAULT_SPACE.width_cm}×${DEFAULT_SPACE.depth_cm}×${DEFAULT_SPACE.height_cm} ซม.)`,
    out: 'results.json',
    skipChat: false,
    keepSession: false,
  };

  for (const arg of argv) {
    if (arg.startsWith('--space=')) {
      options.space = parseSpace(arg.slice('--space='.length));
      options.spaceSource = `กำหนดด้วย --space (${arg.slice('--space='.length)})`;
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length);
    } else if (arg === '--skip-chat') {
      options.skipChat = true;
    } else if (arg === '--keep-session') {
      options.keepSession = true;
    } else {
      throw new Error(`ไม่รู้จักตัวเลือก "${arg}"`);
    }
  }

  return options;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * The tokens a scenario spent.
 *
 * A scenario of two turns spent them across two turns, so the numbers are
 * added up — the file is a record of what the run cost.
 */
function sumUsage(turns: readonly ChatTurn[]): { in: number; out: number; think: number } | null {
  const used = turns
    .map((turn) => turn.usage)
    .filter((usage): usage is TokenUsage => usage !== null);
  if (used.length === 0) return null;

  return {
    in: used.reduce((total, usage) => total + usage.in, 0),
    out: used.reduce((total, usage) => total + usage.out, 0),
    think: used.reduce((total, usage) => total + usage.think, 0),
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  loadEnvLocal();

  // Imported after the env is loaded: the routes and the adapters read it
  // when they are first used.
  const { POST: chatRoute } = await import('../app/api/chat/route');
  const { POST: createSessionRoute, DELETE: deleteSessionRoute } = await import('../app/api/session/route');
  const { getDb, activeAdapter } = await import('../lib/db');
  const { activeLlm } = await import('../lib/llm');
  const { settings } = await import('../lib/env');
  const { evaluateCatalogue } = await import('../lib/results/catalogue-fit');
  const {
    buildChatCases,
    buildTurnFacts,
    evaluateCase,
    globalChecks,
    extractNumbers,
  } = await import('../lib/results/chat-cases');
  const { runChatTurn, extractFitResults, extractClearances } = await import('../lib/results/chat-run');

  const db = getDb();

  // --- 1. the catalogue sweep --------------------------------------------
  console.log('[results] กำลังอ่านแคตตาล็อก…');
  const products = await db.searchProducts({});
  if (products.length === 0) {
    console.error('[results] แคตตาล็อกว่างเปล่า — รัน `npm run seed` ก่อน');
    process.exitCode = 2;
    return;
  }

  const sweep = evaluateCatalogue(products, options.space);
  console.log(
    `[results] ตรวจ ${sweep.summary.total} ชิ้นในห้อง ${options.space.width_cm}×${options.space.depth_cm}×${options.space.height_cm ?? '-'} ซม. ` +
      `→ วางได้ ${sweep.summary.fits} · ชิด ${sweep.summary.tight} · ไม่ลง ${sweep.summary.does_not_fit}`,
  );

  // The catalogue travels with the facts of every turn, so a check can look a
  // row up by id and not only compare prices.

  // --- 2. the chat scenarios ---------------------------------------------
  const chatScenarios: ChatScenarioResult[] = [];

  if (options.skipChat) {
    console.log('[results] ข้ามส่วนบทสนทนา (--skip-chat)');
  } else {
    if (activeLlm() === 'none') {
      console.error('[results] ไม่มี GEMINI_API_KEY — ส่วนบทสนทนาจึงข้ามไป (ใช้ --skip-chat เพื่อข้ามให้เงียบ)');
      process.exitCode = 2;
      return;
    }

    // The scenarios that name a piece of furniture are filled in from the rows
    // the database has, so the bot is asked about something that is really
    // there. A catalogue that cannot support one of them is a reason to stop,
    // not a reason to ask the bot a question nothing can answer.
    let cases: ChatCase[];
    try {
      cases = buildChatCases(products);
    } catch (err) {
      console.error(
        `[results] แคตตาล็อกตอบโจทย์สถานการณ์ไม่ได้: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 2;
      return;
    }

    // The sessions the scenarios run in. Most of them share one, the way a
    // real conversation does; a scenario that asks for a session of its own
    // gets one, so that it is judged on a clean slate.
    const sessions = new Map<string, string>();
    const openSessions: string[] = [];

    const sessionFor = async (group: string): Promise<string> => {
      const existing = sessions.get(group);
      if (existing) return existing;

      const created = await createSessionRoute(new Request('http://localhost/api/session', { method: 'POST' }));
      const body = (await created.json()) as { session_id: string };
      sessions.set(group, body.session_id);
      openSessions.push(body.session_id);
      console.log(`[results] เปิดเซสชันทดสอบ ${body.session_id.slice(0, 8)}… (${activeLlm()})`);
      return body.session_id;
    };

    // Every number the user types, across the whole run. These are the
    // user's own figures, so the bot is allowed to repeat them back.
    const statedNumbers = cases.flatMap((testCase) => [
      ...extractNumbers(testCase.prompt),
      ...extractNumbers(testCase.follow_up ?? ''),
    ]);

    // Every clearance the fit tools have produced so far, per session. The bot
    // may repeat these in a later turn; it may not work one out itself.
    const sessionClearances = new Map<string, number[]>();

    for (const [index, testCase] of cases.entries()) {
      const scenario = index + 1;
      const sessionId = await sessionFor(testCase.session === 'own' ? testCase.name : 'main');
      process.stdout.write(`[results]   ${scenario}/${cases.length} ${testCase.name} … `);

      const send = (message: string) =>
        chatRoute(
          new Request('http://localhost/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId, message }),
          }),
        );

      const clearances = sessionClearances.get(sessionId) ?? [];

      // --- the first turn ------------------------------------------------
      const before = (await db.listMessages(sessionId)).length;
      const first = await runChatTurn(send, testCase.prompt);
      const afterFirst = await db.listMessages(sessionId);
      const firstMessages = afterFirst.slice(before);
      clearances.push(...extractClearances(firstMessages));

      const firstFacts = buildTurnFacts(
        first,
        extractFitResults(firstMessages),
        clearances,
        products,
        statedNumbers,
      );

      const turns: ChatTurn[] = [first];
      let last = first;
      let facts = firstFacts;

      // --- the second turn, when the scenario needs one --------------------
      //
      // A room is drawn in the answer to "yes": the assistant asks before it
      // draws, so the drawing is the second turn of the conversation.
      if (testCase.follow_up) {
        const second = await runChatTurn(send, testCase.follow_up);
        const afterSecond = await db.listMessages(sessionId);
        const secondMessages = afterSecond.slice(afterFirst.length);
        clearances.push(...extractClearances(secondMessages));

        turns.push(second);
        last = second;
        facts = buildTurnFacts(
          second,
          extractFitResults(secondMessages),
          clearances,
          products,
          statedNumbers,
          {
            reply: first.reply,
            toolCalls: first.tool_calls,
            design: first.design,
          },
        );
      }

      sessionClearances.set(sessionId, clearances);

      const checks = [
        ...globalChecks(firstFacts),
        ...(testCase.follow_up ? globalChecks(facts, 'รอบที่ 2: ') : []),
        ...evaluateCase(testCase, facts),
      ];

      for (const turn of turns) {
        if (turn.hit_iteration_cap) {
          checks.push({
            name: 'ไม่ชนเพดานจำนวนรอบการเรียกเครื่องมือ',
            ok: false,
            detail: 'โมเดลเรียกเครื่องมือจนครบ 6 รอบ',
          });
        }
        if (!turn.ok) {
          checks.push({ name: 'รอบสนทนาจบปกติ', ok: false, detail: turn.error ?? 'ไม่มีเฟรม done' });
        }
      }

      const ok = checks.every((c) => c.ok);
      const usage = sumUsage(turns);
      const latency = turns.reduce((total, turn) => total + turn.latency_ms, 0);

      chatScenarios.push({
        name: testCase.name,
        title: testCase.title,
        intent: testCase.intent,
        prompt: testCase.prompt,
        follow_up: testCase.follow_up ?? null,
        turn: scenario,
        turns: turns.length,
        ok,
        reply: last.reply,
        previous_reply: testCase.follow_up ? first.reply : null,
        tool_calls: last.tool_calls,
        iterations: last.iterations,
        hit_iteration_cap: last.hit_iteration_cap,
        truncated: last.truncated,
        products: last.products,
        comparison: last.comparison,
        design: last.design,
        preferences: last.preferences,
        chat_turns_left: last.chat_turns_left,
        latency_ms: latency,
        first_token_ms: first.first_token_ms,
        usage,
        checks,
      });

      const failed = checks.filter((c) => !c.ok);
      console.log(
        `${ok ? 'ผ่าน' : 'ไม่ผ่าน'} (${latency} ms, ${turns.map((turn) => turn.iterations).join('+')} รอบ, ` +
          `${usage?.in ?? 0}/${usage?.out ?? 0} โทเคน)` +
          (failed.length > 0 ? ` — ${failed.map((c) => c.name).join('; ')}` : ''),
      );
    }

    if (!options.keepSession) {
      for (const sessionId of openSessions) {
        const deleted = await deleteSessionRoute(
          new Request(`http://localhost/api/session?session_id=${sessionId}`, { method: 'DELETE' }),
        );
        const body = (await deleted.json()) as { deleted?: boolean };
        console.log(
          `[results] ลบเซสชันทดสอบ ${sessionId.slice(0, 8)}… แล้ว: ${body.deleted === true ? 'สำเร็จ' : 'ไม่สำเร็จ'}`,
        );
      }
    } else {
      console.log(`[results] เก็บเซสชันทดสอบไว้: ${openSessions.join(', ')}`);
    }
  }

  // --- 3. the file -------------------------------------------------------
  const checks = chatScenarios.flatMap((scenario) => scenario.checks);
  const file: ResultsFile = {
    generated_at: new Date().toISOString(),
    app: {
      adapter: activeAdapter(),
      llm: activeLlm(),
      llm_model: settings.llmModel(),
      image_model: settings.imageModel(),
    },
    catalogue_fit: { ...sweep, space_source: options.spaceSource },
    chat_scenarios: chatScenarios,
    summary: {
      scenarios: chatScenarios.length,
      scenarios_passed: chatScenarios.filter((scenario) => scenario.ok).length,
      checks: checks.length,
      checks_failed: checks.filter((c) => !c.ok).length,
    },
  };

  const target = path.resolve(process.cwd(), options.out);
  await fs.writeFile(target, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  console.log(`[results] เขียน ${options.out} ไว้ที่ ${target}`);

  console.log(
    `[results] สรุป: บทสนทนา ${file.summary.scenarios_passed}/${file.summary.scenarios} ผ่าน · ` +
      `เช็ก ${file.summary.checks - file.summary.checks_failed}/${file.summary.checks} ผ่าน`,
  );

  if (file.summary.checks_failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('results crashed:', err);
  process.exitCode = 2;
});
