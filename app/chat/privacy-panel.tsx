'use client';

/**
 * The privacy block.
 *
 * What is left of the session's budget, what happens to the user's room
 * photo, and the button that erases everything.
 *
 * The spec's rules are not a privacy policy nobody reads — they are promises
 * the interface has to make visible. The details are one click away, and the
 * button that erases everything is right there next to them.
 *
 * It lives in the rail now, under the session state, beside everything else
 * the server knows about the session — not in a strip of its own along the
 * bottom of the chat.
 *
 * The delete is confirmed inline: a dialog for "remove my data" is heavier
 * than the action deserves, and a single click that cannot be undone is
 * heavier than it should be.
 */

import { useState } from 'react';

interface Fact {
  /** The short form, on the button that opens the details. */
  short: string;
  /** The full sentence, in the expanded panel. */
  long: string;
}

const FACTS: Fact[] = [
  {
    short: 'ส่งแค่ 2 ที่',
    long: 'รูปห้องของคุณถูกส่งไปแค่ 2 ที่ — ให้โมเดลแชทอ่านห้อง และให้โมเดลวาดรูปวางเฟอร์นิเจอร์ ไม่มีการคัดลอกรูปไปยังที่อื่น',
  },
  {
    short: 'EXIF/ตำแหน่งถูกลบ',
    long: 'ข้อมูล EXIF รวมถึงตำแหน่ง GPS ถูกลบออกจากไฟล์ทันทีที่อัปโหลด ก่อนที่ไฟล์จะถึงที่เก็บข้อมูลหรือโมเดลใด ๆ',
  },
  {
    short: 'ที่เก็บรูป + ลิงก์ 1 ชม.',
    long: 'รูปอยู่ในที่เก็บแบบส่วนตัว เปิดดูได้ผ่านลิงก์ที่มีอายุ 1 ชั่วโมงเท่านั้น และเข้าถึงได้เฉพาะเซสชันของคุณ',
  },
  {
    short: 'โควตา/เรตลิมิต',
    long: 'จำนวนรูปที่สร้างได้ต่อเซสชัน และจำนวนข้อความที่ส่งได้ต่อชั่วโมง ถูกจำกัดไว้ และจำนวนที่เหลือแสดงอยู่ในส่วนสถานะเซสชันนี้',
  },
  {
    short: 'รูปสินค้าจากแคตตาล็อก',
    long: 'รูปของสินค้าที่แนะนำถูกส่งไปให้โมเดลวาดรูปด้วย เพื่อให้ที่วางเป็นชิ้นจริงตามรูป ไม่ใช่รูปของคุณ และรูปห้องของคุณยังถูกส่งไปแค่ 2 ที่เท่าเดิม',
  },
];

export interface PrivacyPanelProps {
  /** Generated images left in this session. */
  quotaLeft: number | null;
  /** Chat turns left in this session's hour. */
  chatTurnsLeft: number | null;
  /** Called when the user confirms "delete everything". */
  onDeleteAll: () => void;
  /** True while the deletion is in flight. */
  deleting?: boolean;
  /** A message from the last deletion attempt, if it failed. */
  error?: string | null;
}

export function PrivacyPanel({
  quotaLeft,
  chatTurnsLeft,
  onDeleteAll,
  deleting = false,
  error = null,
}: PrivacyPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="mt-3 space-y-2 text-[11px] leading-relaxed">
      {/* What is left of the two budgets. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {quotaLeft !== null && (
          <span
            className={quotaLeft <= 3 ? 'text-warn' : 'text-ink-faint'}
            title="จำนวนรูปที่สร้างได้อีกในเซสชันนี้"
          >
            {quotaLeft === 0 ? 'โควตารูปหมดแล้ว' : `รูปเหลือ ${quotaLeft}`}
          </span>
        )}
        {chatTurnsLeft !== null && (
          <span className="text-ink-faint" title="จำนวนข้อความที่ส่งได้อีกใน 1 ชั่วโมงของเซสชันนี้">
            ข้อความเหลือ {chatTurnsLeft}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="rounded-full border border-line px-2.5 py-0.5 text-ink-soft hover:bg-sunken"
        >
          {expanded ? 'ซ่อนรายละเอียด' : 'รายละเอียด'}
        </button>

        {confirming ? (
          <span className="flex items-center gap-1.5">
            <span>ลบทั้งหมด?</span>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                onDeleteAll();
              }}
              disabled={deleting}
              className="rounded-full bg-bad px-3 py-0.5 font-medium text-white disabled:opacity-50"
            >
              {deleting ? 'กำลังลบ…' : 'ลบเลย'}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={deleting}
              className="rounded-full border border-line px-2.5 py-0.5 text-ink-soft hover:bg-sunken"
            >
              ยกเลิก
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-full border border-bad/30 px-2.5 py-0.5 text-bad hover:bg-bad-soft"
          >
            ลบข้อมูลทั้งหมด
          </button>
        )}
      </div>

      {expanded && (
        <div className="space-y-1 border-t border-line-soft pt-2 text-ink-soft">
          {FACTS.map((fact) => (
            <p key={fact.short}>
              <span className="font-medium text-ink">{fact.short}:</span> {fact.long}
            </p>
          ))}
          <p>
            <span className="font-medium text-ink">เก็บไว้นานแค่ไหน:</span> เซสชันและรูปทั้งหมดถูกลบอัตโนมัติหลังจาก{' '}
            7 วัน (ตั้งค่าได้ที่ RETENTION_DAYS) และคุณลบเองได้ทันทีด้วยปุ่ม
            &quot;ลบข้อมูลทั้งหมด&quot; ข้างบน
          </p>
        </div>
      )}

      {error && <p className="text-bad">ลบไม่สำเร็จ: {error}</p>}
    </div>
  );
}
