'use client';

/**
 * The sign-in form.
 *
 * One form with two modes rather than two pages: the difference between
 * "เข้าสู่ระบบ" and "สมัครสมาชิก" is a tab, not a journey.
 *
 * Signing in is optional. The guest can chat without an account, and the page
 * says so — an account is for keeping the history, not for getting in.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ThemeToggle } from '../theme-toggle';
import { HomeButton } from '../home-button';

/** The chat session the browser is holding, so it can be handed over. */
const SESSION_KEY = 'roomy.session_id';

type Mode = 'login' | 'register';

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/auth/${mode === 'login' ? 'login' : 'register'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          session_id: window.localStorage.getItem(SESSION_KEY),
        }),
      });

      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? 'ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง');
        return;
      }

      router.push(next);
      router.refresh();
    } catch {
      setError('เชื่อมต่อไม่สำเร็จ ลองใหม่อีกครั้ง');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-dvh bg-surface">
      {/* The same blue band every other page opens with. */}
      <header className="flex items-center gap-2 bg-band px-5 py-4 text-band-ink sm:px-8">
        <HomeButton />
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>

      <div className="px-4 py-10 sm:py-16">
        <div className="mx-auto w-full max-w-md">
          <div className="card p-6 sm:p-8">
            <h1 className="font-display text-2xl font-semibold tracking-tight">
              {mode === 'login' ? 'เข้าสู่ระบบ' : 'สมัครสมาชิก'}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              {mode === 'login'
                ? 'เข้าสู่ระบบเพื่อดูประวัติการสนทนาทั้งหมดของคุณ'
                : 'สร้างบัญชีเพื่อเก็บประวัติการสนทนาไว้ให้เปิดดูภายหลัง'}
            </p>

            {/* The two modes, as two pills. */}
            <div
              role="tablist"
              aria-label="เข้าสู่ระบบ หรือ สมัครสมาชิก"
              className="mt-6 flex gap-1 rounded-full bg-tint/80 p-1"
            >
              {(
                [
                  ['login', 'เข้าสู่ระบบ'],
                  ['register', 'สมัครสมาชิก'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={mode === value}
                  onClick={() => {
                    setMode(value);
                    setError(null);
                  }}
                  className={`flex-1 rounded-full px-4 py-2 text-sm transition-colors ${
                    mode === value
                      ? 'bg-raised font-medium text-ink shadow-quiet'
                      : 'text-ink-soft hover:text-ink'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <form onSubmit={submit} className="mt-6 space-y-4">
              <div>
                <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-ink-soft">
                  อีเมล
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="field"
                />
              </div>

              <div>
                <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-ink-soft">
                  รหัสผ่าน
                </label>
                <div className="relative">
                  <input
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="อย่างน้อย 8 ตัวอักษร"
                    className="field pr-12"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
                    className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full px-2.5 py-1 text-xs text-ink-faint hover:text-ink-soft"
                  >
                    {showPassword ? 'ซ่อน' : 'ดู'}
                  </button>
                </div>
              </div>

              {error && (
                <p
                  role="alert"
                  className="rounded-2xl border border-bad/25 bg-bad-soft px-4 py-3 text-sm leading-relaxed text-bad"
                >
                  {error}
                </p>
              )}

              <button type="submit" disabled={busy} className="btn-primary w-full px-4 py-3 text-sm">
                {busy ? 'กำลังทำรายการ…' : mode === 'login' ? 'เข้าสู่ระบบ' : 'สมัครสมาชิก'}
              </button>
            </form>
          </div>

          {/* An account is a convenience, not a door. */}
          <p className="mt-6 text-center text-sm leading-relaxed text-ink-soft">
            ไม่จำเป็นต้องมีบัญชีก็แชทได้ —{' '}
            <Link href="/chat" className="font-medium text-brand underline underline-offset-4">
              เริ่มแชทเลย
            </Link>
            <br />
            <span className="text-xs text-ink-faint">
              บัญชีมีไว้เพื่อเก็บประวัติการสนทนาไว้ดูภายหลัง
            </span>
          </p>
        </div>
      </div>
    </main>
  );
}
