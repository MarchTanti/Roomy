/**
 * Calls the real /api/chat route handler in-process — no dev server, no browser.
 * Exercises the exact production path: rate limit → session → history → Gemini
 * tool loop → Supabase writes → state fold.
 *
 *   npx tsx scripts/smoke-chat.ts "ข้อความทดสอบ"
 *
 * Sends one real chat turn to Gemini. Costs a few hundred tokens.
 */

import { loadEnvLocal } from './_load-env';

loadEnvLocal();

// Route handlers read env at call time, so import them after .env.local is set.
const { POST } = await import('../app/api/chat/route');
const { POST: createSession } = await import('../app/api/session/route');
const { getDb } = await import('../lib/db');

async function main(): Promise<void> {
  const text = process.argv[2] ?? 'ชอบสไตล์สแกนดินาเวีย งบไม่เกิน 15000 อยากได้โซฟา';

  // --- create a session through the real handler ---
  const created = await createSession(new Request('http://localhost/api/session', { method: 'POST' }));
  const sessionJson = (await created.json()) as { session_id: string; llm: string };
  console.log(`session created: ${sessionJson.session_id.slice(0, 8)}… (llm=${sessionJson.llm})`);

  // --- send one turn through the real handler ---
  const request = new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
    body: JSON.stringify({ session_id: sessionJson.session_id, message: text }),
  });

  const started = Date.now();
  const response = await POST(request);
  const elapsed = Date.now() - started;

  console.log(`\nHTTP ${response.status} in ${elapsed}ms`);
  const body = await response.json();

  if (response.status !== 200) {
    console.log('\n--- error body ---');
    console.log(JSON.stringify(body, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log('\n--- reply ---');
  console.log(body.reply);
  console.log('\n--- meta ---');
  console.log(`iterations   : ${body.iterations}`);
  console.log(`cap hit     : ${body.hit_iteration_cap}`);
  console.log(`tool_calls  : ${JSON.stringify(body.tool_calls)}`);
  console.log(`preferences : ${JSON.stringify(body.state?.preferences)}`);

  // --- confirm the transcript actually persisted ---
  const rows = await getDb().listMessages(sessionJson.session_id);
  console.log(`\nmessages persisted: ${rows.length}`);
  for (const row of rows) console.log(`  ${row.role.padEnd(9)} ${JSON.stringify(row.content).slice(0, 90)}`);
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  process.exitCode = 1;
});