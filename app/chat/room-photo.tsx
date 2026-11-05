'use client';

/**
 * Room photo picker.
 *
 * Uploads one photo and shows what the model made of it. The image never
 * touches the browser storage API or a third party — it goes straight to
 * `POST /api/upload`, which strips EXIF server-side before anything else sees
 * the bytes.
 *
 * Split out of `chat-client.tsx` because upload is a state machine of its own
 * (idle → uploading → done/error, plus a retry) and folding it into the chat
 * component would bury the chat logic.
 */

import { useRef, useState } from 'react';

import type { RoomAnalysisView } from './session-view';

interface UploadResponse {
  image_id: string;
  url: string | null;
  analysis: RoomAnalysisView | null;
  analysis_error: string | null;
  image_quota_left: number;
  room_photos_uploaded: number;
  room_photos_limit: number;
  width: number;
  height: number;
}

export function RoomPhotoPicker({
  sessionId,
  onUploaded,
}: {
  sessionId: string;
  onUploaded: (result: { imageId: string; quotaLeft: number }) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [photo, setPhoto] = useState<{ imageId: string; src: string; analysis: RoomAnalysisView | null } | null>(
    null,
  );
  const [usage, setUsage] = useState<{ used: number; limit: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  async function upload(file: File) {
    if (!file.type.startsWith('image/')) {
      setError('กรุณาเลือกไฟล์รูปภาพ (JPEG, PNG หรือ WebP)');
      return;
    }
    setUploading(true);
    setError(null);

    const form = new FormData();
    form.set('session_id', sessionId);
    form.set('file', file);

    try {
      const res = await fetch('/api/upload', { method: 'POST', body: form });
      const data = await res.json();

      if (!res.ok) {
        setError(data.message ?? data.error ?? `อัปโหลดไม่สำเร็จ (HTTP ${res.status})`);
        return;
      }

      const body = data as UploadResponse;
      setUsage({ used: body.room_photos_uploaded, limit: body.room_photos_limit });
      // Supabase hands back a signed URL that expires in an hour; the local
      // store has none, so fall back to our own authenticated image route.
      const src = body.url ?? `/api/image/${body.image_id}?session_id=${encodeURIComponent(sessionId)}`;
      setPhoto({ imageId: body.image_id, src, analysis: body.analysis });
      onUploaded({ imageId: body.image_id, quotaLeft: body.image_quota_left });

      if (body.analysis_error) {
        setError(`อัปโหลดสำเร็จ แต่วิเคราะห์ห้องไม่สำเร็จ: ${body.analysis_error}`);
      }
    } catch (err) {
      setError(`เชื่อมต่อไม่ได้: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      setUploading(false);
      // Clear the input so re-picking the same file still fires onChange.
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  const atLimit = usage !== null && usage.used >= usage.limit;

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">รูปห้อง</h3>

      {photo ? (
        <figure className="space-y-2">
          {/* Server-served, session-checked. Not a blob: URL, so a reload still
              resolves it as long as the signed URL is still alive. */}
          <img
            src={photo.src}
            alt="รูปห้องที่อัปโหลด"
            className="w-full rounded-2xl border border-line object-cover"
          />
          {photo.analysis ? (
            <figcaption className="space-y-1 rounded-xl bg-tint/70 px-3 py-2 text-[11px] leading-relaxed text-ink-soft">
              <p>
                <span className="text-ink-faint">สไตล์:</span> {photo.analysis.style}
              </p>
              <p>
                <span className="text-ink-faint">สี:</span> {photo.analysis.colors.join(' · ')}
              </p>
              <p>
                <span className="text-ink-faint">แสง:</span> {photo.analysis.lighting}
              </p>
              {photo.analysis.free_areas && photo.analysis.free_areas.length > 0 && (
                <p>
                  <span className="text-ink-faint">พื้นที่ว่าง:</span> {photo.analysis.free_areas.join(' · ')}
                </p>
              )}
            </figcaption>
          ) : (
            <figcaption className="rounded-xl bg-tint/70 px-3 py-2 text-[11px] text-ink-soft">
              วิเคราะห์ห้องไม่สำเร็จ — พิมพ์บอกสไตล์และสีในห้องมาแทนได้
            </figcaption>
          )}
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading || atLimit}
            className="btn-quiet w-full px-3 py-1.5 text-xs"
          >
            เปลี่ยนรูป
          </button>
        </figure>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void upload(file);
          }}
          disabled={uploading || atLimit}
          className={`w-full rounded-2xl border-2 border-dashed px-3 py-6 text-center text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            dragOver
              ? 'border-brand bg-brand-soft'
              : 'border-line hover:border-brand/50 hover:bg-brand-soft/50'
          }`}
        >
          {uploading ? (
            <span className="text-ink-soft">กำลังอัปโหลดและวิเคราะห์…</span>
          ) : atLimit ? (
            <>
              <span className="block font-medium text-ink">อัปโหลดครบ {usage?.limit} รูปแล้ว</span>
              <span className="mt-1 block text-ink-faint">เริ่มเซสชันใหม่เพื่ออัปโหลดเพิ่ม</span>
            </>
          ) : (
            <>
              <span aria-hidden className="mb-1 block text-xl">
                🖼
              </span>
              <span className="block font-medium text-ink">คลิกเพื่ออัปโหลดรูปห้อง</span>
              <span className="mt-1 block text-ink-faint">หรือลากไฟล์มาวางตรงนี้</span>
            </>
          )}
        </button>
      )}

      {usage && !atLimit && (
        <p className="mt-1.5 text-[11px] text-ink-faint">
          ใช้ไปแล้ว {usage.used} จาก {usage.limit} รูป
        </p>
      )}

      {error && <p className="mt-1.5 text-[11px] leading-snug text-bad">{error}</p>}

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />
    </section>
  );
}
