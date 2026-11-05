'use client';

/**
 * The card of a designed room.
 *
 * The picture is the point of the card: the assistant promised a room, and
 * here it is. Under it sits what the room is made of — the pieces, their real
 * dimensions and their real prices, straight from the catalogue rows — so the
 * user can see what the room would cost before deciding to keep it.
 *
 * The refinement box at the bottom is the "วาดใหม่" of the placement flow,
 * turned for a whole room: the user says what to change, and the next version
 * of the same room is drawn with the same pieces.
 */

import { useState } from 'react';

import type { DesignView } from '@/lib/design/view';

import { Lightbox } from './lightbox';

function baht(value: number): string {
  return `${value.toLocaleString('th-TH')} บาท`;
}

export function DesignCard({
  design,
  sessionId,
  onRefine,
  busy = false,
  outOfQuota = false,
}: {
  design: DesignView;
  /** The session the picture belongs to, for the fallback image URL. */
  sessionId: string | null;
  /** Ask for another version of this room, with this change. */
  onRefine: (instruction: string) => void;
  /** True while the assistant is working. */
  busy?: boolean;
  /** True when this session has no pictures left to draw. */
  outOfQuota?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [zoomed, setZoomed] = useState(false);

  // The Supabase store hands back a signed URL; the local store has none, so
  // fall back to our own session-checked image route.
  const src =
    design.url ??
    `/api/image/${design.image_id}?session_id=${encodeURIComponent(sessionId ?? '')}`;

  const submit = () => {
    const text = draft.trim();
    if (!text || busy || outOfQuota) return;
    onRefine(text);
    setDraft('');
  };

  return (
    <section className="card space-y-3 overflow-hidden p-3">
      <figure>
        <div className="relative">
          <img
            src={src}
            alt={`รูปจำลองของห้อง${design.theme ? `โทน${design.theme}` : ''}`}
            className="w-full rounded-lg border border-line"
          />
          <button
            type="button"
            onClick={() => setZoomed(true)}
            className="absolute right-2 bottom-2 rounded-full bg-black/60 px-3 py-1.5 text-xs text-white backdrop-blur-sm hover:bg-black/75"
          >
            ขยายรูป
          </button>
        </div>
        <figcaption className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-soft">
          <span className="font-medium text-ink">{design.style}</span>
          {design.theme && <span className="rounded bg-sunken px-1.5 py-0.5">{design.theme}</span>}
          {design.purpose && (
            <span className="rounded bg-sunken px-1.5 py-0.5">{design.purpose}</span>
          )}
          {design.room_size_m2 !== null && (
            <span className="rounded bg-sunken px-1.5 py-0.5 tabular-nums">
              {design.room_size_m2} ตร.ม.
              {design.width_cm && design.depth_cm
                ? ` (${design.width_cm}×${design.depth_cm} ซม.)`
                : ''}
            </span>
          )}
          <span className="rounded bg-sunken px-1.5 py-0.5 text-[11px]">เวอร์ชัน {design.version}</span>
          <span className="rounded bg-sunken px-1.5 py-0.5 text-[11px] text-ink-faint">ภาพจำลอง</span>
          {design.instruction && (
            <span className="w-full text-[11px] text-ink-faint">แก้ไว้ว่า “{design.instruction}”</span>
          )}
        </figcaption>
      </figure>

      {/* What the room is made of, and what it costs. */}
      <div className="rounded-xl border border-line-soft bg-sunken/40 p-3">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">
            ของในห้อง
          </h3>
          <span className="text-sm font-semibold text-brand tabular-nums">
            {baht(design.total_price_thb)}
          </span>
        </div>

        <ul className="mt-2 space-y-2">
          {design.pieces.map((piece) => (
            <li key={piece.product_id} className="flex items-center gap-2.5">
              {piece.image_url && (
                <img
                  src={piece.image_url}
                  alt=""
                  className="h-10 w-14 shrink-0 rounded border border-line bg-raised object-contain"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{piece.name_th}</p>
                <p className="text-[11px] text-ink-faint tabular-nums">
                  {piece.width_cm}×{piece.depth_cm}×{piece.height_cm} ซม.
                  {piece.color ? ` · ${piece.color}` : ''}
                </p>
                {piece.note && (
                  <p className="truncate text-[11px] text-ink-faint">“{piece.note}”</p>
                )}
              </div>
              <span className="shrink-0 text-xs text-ink-soft tabular-nums">
                {baht(piece.price_thb)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* What the user should know before keeping the room. */}
      {design.notes.length > 0 && (
        <ul className="space-y-1 text-[11px] leading-snug text-warn">
          {design.notes.map((note) => (
            <li key={note}>• {note}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim() && !busy && !outOfQuota) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="อยากปรับห้องนี้ยังไง เช่น เปลี่ยนเป็นสีฟ้า"
          disabled={busy || outOfQuota}
          className="min-w-0 flex-1 rounded-lg border border-line bg-sunken px-3 py-2 text-sm outline-none placeholder:text-ink-faint focus:border-brand disabled:opacity-50"
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy || outOfQuota || draft.trim().length === 0}
          title={outOfQuota ? 'โควตารูปของเซสชันนี้หมดแล้ว' : undefined}
          className="btn-quiet shrink-0 px-4 py-2 text-sm disabled:cursor-not-allowed"
        >
          {busy ? 'กำลังวาด…' : 'ปรับแต่งต่อ'}
        </button>
      </div>

      {outOfQuota && (
        <p className="text-xs text-warn">
          โควตารูปของเซสชันนี้หมดแล้ว — เริ่มเซสชันใหม่เพื่อวาดเพิ่มได้
        </p>
      )}

      {zoomed && (
        <Lightbox src={src} alt="รูปจำลองของห้องที่ออกแบบ" onClose={() => setZoomed(false)} />
      )}
    </section>
  );
}
