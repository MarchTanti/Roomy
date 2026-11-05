'use client';

/**
 * The live view of the session state.
 *
 * The spec asks for it: the user can see what the server has remembered, so
 * the thing they are arguing with is visible rather than a guess. It is a
 * disclosure rather than a permanent block — it is the panel's least urgent
 * content, and it should not push the photo and the filters off the screen.
 *
 * What the session may still do — the two budgets — sits under it, with the
 * promise that the room photo is only sent to two places and the button that
 * erases everything. All of it is what the server knows about this session,
 * so all of it lives in the same place.
 */

import { useState } from 'react';

import { PrivacyPanel } from './privacy-panel';
import type { SessionStateView } from './session-view';

export function StatePanel({
  sessionId,
  state,
  quotaLeft,
  chatTurnsLeft,
  onDeleteAll,
  deleting = false,
  error = null,
}: {
  sessionId: string | null;
  state: SessionStateView | null;
  quotaLeft: number | null;
  chatTurnsLeft: number | null;
  onDeleteAll: () => void;
  deleting?: boolean;
  error?: string | null;
}) {
  const [open, setOpen] = useState(false);

  const rows: [string, string][] = [
    ['session', sessionId ? `${sessionId.slice(0, 8)}…` : '…'],
    ['สไตล์ที่จำไว้', state?.preferences.style ?? 'ยังไม่มี'],
    ['งบที่จำไว้', state?.preferences.budget_thb ? `${state.preferences.budget_thb.toLocaleString('th-TH')} บาท` : 'ยังไม่มี'],
    ['หมวดที่จำไว้', state?.preferences.category ?? 'ยังไม่มี'],
    ['สินค้าที่เคยแสดง', String(state?.shown_products.length ?? 0)],
    ['รูปที่สร้างแล้ว', String(state?.generated_image_ids.length ?? 0)],
    ['พื้นที่ที่วัดไว้', state?.selected_area ? 'วัดแล้ว' : 'ยังไม่ได้วัด'],
  ];

  return (
    <section className="border-t border-line pt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-xs font-semibold tracking-wide text-ink-faint uppercase"
      >
        สถานะเซสชัน
        <span aria-hidden className="text-base leading-none">
          {open ? '−' : '+'}
        </span>
      </button>

      {open && (
        <dl className="mt-3 space-y-1.5 text-xs">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-faint">{label}</dt>
              <dd className="truncate text-ink-soft">{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {/* The budgets, the promises and the button that erases everything. */}
      <PrivacyPanel
        quotaLeft={quotaLeft}
        chatTurnsLeft={chatTurnsLeft}
        onDeleteAll={onDeleteAll}
        deleting={deleting}
        error={error}
      />
    </section>
  );
}
