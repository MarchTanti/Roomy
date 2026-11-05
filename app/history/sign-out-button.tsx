'use client';

/**
 * The sign-out button.
 *
 * A small client component so the page itself stays a server component: the
 * server reads the sessions, the browser presses the button.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      router.push('/');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" onClick={signOut} disabled={busy} className="btn-band px-4 py-2 text-sm text-band-ink-soft">
      {busy ? 'กำลังออก…' : 'ออกจากระบบ'}
    </button>
  );
}
