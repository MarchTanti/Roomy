'use client';

/**
 * Measure a space on the room photo.
 *
 * The user drags two things onto the photo: the free area they mean to fill,
 * and a reference line across something whose real length they know (a 60 cm
 * table, a 210 cm mattress). The line turns pixels into centimetres, and with
 * both of them `checkFit` can answer "will it go in?" with numbers instead of
 * adjectives.
 *
 * Two details that are easy to get wrong and expensive when wrong:
 *
 *   - The overlay is `absolute inset-0` over an image with no `object-cover`,
 *     so it covers the whole photo and the coordinates map onto it directly.
 *     Cropping the display would silently shift every measurement.
 *   - The preview uses the same `lib/fit.ts` arithmetic the server uses, given
 *     the photo's real aspect. A second implementation here would eventually
 *     disagree with the answer the user gets in the chat.
 *
 * Measuring is optional. If it is too fiddly, the user can just type the size
 * in the chat and `checkFit` will use that instead.
 */

import { useRef, useState } from 'react';

import { areaFromDrag, lineFromDrag } from './geometry';
import { areaToSpace, deriveScale } from '@/lib/fit';
import type { Area, ReferenceLine } from '@/lib/db/types';
import type { MeasurementView } from './session-view';

type Mode = 'area' | 'reference';

interface DragState {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

export function AreaPicker({
  sessionId,
  roomImageId,
  measurement,
  onSaved,
}: {
  sessionId: string;
  roomImageId: string;
  measurement: MeasurementView;
  onSaved: (next: MeasurementView) => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>('area');
  const [area, setArea] = useState<Area | null>(measurement.selected_area);
  const [line, setLine] = useState<ReferenceLine | null>(measurement.reference_line);
  const [referenceCm, setReferenceCm] = useState<string>(
    measurement.reference_cm === null ? '' : String(measurement.reference_cm),
  );
  const [drag, setDrag] = useState<DragState | null>(null);
  const [aspect, setAspect] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cm = Number(referenceCm);
  const hasReference = Number.isFinite(cm) && cm > 0;
  const draft = drag ? dragShape(drag, mode, frameRef.current) : null;

  // The live preview is the server's own arithmetic, not a second opinion.
  const preview =
    hasReference && (area ?? draft?.area ?? null)
      ? areaToSpace(
          area ?? draft?.area ?? null,
          deriveScale(line ?? draft?.line ?? null, cm, aspect),
        )
      : null;

  function startDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const box = boxOf(e, frameRef.current);
    if (!box) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ fromX: box.x, fromY: box.y, toX: box.x, toY: box.y });
  }

  function moveDrag(e: React.PointerEvent<HTMLDivElement>) {
    const box = boxOf(e, frameRef.current);
    if (!box || !drag) return;
    setDrag({ ...drag, toX: box.x, toY: box.y });
  }

  function endDrag() {
    if (!drag || !frameRef.current) return;
    const bounds = frameRef.current.getBoundingClientRect();
    const gesture = {
      from: [drag.fromX, drag.fromY] as [number, number],
      to: [drag.toX, drag.toY] as [number, number],
      box: { width: bounds.width, height: bounds.height },
    };

    if (mode === 'area') {
      const drawn = areaFromDrag(gesture);
      if (drawn) setArea(drawn);
      else setError('ลากกรอบให้ใหญ่กว่านี้เล็กน้อย');
    } else {
      const drawn = lineFromDrag(gesture);
      if (drawn) setLine(drawn);
      else setError('ลากเส้นให้ยาวกว่านี้เล็กน้อย');
    }
    setDrag(null);
  }

  async function save(next: MeasurementView) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/session', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, ...next }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.issues?.[0]?.problem ?? data.error ?? `บันทึกไม่สำเร็จ (HTTP ${res.status})`);
        return;
      }
      onSaved({
        selected_area: data.state.selected_area,
        reference_line: data.state.reference_line,
        reference_cm: data.state.reference_cm,
      });
    } catch (err) {
      setError(`เชื่อมต่อไม่ได้: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      setSaving(false);
    }
  }

  const measured = measurement.selected_area !== null && measurement.reference_cm !== null;

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
        วัดพื้นที่บนรูป
      </h3>

      <div className="relative">
        {/* No `object-cover`: the overlay below is mapped onto the photo 1:1. */}
        <img
          src={`/api/image/${roomImageId}?session_id=${encodeURIComponent(sessionId)}`}
          alt="รูปห้อง"
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget;
            if (img.naturalWidth > 0) setAspect(img.naturalWidth / img.naturalHeight);
          }}
          className="block w-full rounded-2xl border border-line"
        />

        <div
          ref={frameRef}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={() => setDrag(null)}
          className="absolute inset-0 cursor-crosshair touch-none"
        >
          <AreaOutline area={area ?? draft?.area ?? null} active={mode === 'area'} />
          <LineShape line={line ?? draft?.line ?? null} active={mode === 'reference'} />
        </div>
      </div>

      <div className="mt-2 flex gap-1.5">
        <ModeButton label="1. ลากกรอบพื้นที่" active={mode === 'area'} onClick={() => setMode('area')} />
        <ModeButton
          label="2. ลากเส้นอ้างอิง"
          active={mode === 'reference'}
          onClick={() => setMode('reference')}
        />
      </div>

      <label className="mt-2.5 block space-y-1 text-[11px]">
        <span className="text-ink-faint">เส้นอ้างอิงนี้ยาวจริงกี่ซม.</span>
        <input
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          value={referenceCm}
          onChange={(e) => setReferenceCm(e.target.value)}
          placeholder="เช่น 60 (โต๊ะ) หรือ 210 (ที่นอน)"
          className="w-full rounded-xl border border-line bg-raised px-2.5 py-1.5 text-[11px] outline-none focus:border-brand"
        />
      </label>

      <p className="mt-2 text-[11px] leading-relaxed text-ink-soft">
        {preview ? (
          <>
            พื้นที่นี้ประมาณ{' '}
            <span className="font-medium text-ink tabular-nums">
              {preview.width_cm} × {preview.depth_cm} ซม.
            </span>
          </>
        ) : hasReference ? (
          'ยังไม่ได้ลากกรอบพื้นที่'
        ) : (
          'ใส่ความยาวจริงของเส้นอ้างอิงก่อน แล้วระบบจะคำนวณเป็นเซนติเมตรให้'
        )}
      </p>

      {measured && (
        <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-ok-soft px-2 py-0.5 text-[11px] text-ok">
          <span aria-hidden>✓</span> วัดแล้ว — ผมจะใช้พื้นที่นี้ตอนเช็กขนาด
        </p>
      )}

      <div className="mt-2.5 flex gap-1.5">
        <button
          type="button"
          disabled={saving}
          onClick={() =>
            void save({
              selected_area: area,
              reference_line: line,
              reference_cm: hasReference ? cm : null,
            })
          }
          className="btn-primary flex-1 px-2 py-1.5 text-[11px]"
        >
          {saving ? 'กำลังบันทึก…' : 'บันทึกการวัด'}
        </button>
        <button
          type="button"
          disabled={saving || (!area && !line && !hasReference)}
          onClick={() => {
            setArea(null);
            setLine(null);
            setReferenceCm('');
            void save({ selected_area: null, reference_line: null, reference_cm: null });
          }}
          className="btn-quiet px-3 py-1.5 text-[11px]"
        >
          ล้าง
        </button>
      </div>

      {error && <p className="mt-1.5 text-[11px] leading-snug text-bad">{error}</p>}
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
        วัดไม่สะดวก? บอกขนาดเป็นตัวเลขในแชทได้เลย ผมจะใช้ตัวเลขนั้นแทน
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------

function ModeButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-full border px-2 py-1.5 text-[11px] ${
        active ? 'border-brand-fill bg-brand-fill text-brand-ink' : 'border-line text-ink-soft hover:bg-brand-soft'
      }`}
    >
      {label}
    </button>
  );
}

/** The dragged shape, in whichever mode is active. */
function dragShape(
  drag: DragState,
  mode: Mode,
  frame: HTMLDivElement | null,
): { area?: Area; line?: ReferenceLine } | null {
  if (!frame) return null;
  const box = frame.getBoundingClientRect();
  const gesture = {
    from: [drag.fromX, drag.fromY] as [number, number],
    to: [drag.toX, drag.toY] as [number, number],
    box: { width: box.width, height: box.height },
  };
  return mode === 'area'
    ? { area: areaFromDrag(gesture) ?? undefined }
    : { line: lineFromDrag(gesture) ?? undefined };
}

function boxOf(e: React.PointerEvent<HTMLDivElement>, frame: HTMLDivElement | null) {
  if (!frame) return null;
  const rect = frame.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function AreaOutline({ area, active }: { area: Area | null; active: boolean }) {
  if (!area) return null;
  return (
    <div
      className={`pointer-events-none absolute border-2 ${active ? 'border-dashed border-brand' : 'border-brand/70'}`}
      style={{
        left: `${area.x * 100}%`,
        top: `${area.y * 100}%`,
        width: `${area.w * 100}%`,
        height: `${area.h * 100}%`,
        background: 'rgba(180, 85, 42, 0.14)',
      }}
    />
  );
}

function LineShape({ line, active }: { line: ReferenceLine | null; active: boolean }) {
  if (!line) return null;
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      <line
        x1={line.x1 * 100}
        y1={line.y1 * 100}
        x2={line.x2 * 100}
        y2={line.y2 * 100}
        stroke={active ? '#b4552a' : '#b4552acc'}
        strokeWidth={2}
        strokeDasharray={active ? '4 3' : undefined}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      {[line.x1, line.x2].map((x, i) => (
        <circle key={i} cx={x * 100} cy={(i === 0 ? line.y1 : line.y2) * 100} r={1.2} fill="#b4552a" />
      ))}
    </svg>
  );
}
