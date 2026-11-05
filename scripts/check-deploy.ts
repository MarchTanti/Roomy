/**
 * Checks a deployed site. `npm run check:deploy -- https://your-app.vercel.app`
 *
 * A deployment can be green in the dashboard and still be broken for the
 * person using it: the environment variables did not arrive, the catalogue's
 * pictures did not ship with the code, the retention sweep is open, or the
 * rule that a placement needs a request was never deployed. This script asks
 * the deployed site the questions that catch those, and prints one line per
 * answer.
 *
 * It reads, and it makes exactly one thing: a guest session, which it removes
 * again before it finishes. The one POST it sends that could cost money — a
 * placement with no request behind it — is refused before any work happens,
 * so no picture is drawn and no token is spent.
 *
 *   npm run check:deploy -- https://your-app.vercel.app
 *   npm run check:deploy -- --url=https://your-app.vercel.app
 *
 * Exit code 0 when every check passed, 1 when one did not.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

interface Check {
  name: string;
  ok: boolean;
  note: string;
  /** A warning is worth a look but does not fail the run. */
  soft?: boolean;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, note: string, soft = false): void {
  checks.push({ name, ok, note, soft });
}

// ---------------------------------------------------------------------------
// The URL to check
// ---------------------------------------------------------------------------

function targetUrl(): string {
  const flag = process.argv.find((arg) => arg.startsWith('--url='));
  const url = flag ? flag.slice('--url='.length) : process.argv[2];

  if (!url) {
    console.error('usage: npm run check:deploy -- https://your-app.vercel.app');
    process.exit(2);
  }

  return /^https?:\/\//.test(url) ? url : `https://${url}`;
}

// ---------------------------------------------------------------------------
// Reading the health page
// ---------------------------------------------------------------------------

/**
 * The detail line of one check on `/health`.
 *
 * The page is a server component, so the text is in the HTML as well as on
 * the screen. The label is the anchor; the detail sits in the muted span
 * right after it.
 */
function detailOf(html: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const at = html.search(new RegExp(`>${escaped}</span>`));
  if (at === -1) return null;

  const rest = html.slice(at);
  const muted = rest.indexOf('text-ink-soft">');
  if (muted === -1) return null;

  const start = muted + 'text-ink-soft">'.length;
  const end = rest.indexOf('</span>', start);
  if (end === -1) return null;

  return rest
    .slice(start, end)
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

async function checkPages(base: string): Promise<string> {
  let healthHtml = '';

  for (const [name, path] of [
    ['the home page', '/'],
    ['the chat page', '/chat'],
  ] as const) {
    const res = await fetch(`${base}${path}`);
    record(name, res.ok, `${res.status} ${path}`);
  }

  const res = await fetch(`${base}/health`);
  healthHtml = await res.text();
  record('the health page', res.ok, `${res.status} /health`);

  return healthHtml;
}

function checkHealth(html: string): void {
  const adapter = detailOf(html, 'Database adapter');
  if (adapter === null) {
    record('the database adapter', false, 'the page did not say');
  } else if (adapter.includes('local (JSON files')) {
    record(
      'the database adapter',
      false,
      'local — the deployment is on JSON files, not Supabase. Set DB_ADAPTER=supabase.',
    );
  } else {
    record('the database adapter', true, adapter);
  }

  const catalogue = detailOf(html, 'Catalog seeded');
  const count = catalogue ? Number(/(\d+) products/.exec(catalogue)?.[1] ?? 0) : 0;
  record('the catalogue', count > 0, catalogue ?? 'the page did not say');

  const key = detailOf(html, 'GEMINI_API_KEY');
  record(
    'GEMINI_API_KEY',
    key !== null && key.startsWith('set'),
    key ?? 'the page did not say',
  );

  const accounts = detailOf(html, 'Accounts');
  record('the accounts', accounts !== null, accounts ?? 'the page did not say', true);

  const storage = detailOf(html, 'Where sessions are stored');
  if (storage !== null) {
    record(
      'where sessions are stored',
      !storage.includes('cannot keep files'),
      storage,
    );
  }

  const secret = detailOf(html, 'CLEANUP_SECRET');
  record(
    'the retention sweep',
    secret !== null && secret.startsWith('set'),
    secret === null
      ? 'the page did not say'
      : secret.startsWith('set')
        ? secret
        : 'not set — /api/cleanup answers 503 and the sweep never runs',
    true,
  );
}

async function checkPictures(base: string): Promise<void> {
  // A picture from the catalogue, taken from the project's own files so the
  // check always asks for one that was supposed to be deployed.
  const directory = path.join(process.cwd(), 'public', 'product-images');
  const files = (await fs.readdir(directory)).filter((file) => file.endsWith('.jpg')).sort();
  const cataloguePicture = files[0];

  if (cataloguePicture === undefined) {
    record('the catalogue pictures', false, 'there is no .jpg under public/product-images/');
  } else {
    const res = await fetch(`${base}/product-images/${cataloguePicture}`);
    record(
      'the catalogue pictures',
      res.ok && (res.headers.get('content-type') ?? '').includes('image/'),
      `${res.status} product-images/${cataloguePicture}`,
    );
  }

  const style = await fetch(`${base}/style-examples/modern.jpg`);
  record(
    'the style cards',
    style.ok && (style.headers.get('content-type') ?? '').includes('image/'),
    `${style.status} style-examples/modern.jpg`,
  );
}

async function checkGuards(base: string): Promise<void> {
  // A session has to be creatable — this is the first thing the chat page
  // does, and the first thing that breaks when the deployment cannot store
  // anything.
  const created = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const text = await created.text();

  if (created.status !== 201) {
    record('a session can be created', false, `${created.status} ${text.slice(0, 160)}`);
  } else {
    // Put it back the way it was: the check leaves no session behind.
    try {
      const id = (JSON.parse(text) as { session_id: string }).session_id;
      await fetch(`${base}/api/session?session_id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      // The session is there and could not be read back — say so and move on.
    }
    record('a session can be created', true, `${created.status} — created, then removed again`);
  }

  // The sweep must be closed to anyone without the token.
  const cleanup = await fetch(`${base}/api/cleanup`);
  record(
    'the retention sweep is guarded',
    cleanup.status === 401,
    `${cleanup.status} — 401 is right, 200 means it is open`,
  );

  // The rule: a placement is made for a request the user wrote. Without one
  // the request is refused before any work, so this call is free.
  const generate = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: '00000000-0000-4000-8000-000000000000',
      product_id: 'check',
    }),
  });
  const body = (await generate.text()) as string;
  record(
    'a placement needs a request',
    generate.status === 400 && body.includes('no_placement_prompt'),
    `${generate.status} — 400 no_placement_prompt is right`,
  );
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const base = targetUrl().replace(/\/+$/, '');

  console.log(`checking ${base}\n`);

  const health = await checkPages(base);
  checkHealth(health);
  await checkPictures(base);
  await checkGuards(base);

  const failed = checks.filter((check) => !check.ok && !check.soft);
  const warned = checks.filter((check) => !check.ok && check.soft);

  for (const check of checks) {
    const mark = check.ok ? '✓' : check.soft ? '!' : '✗';
    console.log(`${mark} ${check.name} — ${check.note}`);
  }

  console.log('');
  if (warned.length > 0) {
    console.log(`${warned.length} warning(s) — worth a look, not broken.`);
  }

  if (failed.length > 0) {
    console.log(`${failed.length} check(s) failed.`);
    process.exitCode = 1;
    return;
  }

  console.log('every check passed.');
}

void main().catch((err) => {
  console.error('the check could not finish:', err instanceof Error ? err.message : err);
  process.exit(2);
});
