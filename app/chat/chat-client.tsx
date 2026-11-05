'use client';

/**
 * Chat UI.
 *
 * The screen is a conversation with a rail beside it:
 *
 *   - the left rail — the mark and the button that closes the rail at the
 *     top, the conversation list below it (every chat this account has, and a
 *     button that starts a new one), the tools under that (the room photo,
 *     the measurement, the preference chips and the live session state), and
 *     the account and the theme switch at the very bottom
 *   - the chat column on the right, with the composer at the bottom
 *
 * On a wide screen the rail stands beside the conversation. On a narrow one
 * it slides in from the left as a drawer.
 *
 * Two entry points for the same preferences, as specified: the chips above the
 * composer are always visible, and the panel has the full list.
 *
 * The client never talks to Gemini or the database. It calls the route
 * handlers and renders what comes back.
 */

import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';

import { HomeButton } from '../home-button';
import { AreaPicker } from './area-picker';
import { BUDGETS, CATEGORIES, QUICK_CHIPS, STYLES, STARTERS } from './filters';
import { SideRail } from './side-rail';
import { Markdown } from './markdown-view';
import { PanelIcon } from './panel-icon';
import { DesignCard } from './design-card';
import {
  ProductCards,
  type ComparisonView,
  type GeneratedImageView,
  type ProductCardView,
} from './product-cards';
import { RoomPhotoPicker } from './room-photo';
import { StatePanel } from './state-panel';
import type { SessionStateView } from './session-view';
import type { DesignView } from '@/lib/design/view';

/** The server rejects longer turns; the composer says so before it happens. */
const MAX_MESSAGE = 4000;

interface Bubble {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** This bubble is an error, not an answer. */
  failed?: boolean;
  /** The turn to send again when the user asks to retry. */
  retry?: string;
  /** The tools the model called for this answer. */
  toolCalls?: { name: string; args: unknown }[];
  /** The products of the last search, as cards the user can press. */
  products?: ProductCardView[];
  /** The pictures made from those cards. */
  images?: GeneratedImageView[];
  /** The comparison the model asked for, if it asked for one. */
  comparison?: ComparisonView | null;
  /** The room the model designed, if it designed one. */
  design?: DesignView | null;
}

/** One server-sent frame from /api/chat. */
type ChatEvent =
  | { type: 'step' }
  | { type: 'tool'; name: string }
  | { type: 'delta'; text: string }
  | {
      type: 'done';
      reply: string;
      tool_calls: { name: string; args: unknown }[];
      iterations: number;
      hit_iteration_cap: boolean;
      state: SessionStateView | null;
      products: ProductCardView[] | null;
      comparison: ComparisonView | null;
      design?: DesignView | null;
      chat_turns_left?: number;
    }
  | { type: 'error'; error: string; message: string };

/** What the model is doing, in the user's language. */
const ACTIVITY: Record<string, string> = {
  searchFurniture: 'กำลังค้นหาสินค้าที่เข้ากับห้อง…',
  analyzeRoom: 'กำลังดูรูปห้องของคุณ…',
  checkFit: 'กำลังเช็กว่าวางได้ไหม…',
  compareOptions: 'กำลังเทียบตัวเลือก…',
  designRoom: 'กำลังวาดห้องให้ดู…',
};

const SESSION_KEY = 'roomy.session_id';

/** What the server hands back when a session is created. */
interface SessionPayload {
  session_id: string;
  state: SessionStateView;
  image_quota_left: number;
  chat_turns_left?: number;
  /** The stored conversation, when an old session was reopened. */
  messages?: {
    role: 'user' | 'assistant';
    text: string;
    products?: ProductCardView[];
    design?: DesignView;
  }[];
}

/**
 * The request the pieces in a bubble are placed for.
 *
 * The nearest user message before the bubble: the sentence the user typed
 * that this answer is about. A placement is made for a request somebody
 * wrote, so a bubble with no user message in front of it has nothing to
 * place — the button stays shut and says so.
 */
function requestBefore(bubbles: Bubble[], index: number): string | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    const bubble = bubbles[i];
    if (bubble.role === 'user' && bubble.text.trim().length > 0) return bubble.text.trim();
  }
  return null;
}

/** The signed-in account, when there is one. */
interface Account {
  email: string;
  display_name: string | null;
}

/**
 * Creates a session and remembers it in the browser.
 *
 * Module-level so the boot sequence and "start a new session" do exactly the
 * same thing.
 */
async function createSession(): Promise<SessionPayload> {
  const res = await fetch('/api/session', { method: 'POST' });
  if (!res.ok) throw new Error(`สร้างเซสชันไม่สำเร็จ (HTTP ${res.status})`);
  const data = await res.json();
  if (data.error === 'server_not_configured') {
    throw new Error(`ยังไม่ได้ตั้งค่า ${data.key} — ดู .env.example`);
  }
  window.localStorage.setItem(SESSION_KEY, data.session_id);
  return data as SessionPayload;
}

/**
 * Reads an SSE body into frames.
 *
 * Frames are separated by a blank line, but a chunk boundary can land anywhere
 * — mid-frame, even mid-character — so we buffer and only emit complete frames.
 */
async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split = buffer.indexOf('\n\n');
      while (split !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        // Only `data:` lines carry our payload; ignore comments and blanks.
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('');
        if (data) onEvent(JSON.parse(data) as ChatEvent);
        split = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function ChatClient() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  /** What the model is doing right now, in the user's language. */
  const [activity, setActivity] = useState<string | null>(null);
  /** Whether the left rail is open. On a phone it is a drawer. */
  const [railOpen, setRailOpen] = useState(true);
  /** Bumped when a conversation is started, so the list is read again. */
  const [historyVersion, setHistoryVersion] = useState(0);
  /** False until the first render on the client, so the drawer cannot flash. */
  const [mounted, setMounted] = useState(false);
  const [state, setState] = useState<SessionStateView | null>(null);
  const [quotaLeft, setQuotaLeft] = useState<number | null>(null);
  const [chatTurnsLeft, setChatTurnsLeft] = useState<number | null>(null);
  const [rateLimit, setRateLimit] = useState<string | null>(null);
  /** True while the "delete everything" request is in flight. */
  const [deleting, setDeleting] = useState(false);
  /** A failed deletion, shown in the session state. */
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** The product being turned into a picture right now. */
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  /** A failure, and the bubble it belongs to. */
  const [generateError, setGenerateError] = useState<{ bubbleId: string; message: string } | null>(null);
  /** The signed-in account, when there is one. */
  const [account, setAccount] = useState<Account | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  /** Whether the chat column is scrolled to the bottom. */
  const atBottom = useRef(true);
  /** The same thing as state, so the "scroll down" button can come and go. */
  const [atBottomState, setAtBottomState] = useState(true);

  // --- session bootstrap ------------------------------------------------
  /**
   * Puts a session on screen.
   *
   * Everything the server knows about the conversation comes back in one
   * object: the preferences, the measurement, what is left of the image
   * budget, and the transcript. Whether the transcript is shown depends on
   * where the session came from — a new one has none.
   */
  const applySession = useCallback((data: SessionPayload, withMessages: boolean) => {
    setSessionId(data.session_id);
    setState(data.state);
    setQuotaLeft(data.image_quota_left);
    setChatTurnsLeft(data.chat_turns_left ?? null);

    if (!withMessages) return;
    setBubbles(
      (data.messages ?? []).map((message, index) => ({
        id: `history-${index}`,
        role: message.role,
        text: message.text,
        products: message.products,
        design: message.design ?? null,
      })),
    );
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        // A session asked for by the history page wins over the one this
        // browser remembers.
        const requested = new URLSearchParams(window.location.search).get('session');
        const existing = requested ?? window.localStorage.getItem(SESSION_KEY);

        if (existing) {
          const res = await fetch(`/api/session?session_id=${encodeURIComponent(existing)}`);
          if (res.ok) {
            const data = (await res.json()) as SessionPayload;
            if (!cancelled) {
              applySession(data, true);
              if (requested) {
                // Reopening a conversation from the history: the chat
                // continues that session, and the transcript comes back with
                // it.
                window.localStorage.setItem(SESSION_KEY, data.session_id);
              }
              return;
            }
          }

          if (requested) {
            // The conversation cannot be opened. Say so instead of quietly
            // starting an empty one.
            if (!cancelled) {
              setBootError(
                res.status === 403
                  ? 'บทสนทนานี้เป็นของบัญชีอื่น — เข้าสู่ระบบด้วยบัญชีที่ถูกต้อง'
                  : 'ไม่พบบทสนทนานี้ — มันอาจถูกลบไปแล้ว',
              );
            }
            return;
          }

          window.localStorage.removeItem(SESSION_KEY);
        }

        const data = await createSession();
        if (cancelled) return;
        applySession(data, false);
      } catch (err) {
        if (!cancelled) setBootError(err instanceof Error ? err.message : 'เชื่อมต่อเซสชันไม่สำเร็จ');
      }
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, [applySession]);

  // --- who is signed in -------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    async function who() {
      try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) return;
        const data = (await res.json()) as { user: Account | null };
        if (!cancelled && data.user) setAccount(data.user);
      } catch {
        // Nobody is signed in. The chat works either way.
      }
    }

    void who();
    return () => {
      cancelled = true;
    };
  }, []);

  // The rail fills the side of a wide screen but would cover the chat of a
  // narrow one, so it starts closed on a small screen.
  useEffect(() => {
    setMounted(true);
    if (!window.matchMedia('(min-width: 1024px)').matches) setRailOpen(false);
  }, []);

  // --- autoscroll -------------------------------------------------------
  useEffect(() => {
    if (!atBottom.current) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [bubbles]);

  // --- composer grows with what is typed --------------------------------
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [input]);

  // --- send -------------------------------------------------------------
  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending || !sessionId) return;

      setInput('');
      setSending(true);
      setRateLimit(null);
      setActivity(null);

      // A stable id so deltas update one bubble in place instead of stacking.
      const replyId = `a-${Date.now()}`;
      let streamed = '';
      setStreamingId(replyId);
      setBubbles((prev) => [
        ...prev,
        { id: `u-${Date.now()}`, role: 'user', text: trimmed },
        { id: replyId, role: 'assistant', text: '' },
      ]);

      const patch = (fn: (b: Bubble) => Bubble) =>
        setBubbles((prev) => prev.map((b) => (b.id === replyId ? fn(b) : b)));

      const fail = (message: string) => {
        setActivity(null);
        patch((b) => ({ ...b, text: message, failed: true, retry: trimmed }));
      };

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, message: trimmed }),
        });

        // Rejections (400/404/429/503) still come back as plain JSON with a
        // real status code — only a turn that actually started is streamed.
        const isStream = res.ok && res.headers.get('content-type')?.includes('text/event-stream');
        if (!isStream) {
          const data = await res.json();
          if (res.status === 429) {
            setRateLimit(data.message ?? 'ส่งข้อความถี่เกินไป');
            setBubbles((prev) => prev.filter((b) => b.id !== replyId));
            return;
          }
          fail(`เกิดข้อผิดพลาด: ${data.message ?? data.error}`);
          return;
        }

        if (!res.body) {
          fail('เชื่อมต่อไม่ได้: เบราว์เซอร์ไม่รองรับการส่งข้อความแบบทยอย');
          return;
        }

        await readEventStream(res.body, (event) => {
          if (event.type === 'step') {
            // A new model step replaces the last one rather than adding to it.
            streamed = '';
            patch((b) => ({ ...b, text: '' }));
          } else if (event.type === 'tool') {
            setActivity(ACTIVITY[event.name] ?? 'กำลังทำงาน…');
          } else if (event.type === 'delta') {
            streamed += event.text;
            setActivity(null);
            patch((b) => ({ ...b, text: streamed }));
          } else if (event.type === 'done') {
            streamed = event.reply;
            setActivity(null);
            patch((b) => ({
              ...b,
              text: event.reply,
              failed: false,
              toolCalls: event.tool_calls,
              products: event.products ?? undefined,
              comparison: event.comparison ?? null,
              design: event.design ?? null,
            }));
            if (event.state) setState(event.state);
            if (typeof event.chat_turns_left === 'number') setChatTurnsLeft(event.chat_turns_left);
            if (event.design) setQuotaLeft(event.design.image_quota_left);
          } else {
            fail(`เกิดข้อผิดพลาด: ${event.message}`);
          }
        });
      } catch (err) {
        fail(`เชื่อมต่อไม่ได้: ${err instanceof Error ? err.message : 'unknown'}`);
      } finally {
        setSending(false);
        setStreamingId(null);
        setActivity(null);
      }
    },
    [sending, sessionId],
  );

  // --- generate --------------------------------------------------------
  // One request, one picture, and the answer comes back with the picture in
  // it. The route waits for the image model rather than handing back a job to
  // poll, so this is a single fetch that can take a while.
  //
  // The request the user wrote goes with it: the picture is made for that
  // sentence, not for the app's idea of what they meant.
  //
  // An iteration is the same call with a change attached. The change is the
  // user's own words, and the earlier changes of the same piece go with it:
  // "make it even smaller" needs the earlier "make it smaller" to be smaller
  // than.
  const generate = useCallback(
    async (
      bubbleId: string,
      product: { id: string; name_th: string },
      options?: { instruction?: string; previous?: string[]; placement?: string | null },
    ) => {
      if (!sessionId || generatingId) return;

      setGeneratingId(product.id);
      setGenerateError(null);
      try {
        const body: Record<string, unknown> = {
          session_id: sessionId,
          product_id: product.id,
        };
        if (options?.placement) body.placement = options.placement;
        if (options?.instruction) body.instruction = options.instruction;
        if (options?.previous && options.previous.length > 0) {
          body.previous_instructions = options.previous;
        }

        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();

        if (!res.ok) {
          setGenerateError({
            bubbleId,
            message: data.message ?? data.error ?? 'สร้างรูปไม่สำเร็จ',
          });
          return;
        }

        // The Supabase store hands back a signed URL; the local store has none,
        // so fall back to our own session-checked image route.
        const src = data.url ?? `/api/image/${data.image_id}?session_id=${encodeURIComponent(sessionId)}`;
        setBubbles((prev) =>
          prev.map((b) =>
            b.id === bubbleId
              ? {
                  ...b,
                  images: [
                    ...(b.images ?? []),
                    {
                      id: data.image_id,
                      url: src,
                      productId: product.id,
                      productName: product.name_th,
                      verdict: data.fit?.verdict ?? null,
                      version: data.version ?? 1,
                      instruction: options?.instruction ?? null,
                      placement: options?.placement ?? null,
                    },
                  ],
                }
              : b,
          ),
        );
        setQuotaLeft(data.image_quota_left);
        setState((prev) =>
          prev ? { ...prev, generated_image_ids: [...prev.generated_image_ids, data.image_id] } : prev,
        );
      } catch (err) {
        setGenerateError({
          bubbleId,
          message: `เชื่อมต่อไม่ได้: ${err instanceof Error ? err.message : 'unknown'}`,
        });
      } finally {
        setGeneratingId(null);
      }
    },
    [sessionId, generatingId],
  );

  // --- iterate ---------------------------------------------------------
  // Another version of a piece that is already in a picture. The chain of
  // earlier changes is rebuilt from the pictures themselves, oldest first.
  // The request the picture was made for goes with it, so the new version is
  // made for the same request.
  const iterate = useCallback(
    async (bubbleId: string, image: GeneratedImageView, instruction: string) => {
      const bubble = bubbles.find((b) => b.id === bubbleId);
      const previous = (bubble?.images ?? [])
        .filter((i) => i.productId === image.productId && i.version <= image.version)
        .sort((a, b) => a.version - b.version)
        .map((i) => i.instruction)
        .filter((text): text is string => typeof text === 'string' && text.length > 0);

      await generate(bubbleId, { id: image.productId, name_th: image.productName }, {
        instruction,
        previous,
        placement: image.placement,
      });
    },
    [bubbles, generate],
  );

  // --- new session ------------------------------------------------------
  /**
   * Deletes everything of this session and starts a fresh one.
   *
   * The deletion is the point: the photos go to storage and the rows to the
   * database, so this is a real erasure and not just a new conversation. A
   * failed deletion is reported in the session state and the old session stays
   * on screen — better a visible error than a silent half-deletion.
   */
  const startFreshSession = useCallback(async () => {
    setDeleting(true);
    setDeleteError(null);

    try {
      const current = window.localStorage.getItem(SESSION_KEY);
      if (current) {
        const res = await fetch(`/api/session?session_id=${encodeURIComponent(current)}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message ?? `HTTP ${res.status}`);
        }
      }
      window.localStorage.removeItem(SESSION_KEY);

      const data = await createSession();
      applySession(data, false);
      setBubbles([]);
      setGenerateError(null);
      setRateLimit(null);
      setInput('');
      // The old conversation is gone, so the address bar forgets it too.
      const url = new URL(window.location.href);
      url.searchParams.delete('session');
      window.history.replaceState(null, '', url);
      setHistoryVersion((v) => v + 1);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'ลบไม่สำเร็จ');
    } finally {
      setDeleting(false);
    }
  }, [applySession]);

  // --- open a conversation ------------------------------------------------
  /**
   * Opens one of the conversations in the list on the left.
   *
   * Everything the conversation was comes back with it: the messages, the
   * preferences, the measurement, what is left of the image budget. The
   * server keeps all of it, so the client only has to ask.
   */
  const openSession = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/session?session_id=${encodeURIComponent(id)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          body.error === 'session_forbidden'
            ? 'บทสนทนานี้เป็นของบัญชีอื่น'
            : 'ไม่พบบทสนทนานี้ — มันอาจถูกลบไปแล้ว',
        );
      }

      const data = (await res.json()) as SessionPayload;
      window.localStorage.setItem(SESSION_KEY, data.session_id);
      applySession(data, true);
      setGenerateError(null);
      setRateLimit(null);
      setInput('');
      // The address bar follows, so a reload opens the same conversation.
      const url = new URL(window.location.href);
      url.searchParams.set('session', data.session_id);
      window.history.replaceState(null, '', url);
      // On a narrow screen the list is a drawer over the conversation, so it
      // gets out of the way. On a wide one it is a column, and it stays.
      if (window.matchMedia('(max-width: 1023px)').matches) setRailOpen(false);
    },
    [applySession],
  );

  // --- a new conversation -------------------------------------------------
  /**
   * Starts a new conversation.
   *
   * Nothing is deleted: the old one stays in the list, the way it does in
   * every other chat. The button that erases things is the one in the
   * session state, and it says so.
   */
  const newChat = useCallback(async () => {
    const data = await createSession();
    applySession(data, false);
    setBubbles([]);
    setGenerateError(null);
    setRateLimit(null);
    setDeleteError(null);
    setInput('');
    // No conversation is asked for any more.
    const url = new URL(window.location.href);
    url.searchParams.delete('session');
    window.history.replaceState(null, '', url);
    if (window.matchMedia('(max-width: 1023px)').matches) setRailOpen(false);
    setHistoryVersion((v) => v + 1);
  }, [applySession]);

  // --- the rail -----------------------------------------------------------
  /**
   * Opens or closes the left rail.
   *
   * One rail, one button: the history and the tools share a column now, so
   * there is nothing else to switch between.
   */
  function toggleRail() {
    setRailOpen((open) => !open);
  }

  // --- layout helpers ---------------------------------------------------
  const scrollToBottom = () => {
    atBottom.current = true;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  };

  const tooLong = input.length > MAX_MESSAGE;

  if (bootError) {
    return (
      <main className="mx-auto max-w-lg px-6 py-24 text-center">
        <h1 className="font-display text-2xl font-bold">เริ่มใช้งานไม่ได้</h1>
        <p className="mt-3 text-ink-soft">{bootError}</p>
        <div className="mt-6 flex justify-center">
          <HomeButton tone="surface" label="กลับหน้าแรก" />
        </div>
      </main>
    );
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* ---- the left rail: the history on top, the tools below ---- */}
      {/* The backdrop is what closes the drawer on a narrow screen. */}
      {railOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={() => setRailOpen(false)}
          aria-hidden
        />
      )}

      {/* Always mounted: on a wide screen it is a column beside the chat, on a
          narrow one it slides in from the left. */}
      <SideRail
        currentId={sessionId}
        signedIn={account !== null}
        accountEmail={account?.email ?? null}
        version={historyVersion}
        onOpen={openSession}
        onNewChat={newChat}
        open={railOpen}
        mounted={mounted}
        onClose={() => setRailOpen(false)}
      >
        <div className="space-y-6 text-sm">
          {sessionId && (
            <RoomPhotoPicker
              sessionId={sessionId}
              onUploaded={async ({ quotaLeft }) => {
                setQuotaLeft(quotaLeft);
                // The analysis lives on the server. Pull it back so the
                // panel and the model read the same thing, rather than
                // trusting the copy that came up with the upload response.
                const res = await fetch(`/api/session?session_id=${encodeURIComponent(sessionId)}`);
                if (res.ok) setState(((await res.json()) as { state: SessionStateView }).state);
              }}
            />
          )}

          {/* Only once there is a photo to measure on. */}
          {sessionId && state?.room_image_id && (
            <AreaPicker
              sessionId={sessionId}
              roomImageId={state.room_image_id}
              measurement={state}
              onSaved={(next) => setState((prev) => (prev ? { ...prev, ...next } : prev))}
            />
          )}

          <section>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
              สไตล์
            </h3>
            {/* The example rooms, not only the names: the user sees what the
                style looks like before they ask for it. Two to a row, the
                way a gallery of styles shows them. */}
            <div className="grid grid-cols-2 gap-2">
              {STYLES.map((s) => {
                const active = state?.preferences.style === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => void send(s.prompt)}
                    disabled={sending || !sessionId}
                    aria-pressed={active}
                    title={`สไตล์${s.label}`}
                    className={`group overflow-hidden rounded-xl border text-left transition-colors disabled:opacity-50 ${
                      active
                        ? 'border-brand ring-2 ring-brand/25'
                        : 'border-line hover:border-brand/40'
                    }`}
                  >
                    <Image
                      src={s.image}
                      alt={`ห้องตัวอย่างสไตล์${s.label}`}
                      width={640}
                      height={480}
                      sizes="140px"
                      className="aspect-[4/3] w-full object-cover"
                    />
                    <span className="block px-2 py-1.5 text-[11px] font-medium text-ink-soft transition-colors group-hover:text-ink">
                      {s.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
              งบประมาณ
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {BUDGETS.map((b) => (
                <Chip
                  key={b.thb}
                  label={b.label}
                  active={state?.preferences.budget_thb === b.thb}
                  onClick={() => void send(b.prompt)}
                  disabled={sending || !sessionId}
                />
              ))}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
              หมวดหมู่
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {CATEGORIES.map((c) => (
                <Chip
                  key={c.id}
                  label={c.label}
                  active={state?.preferences.category === c.id}
                  onClick={() => void send(c.prompt)}
                  disabled={sending || !sessionId}
                />
              ))}
            </div>
          </section>

          <StatePanel
            sessionId={sessionId}
            state={state}
            quotaLeft={quotaLeft}
            chatTurnsLeft={chatTurnsLeft}
            onDeleteAll={() => void startFreshSession()}
            deleting={deleting}
            error={deleteError}
          />
        </div>
      </SideRail>

      {/* ---- chat column ---- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* The chat page has no band of its own. The rail carries the mark, the
            history, the tools and the account, so the conversation gets the
            whole column — and while the rail is closed, this slim strip keeps
            the button that opens it, in the place the mark sits when it is
            open. */}
        {!railOpen && (
          <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line-soft px-3">
            <button
              type="button"
              onClick={toggleRail}
              aria-expanded={railOpen}
              aria-label="เปิดแถบด้านซ้าย — ประวัติการสนทนาและเครื่องมือ"
              title="เปิดแถบด้านซ้าย"
              className="grid size-8 shrink-0 place-items-center rounded-full text-ink-soft transition-colors hover:bg-sunken hover:text-ink"
            >
              <PanelIcon />
            </button>

            <HomeButton tone="rail" iconSize={24} />
          </div>
        )}

        <div
          ref={scrollRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            atBottom.current = near;
            setAtBottomState(near);
          }}
          className="scroll-quiet flex-1 overflow-y-auto overscroll-contain px-4 py-6 sm:px-5"
        >
          <div className="mx-auto max-w-3xl space-y-6">
            {!sessionId && <p className="text-sm text-ink-faint">กำลังเชื่อมต่อ…</p>}

            {/* The empty state: what this is, and four ways to start. */}
            {sessionId && bubbles.length === 0 && (
              <section className="animate-rise pt-6 pb-2 text-center sm:pt-12">
                <Image
                  src="/roomyai-icon.png"
                  alt=""
                  width={44}
                  height={44}
                  className="mx-auto size-11"
                />
                <h2 className="mt-4 font-display text-3xl leading-snug font-semibold tracking-tight sm:text-4xl">
                  จัดห้องให้สวย
                  <br />
                  ด้วยของที่วางได้จริง
                </h2>
                <p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-ink-soft">
                  อัปโหลดรูปห้อง แล้วผมจะดูสไตล์กับสีให้ หาของที่เข้ากันพร้อมราคาและขนาดจริง
                  แล้ววางลงในรูปห้องของคุณให้เป็นภาพจำลอง
                </p>

                <div className="mx-auto mt-7 grid max-w-xl gap-2 sm:grid-cols-2">
                  {STARTERS.map((starter) => (
                    <button
                      key={starter.title}
                      type="button"
                      onClick={() => void send(starter.prompt)}
                      disabled={sending}
                      className="card group px-4 py-3 text-left transition-colors hover:border-brand/35 hover:bg-tint/60 disabled:opacity-50"
                    >
                      <span className="block text-sm font-medium">{starter.title}</span>
                      <span className="mt-0.5 block text-xs text-ink-faint">{starter.detail}</span>
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={() => setRailOpen(true)}
                  className="mt-5 text-xs text-brand underline underline-offset-4 hover:opacity-80"
                >
                  หรืออัปโหลดรูปห้องก่อน →
                </button>
              </section>
            )}

            {/* What the model currently knows about the room. Visible so the
                user can see the description they are arguing with. */}
            {state?.room_analysis && (
              <div className="rounded-2xl bg-tint/70 px-4 py-2.5 text-[11px] leading-relaxed text-ink-soft">
                <span className="font-medium text-ink">สิ่งที่ผมเห็นในรูปห้อง:</span> สไตล์{' '}
                {state.room_analysis.style} · สี {state.room_analysis.colors.join(', ')} ·{' '}
                {state.room_analysis.lighting}
              </div>
            )}

            {bubbles.map((b, index) => (
              <div key={b.id} className={`space-y-3 ${b.role === 'user' ? 'flex justify-end' : ''}`}>
                {/* An assistant bubble with nothing in it yet would be an empty
                    card; the status line below says what is happening. */}
                {!(b.role === 'assistant' && !b.text && !b.failed) && (
                  <div
                    className={
                      b.role === 'user'
                        ? // The user's own words: a bubble of their own colour, on the right.
                          'max-w-[85%] rounded-3xl bg-tint px-4 py-2.5 text-sm leading-relaxed text-ink sm:max-w-[80%]'
                        : b.failed
                          ? 'rounded-2xl border border-bad/25 bg-bad-soft px-4 py-3 text-sm leading-relaxed text-bad'
                          : // The answer sits straight on the white canvas, with
                            // no bubble around it — a document, not a chat balloon.
                            'text-[15px] leading-[1.75] text-ink'
                    }
                  >
                    {b.failed ? (
                      <div className="space-y-2">
                        <p>{b.text}</p>
                        {b.retry && (
                          <button
                            type="button"
                            onClick={() => void send(b.retry as string)}
                            className="rounded-full border border-bad/30 px-3 py-1 text-xs font-medium hover:bg-bad/10"
                          >
                            ลองอีกครั้ง
                          </button>
                        )}
                      </div>
                    ) : b.role === 'assistant' ? (
                      <Markdown
                        text={b.text}
                        products={(b.products ?? []).map((product) => ({
                          id: product.id,
                          name_th: product.name_th,
                          name_en: product.name_en,
                          image_url: product.image_url,
                          price_thb: product.price_thb,
                        }))}
                      />
                    ) : (
                      <span className="whitespace-pre-wrap">{b.text}</span>
                    )}

                    {/* What the model did, behind a disclosure — visible when
                        the user wants it, out of the way when they do not. */}
                    {b.toolCalls && b.toolCalls.length > 0 && !b.failed && (
                      <details className="mt-2.5 text-[11px] text-ink-faint">
                        <summary className="inline-flex cursor-pointer select-none items-center gap-1.5 rounded-full bg-sunken px-2.5 py-1 hover:bg-tint">
                          <span aria-hidden className="font-medium text-ink-soft">✦</span>
                          ดูขั้นตอนที่ผมทำ ({b.toolCalls.length})
                        </summary>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {b.toolCalls.map((t, i) => (
                            <span key={i} className="rounded-full bg-sunken px-2.5 py-0.5 font-mono">
                              {t.name}
                            </span>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                )}

                {/* The products of the search, and the pictures made from
                    them. Outside the bubble so a picture can be as wide as
                    the column. The request that asked for them is the
                    sentence the user typed just before — the pictures are
                    made for that sentence and not without one. */}
                {b.role === 'assistant' && ((b.products?.length ?? 0) > 0 || b.comparison) && (
                  <ProductCards
                    products={b.products ?? []}
                    images={b.images ?? []}
                    comparison={b.comparison ?? null}
                    placement={requestBefore(bubbles, index)}
                    onGenerate={(product) =>
                      void generate(b.id, product, { placement: requestBefore(bubbles, index) })
                    }
                    onIterate={(image, instruction) => void iterate(b.id, image, instruction)}
                    generatingId={generatingId}
                    quotaLeft={quotaLeft}
                    error={generateError?.bubbleId === b.id ? generateError.message : null}
                    disabled={!sessionId}
                  />
                )}

                {/* The room the model designed: the picture, the pieces it is
                    made of, and the box that asks for another version of it. */}
                {b.role === 'assistant' && b.design && (
                  <DesignCard
                    design={b.design}
                    sessionId={sessionId}
                    busy={sending}
                    outOfQuota={quotaLeft === 0}
                    onRefine={(instruction) => void send(`ปรับแต่งห้องนี้: ${instruction}`)}
                  />
                )}
              </div>
            ))}

            {/* What is happening right now. */}
            {sending && (
              <p className="flex items-center gap-2 text-xs text-ink-faint">
                <span aria-hidden className="animate-blink text-brand">
                  ●
                </span>
                {activity ?? (bubbles.some((b) => b.id === streamingId && b.text) ? 'กำลังเขียนคำตอบ…' : 'กำลังคิด…')}
              </p>
            )}
          </div>

          {/* The button appears only when the user has scrolled up to read
              something, and takes them back to the newest message. */}
          {!atBottomState && (
            <div className="sticky bottom-4 mx-auto flex max-w-3xl justify-center">
              <button
                type="button"
                onClick={scrollToBottom}
                className="btn-quiet bg-raised px-3.5 py-1.5 text-xs shadow-md"
              >
                ↓ ข้อความล่าสุด
              </button>
            </div>
          )}
        </div>

        {rateLimit && (
          <div className="mx-4 mb-2 flex items-center justify-between gap-4 rounded-lg border border-warn/30 bg-warn-soft px-4 py-2.5 text-sm text-warn sm:mx-5">
            <span>{rateLimit}</span>
            <button
              type="button"
              onClick={() => void startFreshSession()}
              className="shrink-0 rounded-md bg-warn px-3 py-1 text-xs text-white"
            >
              เริ่มเซสชันใหม่
            </button>
          </div>
        )}

        {/* The composer, on a tinted band so the eye lands on it first. */}
        <div className="shrink-0 border-t border-line-soft bg-tint/70 px-4 pt-3 pb-4 sm:px-5">
          <div className="mx-auto max-w-3xl">
            {/* inline chips, above the composer */}
            <div className="mb-2.5 flex flex-wrap gap-1.5">
              {QUICK_CHIPS.map((chip) => (
                <Chip
                  key={chip.label}
                  label={chip.label}
                  onClick={() => void send(chip.prompt)}
                  disabled={sending || !sessionId}
                />
              ))}
            </div>

            <form
              className="composer flex items-end gap-1.5 px-2 py-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                void send(input);
              }}
            >
              <div className="min-w-0 flex-1">
                <textarea
                  ref={composerRef}
                  value={input}
                  rows={1}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter sends; Shift+Enter makes a new line.
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void send(input);
                    }
                  }}
                  placeholder="พิมพ์ข้อความ… (Enter เพื่อส่ง, Shift+Enter ขึ้นบรรทัดใหม่)"
                  disabled={!sessionId || sending}
                  className="w-full resize-none bg-transparent px-2.5 py-2 text-[15px] leading-relaxed outline-none placeholder:text-ink-faint disabled:opacity-50"
                />
                {tooLong && (
                  <p className="mt-0.5 px-2.5 text-[11px] text-warn">
                    ข้อความยาว {input.length} ตัวอักษร — สูงสุด {MAX_MESSAGE} ตัวอักษร
                  </p>
                )}
              </div>
              <button
                type="submit"
                aria-label="ส่งข้อความ"
                disabled={!sessionId || sending || !input.trim() || tooLong}
                className="btn-primary mb-0.5 grid size-9 shrink-0 place-items-center rounded-full disabled:cursor-not-allowed"
              >
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden
                  className="size-4.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 19V5" />
                  <path d="m5 12 7-7 7 7" />
                </svg>
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

function Chip({
  label,
  onClick,
  active = false,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full border px-3 py-1.5 text-xs transition-colors disabled:opacity-40 ${
        active
          ? 'border-brand-fill bg-brand-fill text-brand-ink'
          : 'border-line text-ink-soft hover:border-brand/40 hover:bg-brand-soft hover:text-brand'
      }`}
    >
      {label}
    </button>
  );
}
