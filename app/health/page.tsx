import { authMode } from '@/lib/auth';
import { activeAdapter, getDb } from '@/lib/db';
import { MissingTableError } from '@/lib/db/errors';
import { dbAdapter, hasSupabase, settings } from '@/lib/env';

import { HomeButton } from '../home-button';
import { ThemeToggle } from '../theme-toggle';

export const dynamic = 'force-dynamic';

type Health = {
  label: string;
  ok: boolean;
  detail: string;
};

async function check(): Promise<Health[]> {
  const checks: Health[] = [];

  // 1. Which database adapter is live.
  const adapter = activeAdapter();
  checks.push({
    label: 'Database adapter',
    ok: true,
    detail:
      adapter === 'supabase'
        ? 'supabase (Postgres)'
        : `local (JSON files under .data/) — requested "${dbAdapter()}", Supabase creds ${hasSupabase() ? 'present' : 'missing'}`,
  });

  // 2. Is the catalog seeded?
  try {
    const count = await getDb().countProducts();
    checks.push({
      label: 'Catalog seeded',
      ok: count >= 30,
      detail: `${count} products`,
    });
  } catch (err) {
    checks.push({
      label: 'Catalog seeded',
      ok: false,
      detail: err instanceof Error ? err.message : 'unknown error',
    });
  }

  // 3. Optional credentials — missing is fine until a later build step needs them.
  const present = Boolean(process.env.GEMINI_API_KEY?.trim());
  checks.push({
    label: 'GEMINI_API_KEY',
    ok: present,
    detail: present
      ? `set · chat ${process.env.LLM_MODEL ?? '(unset)'} · image ${process.env.IMAGE_MODEL ?? '(unset)'}`
      : 'not set (needed from build step 2 onward)',
  });

  // 4. The retention sweep. The secret's value is never shown — only whether
  //    it is there, because "not set" means the endpoint is off.
  const cleanupSecret = settings.cleanupSecret();
  checks.push({
    label: 'CLEANUP_SECRET',
    ok: cleanupSecret !== undefined,
    detail:
      cleanupSecret === undefined
        ? 'not set (POST /api/cleanup is off — npm run cleanup still works)'
        : `set · retention ${settings.retentionDays()} days`,
  });

  // 5. The account system. Which one is in use, and are its tables there?
  checks.push({
    label: 'Accounts',
    ok: true,
    detail: authMode() === 'supabase' ? 'Supabase Auth' : 'local email + password',
  });

  try {
    await getDb().getUserByEmail('nobody@example.com');
    checks.push({
      label: 'Account tables',
      ok: true,
      detail: 'users / auth_sessions are present',
    });
  } catch (err) {
    checks.push({
      label: 'Account tables',
      ok: false,
      detail:
        err instanceof MissingTableError
          ? `"${err.table}" is missing — run supabase/migrations/0003_auth.sql`
          : err instanceof Error
            ? err.message
            : 'unknown error',
    });
  }

  return checks;
}

/**
 * The wiring check.
 *
 * It used to be the front page, which meant the first thing anyone saw was a
 * list of build steps. It is still here — a developer wants it — but it is
 * one link away from the landing page now.
 */
export default async function HealthPage() {
  const checks = await check();
  const adapter = activeAdapter();

  return (
    <>
      {/* The same blue band every other page opens with, so the way home is
          here too — with the mark in it. */}
      <header className="flex items-center gap-2 bg-band px-5 py-4 text-band-ink sm:px-8">
        <HomeButton />
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-6 py-14">
        <h1 className="font-display text-2xl font-semibold">สถานะระบบ</h1>
        <p className="mt-2 text-sm text-ink-soft">
          หน้านี้ยืนยันว่า scaffold, Tailwind, ตัวแปลงฐานข้อมูล และข้อมูลแคตตาล้อกพร้อมใช้งานแล้ว
        </p>

        <ul className="mt-8 space-y-2">
          {checks.map((c) => (
            <li
              key={c.label}
              className="flex items-baseline justify-between gap-4 card px-4 py-3"
            >
              <span className="font-medium">{c.label}</span>
              <span className="flex items-baseline gap-3 text-sm">
                <span className="text-ink-soft">{c.detail}</span>
                <span aria-hidden>{c.ok ? '✅' : '⚠️'}</span>
              </span>
            </li>
          ))}
        </ul>

        <section className="mt-10 text-sm text-ink-soft">
          <h2 className="text-xs font-semibold tracking-wide uppercase opacity-60">Commands</h2>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-sunken p-4 text-xs">
            {`npm run seed      # load the catalog into the database
npm run dev       # start the app at http://localhost:3000
npm test          # unit tests
npm run results   # the end-to-end run, into results.json
npm run typecheck # tsc --noEmit`}
          </pre>
        </section>

        <p className="mt-10 text-xs text-ink-faint">
          Adapter ปัจจุบัน: <code>{adapter}</code> · quota {settings.imageQuotaPerSession()} รูป/เซสชัน ·
          chat {settings.chatTurnsPerHour()} ข้อความ/ชั่วโมง
        </p>
      </main>
    </>
  );
}
