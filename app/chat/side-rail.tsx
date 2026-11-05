'use client';

/**
 * The left rail.
 *
 * One column, four parts: the way home at the top, the conversation list, the
 * tools below it, and the account at the bottom. They were two columns once,
 * and two columns meant two edges of the screen spent on furniture while the
 * conversation got squeezed in the middle.
 *
 * The list is read from `/api/history`, which only answers for a signed-in
 * account. A guest is told so, and offered the sign-in, rather than being
 * shown an empty column that looks broken.
 *
 * On a narrow screen the column is a drawer that slides in from the left.
 * On a wide one it is a column beside the conversation, and one button opens
 * or closes it — the one that sits beside the mark at the top.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { HomeButton } from '../home-button';
import { ThemeToggle } from '../theme-toggle';
import { PanelIcon } from './panel-icon';
import { listLabel, shortTitle, type HistoryItem } from './session-list';

export interface SideRailProps {
  /** The conversation on screen right now. */
  currentId: string | null;
  /** Whether there is an account whose history can be read. */
  signedIn: boolean;
  /** The address of that account, shown at the bottom of the rail. */
  accountEmail: string | null;
  /** Bumped whenever the list should be read again. */
  version: number;
  /** Opens a conversation. */
  onOpen: (id: string) => Promise<void>;
  /** Starts a new conversation. */
  onNewChat: () => Promise<void>;
  /** Whether the rail is showing. */
  open: boolean;
  /** False until the client has taken over, so the drawer cannot flash. */
  mounted: boolean;
  /** Closes the rail. */
  onClose: () => void;
  /** The tools — the lower half of the rail. */
  children: ReactNode;
}

export function SideRail({
  currentId,
  signedIn,
  accountEmail,
  version,
  onOpen,
  onNewChat,
  open,
  mounted,
  onClose,
  children,
}: SideRailProps) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The list is read again whenever the account changes, and whenever a new
  // conversation is started — a conversation that is not in the list yet is
  // a conversation the person cannot find.
  useEffect(() => {
    if (!signedIn) {
      setItems([]);
      return;
    }

    let cancelled = false;
    setLoading(true);

    async function load() {
      try {
        const res = await fetch('/api/history');
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as { sessions: HistoryItem[] };
        if (!cancelled) {
          setItems(data.sessions ?? []);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'อ่านประวัติไม่สำเร็จ');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [signedIn, version]);

  const open_ = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        await onOpen(id);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'เปิดบทสนทนานี้ไม่สำเร็จ');
      } finally {
        setBusy(false);
      }
    },
    [onOpen],
  );

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await onNewChat();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'เริ่มแชทใหม่ไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }, [onNewChat]);

  return (
    <aside
      aria-hidden={!open}
      inert={!open}
      className={`fixed inset-y-0 left-0 z-40 flex h-dvh w-[min(21rem,90vw)] flex-col border-r border-line-soft bg-tint transition-transform duration-200 lg:static lg:z-auto lg:h-dvh lg:w-80 lg:shrink-0 ${
        open ? 'translate-x-0' : '-translate-x-full lg:hidden'
      } ${mounted ? '' : 'max-lg:hidden'}`}
    >
      {/* ---- the top row: the way home, and the button that closes the rail ---- */}
      {/* The chat page has no band of its own any more, so the mark lives here,
          at the top of the rail, where the way home belongs on a page that is
          mostly a conversation. The button beside it is the one control that
          opens and closes the rail. */}
      <div className="flex shrink-0 items-center gap-1 border-b border-line-soft px-3 py-2.5">
        <button
          type="button"
          onClick={onClose}
          aria-expanded={open}
          aria-label="ปิดแถบด้านซ้าย — ประวัติการสนทนาและเครื่องมือ"
          title="ปิดแถบด้านซ้าย"
          className="grid size-8 shrink-0 place-items-center rounded-full text-ink-soft transition-colors hover:bg-sunken hover:text-ink"
        >
          <PanelIcon />
        </button>

        <HomeButton tone="rail" iconSize={26} />
      </div>

      {/* ---- the top half: the conversations ---- */}
      <section className="flex max-h-[50%] min-h-0 shrink-0 flex-col border-b border-line-soft">
        <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2">
          <h2 className="text-sm font-semibold">ประวัติการสนทนา</h2>
        </div>

        <div className="px-3 pb-3">
          <button
            type="button"
            onClick={() => void start()}
            disabled={busy}
            className="btn-primary w-full px-3 py-2 text-xs disabled:opacity-50"
          >
            <span aria-hidden className="mr-1">
              +
            </span>
            แชทใหม่
          </button>
        </div>

        <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {!signedIn ? (
            <p className="px-1 text-xs leading-relaxed text-ink-soft">
              เข้าสู่ระบบเพื่อเก็บบทสนทนาไว้และกลับมาคุยต่อได้{' '}
              <a href="/login?next=/chat" className="text-brand underline underline-offset-4">
                เข้าสู่ระบบ
              </a>
            </p>
          ) : loading && items.length === 0 ? (
            <p className="px-1 text-xs text-ink-faint">กำลังโหลด…</p>
          ) : items.length === 0 ? (
            <p className="px-1 text-xs leading-relaxed text-ink-soft">
              ยังไม่มีประวัติการสนทนา — บทสนทนาที่คุณเริ่มจะปรากฏที่นี่
            </p>
          ) : (
            <ul className="space-y-0.5">
              {items.map((item) => {
                const active = item.id === currentId;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => void open_(item.id)}
                      disabled={busy}
                      aria-current={active ? 'true' : undefined}
                      className={`w-full rounded-xl px-2.5 py-2 text-left transition-colors disabled:opacity-50 ${
                        active
                          ? 'bg-brand-soft text-ink'
                          : 'text-ink-soft hover:bg-surface hover:text-ink'
                      }`}
                    >
                      <span className="block truncate text-xs font-medium">
                        {shortTitle(item.title)}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-ink-faint">
                        {listLabel(item)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {error && <p className="mt-2 px-1 text-[11px] leading-snug text-bad">{error}</p>}
        </div>
      </section>

      {/* ---- the bottom half: the tools ---- */}
      <section className="flex min-h-0 flex-1 flex-col">
        <div className="px-4 py-2.5">
          <h2 className="text-sm font-semibold">เครื่องมือ</h2>
        </div>

        <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-4 pb-6">
          {children}
        </div>
      </section>

      {/* ---- the very bottom: the account, and the theme ---- */}
      {/* The way in and the way out sit at the foot of the rail, the way a
          sidebar puts them: signing in is optional, so it is a quiet link,
          and the theme switch is the one setting everybody wants. */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-line-soft px-3 py-2.5">
        {accountEmail ? (
          <a
            href="/history"
            title={accountEmail}
            className="min-w-0 truncate rounded-full px-2 py-1 text-xs text-ink-soft transition-colors hover:bg-sunken hover:text-ink"
          >
            {accountEmail}
          </a>
        ) : (
          <a
            href="/login?next=/chat"
            className="rounded-full px-2 py-1 text-xs text-ink-soft transition-colors hover:bg-sunken hover:text-ink"
          >
            เข้าสู่ระบบ
          </a>
        )}

        <ThemeToggle className="grid size-8 shrink-0 place-items-center rounded-full text-ink-soft transition-colors hover:bg-sunken hover:text-ink" />
      </div>
    </aside>
  );
}
