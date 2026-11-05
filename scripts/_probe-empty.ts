/**
 * Probe: does a turn come back with an answer?
 *
 * The empty-answer failure is invisible in the app — the bubble is simply
 * blank — and invisible in the token counts too, unless you know to look at
 * `candidatesTokenCount` against `thoughtsTokenCount`. This sends one real
 * conversation through the real route and prints what came back: the reply,
 * the tools, the token counts, and whether the model actually finished.
 *
 *   npx tsx scripts/_probe-empty.ts
 *
 * It talks to the real Gemini and creates a real session, which it deletes
 * again at the end. It costs a few thousand tokens. It is the script to run
 * when a turn comes back blank — the answer is in the `think` / `out`
 * columns: a large `think` and a zero `out` means the model spent its whole
 * output budget thinking and had nothing left to write with.
 */

import { loadEnvLocal } from './_load-env';

async function main(): Promise<void> {
  loadEnvLocal();

  const { POST: chatRoute } = await import('../app/api/chat/route');
  const { getDb } = await import('../lib/db');
  const { runChatTurn } = await import('../lib/results/chat-run');
  const { CHAT_CASES } = await import('../lib/results/chat-cases');

  const db = getDb();
  const session = await db.createSession();
  console.log(`[probe] session ${session.id}`);

  // The two turns that used to fail: the second one is the one that needed
  // the model to think for a while before answering.
  const first = CHAT_CASES[0];
  const second = CHAT_CASES[1];
  if (!first || !second) throw new Error('the chat cases are missing');

  const send = (message: string) =>
    chatRoute(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.id, message }),
      }),
    );

  try {
    for (const [index, testCase] of [first, second].entries()) {
      const turn = await runChatTurn(send, testCase.prompt);
      const usage = turn.usage;

      console.log(`\n[probe] turn ${index + 1}: ${testCase.name}`);
      console.log(`[probe]   reply   : ${JSON.stringify(turn.reply).slice(0, 160)}`);
      console.log(`[probe]   tools   : ${turn.tool_calls.map((c) => c.name).join(', ') || '(none)'}`);
      console.log(`[probe]   tokens  : in=${usage?.in ?? 0} out=${usage?.out ?? 0} think=${usage?.think ?? 0}`);
      console.log(`[probe]   finished: ${turn.truncated ? 'NO — the model was cut off' : 'yes'}`);
      console.log(`[probe]   time    : ${turn.latency_ms} ms`);

      if (turn.truncated) {
        console.log('[probe] → the model ran out of output budget before it could answer');
      }
    }
  } finally {
    await db.deleteSession(session.id);
    console.log(`\n[probe] deleted session ${session.id}`);
  }
}

main().catch((err) => {
  console.error('[probe] crashed:', err);
  process.exitCode = 1;
});
