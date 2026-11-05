import Link from 'next/link';
import { redirect } from 'next/navigation';

import { resolveUserByToken } from '@/lib/auth';
import { readAuthToken } from '@/lib/auth/cookie';
import { getDb } from '@/lib/db';
import { MissingTableError } from '@/lib/db/errors';
import { transcriptTitle } from '@/lib/session/transcript';

import { ThemeToggle } from '../theme-toggle';
import { HomeButton } from '../home-button';
import { SignOutButton } from './sign-out-button';

export const dynamic = 'force-dynamic';

/** "12 ก.ค. 2569, 14:30" — the way a Thai reader expects a date. */
const WHEN = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export default async function HistoryPage() {
  const user = await resolveUserByToken(await readAuthToken());
  if (!user) redirect('/login?next=/history');

  const db = getDb();
  let sessions: Awaited<ReturnType<typeof db.listSessionsForUser>> = [];
  let notReady = false;

  try {
    sessions = await db.listSessionsForUser(user.id, 50);
  } catch (err) {
    if (err instanceof MissingTableError) notReady = true;
    else throw err;
  }

  const items = await Promise.all(
    sessions.map(async (session) => {
      const messages = await db.listMessages(session.id);
      return {
        id: session.id,
        created_at: session.created_at,
        title: transcriptTitle(messages, 'บทสนทนาใหม่'),
        message_count: messages.length,
      };
    }),
  );

  return (
    <main className="min-h-dvh bg-surface">
      <header className="border-b border-band-line bg-band px-5 py-4 text-band-ink sm:px-8">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <HomeButton />
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden text-xs text-band-ink-soft sm:inline">{user.email}</span>
            <ThemeToggle />
            <SignOutButton />
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-5 py-10 sm:px-8">
        <h1 className="font-display text-3xl font-semibold tracking-tight">ประวัติการสนทนา</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          ทุกห้องที่คุณคุยกับ RoomyAI เก็บไว้ในบัญชีนี้ กดที่ห้องเพื่อกลับไปคุยต่อ
        </p>

        {notReady && (
          <div className="card mt-6 border-warn/30 bg-warn-soft p-5 text-sm leading-relaxed text-warn">
            ระบบบัญชียังไม่ได้เตรียมฐานข้อมูล — กรุณารันไฟล์
            <code className="mx-1 rounded bg-warn/10 px-1.5 py-0.5 text-xs">supabase/migrations/0003_auth.sql</code>
            ใน Supabase SQL Editor ก่อน
          </div>
        )}

        {!notReady && items.length === 0 && (
          <div className="card mt-6 p-10 text-center">
            <p className="text-sm text-ink-soft">ยังไม่มีประวัติการสนทนา</p>
            <Link href="/chat" className="btn-primary mt-5 inline-block px-5 py-2.5 text-sm">
              เริ่มแชท
            </Link>
          </div>
        )}

        {items.length > 0 && (
          <ul className="mt-6 space-y-2.5">
            {items.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/chat?session=${encodeURIComponent(item.id)}`}
                  className="card flex items-center gap-4 p-4 transition-colors hover:bg-tint/50"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{item.title}</p>
                    <p className="mt-1 text-xs text-ink-faint">
                      {WHEN.format(new Date(item.created_at))} · {item.message_count} ข้อความ
                    </p>
                  </div>
                  <span aria-hidden className="shrink-0 text-ink-faint">
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
