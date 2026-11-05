/**
 * Reading a chat turn, and reading what the turn left behind.
 *
 * The chat route answers with Server-Sent Events: `step` frames mark the
 * start of a model step, `delta` frames carry text, and a `done` frame carries
 * the whole result. The browser assembles those into a bubble; this module
 * does the same thing for the results script, so the script exercises the
 * real route rather than a copy of it.
 *
 * The second half of the file reads the *persisted* transcript. The `done`
 * frame tells us what the model said, but not what the fit tool concluded —
 * and the fit tool's verdict is the fact the whole system exists to get
 * right. The transcript is where that verdict is, so it is read from there.
 */

import type { Json, Message, Preferences } from '../db/types';
import type { DesignView } from '../design/view';
import type { ComparisonView, SearchProduct } from '../llm/tools';

// ---------------------------------------------------------------------------
// The event stream
// ---------------------------------------------------------------------------

export type ChatFrameType = 'step' | 'delta' | 'done' | 'error';

export interface ChatFrame {
  type: ChatFrameType;
  [key: string]: unknown;
}

/**
 * Parses a whole SSE body into frames.
 *
 * Only the `data:` lines carry the payload; anything else (comments, a blank
 * line, the `[DONE]` sentinel some servers send) is skipped. A frame that is
 * not valid JSON is dropped rather than thrown on — a broken frame should not
 * lose the ones around it.
 */
export function parseSse(text: string): ChatFrame[] {
  const frames: ChatFrame[] = [];

  for (const chunk of text.split(/\r?\n\r?\n/)) {
    const data = chunk
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .join('\n');

    if (!data || data === '[DONE]') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;

    const type = (parsed as { type?: unknown }).type;
    if (type !== 'step' && type !== 'delta' && type !== 'done' && type !== 'error') continue;

    frames.push(parsed as ChatFrame);
  }

  return frames;
}

export interface SseRead {
  frames: ChatFrame[];
  /** Milliseconds until the first frame arrived, or null if none did. */
  first_frame_ms: number | null;
  /**
   * Milliseconds until the first *text* frame arrived.
   *
   * Not the same as the first frame: a turn that opens with a tool call
   * sends a `step` frame straight away and says nothing until the tool has
   * come back, so the first frame is not when the answer started.
   */
  first_delta_ms: number | null;
  /** Milliseconds until the stream ended. */
  total_ms: number;
}

/**
 * Reads the event stream, timing as it goes.
 *
 * The stream is read chunk by chunk rather than in one go, so the time of the
 * first token is measured instead of guessed. The clock starts at `startedAt`
 * — the moment the request was sent, not the moment the reading began, or the
 * answer would look instant every time.
 */
export async function readSse(
  response: Response,
  startedAt: number,
  now: () => number = Date.now,
): Promise<SseRead> {
  const started = startedAt;
  const frames: ChatFrame[] = [];
  let firstFrameMs: number | null = null;
  let firstDeltaMs: number | null = null;
  let buffer = '';

  const body = response.body;
  if (!body) {
    return { frames, first_frame_ms: null, first_delta_ms: null, total_ms: now() - started };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();

  const take = (parsed: ChatFrame[]): void => {
    if (parsed.length === 0) return;
    if (firstFrameMs === null) firstFrameMs = now() - started;
    if (firstDeltaMs === null && parsed.some((frame) => frame.type === 'delta')) {
      firstDeltaMs = now() - started;
    }
    frames.push(...parsed);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let split = buffer.indexOf('\n\n');
      while (split !== -1) {
        const chunk = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        take(parseSse(chunk));
        split = buffer.indexOf('\n\n');
      }
    }

    take(parseSse(buffer));
  } finally {
    reader.releaseLock();
  }

  return { frames, first_frame_ms: firstFrameMs, first_delta_ms: firstDeltaMs, total_ms: now() - started };
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

export interface TokenUsage {
  in: number;
  out: number;
  think: number;
}

export interface ChatTurn {
  /** False when the turn ended with an `error` frame or no `done` frame. */
  ok: boolean;
  error: string | null;
  reply: string;
  tool_calls: { name: string; args: Json }[];
  iterations: number;
  hit_iteration_cap: boolean;
  /**
   * True when the model came back with nothing to say.
   *
   * The reply is then a short apology rather than an answer, so a check that
   * only looked at the text would pass a turn that never happened.
   */
  truncated: boolean;
  products: SearchProduct[] | null;
  comparison: ComparisonView | null;
  /** The room the turn designed, when it designed one. */
  design: DesignView | null;
  preferences: Preferences;
  chat_turns_left: number | null;
  usage: TokenUsage | null;
  /** Milliseconds until the first `delta` frame. */
  first_token_ms: number | null;
  /** Milliseconds for the whole turn. */
  latency_ms: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readUsage(frame: ChatFrame): TokenUsage | null {
  const usage = asRecord(frame.usage);
  if (!usage) return null;
  return {
    in: asNumber(usage.in) ?? 0,
    out: asNumber(usage.out) ?? 0,
    think: asNumber(usage.think) ?? 0,
  };
}

function readToolCalls(frame: ChatFrame): { name: string; args: Json }[] {
  if (!Array.isArray(frame.tool_calls)) return [];
  const calls: { name: string; args: Json }[] = [];
  for (const call of frame.tool_calls) {
    const record = asRecord(call);
    if (!record) continue;
    const name = typeof record.name === 'string' ? record.name : '(unnamed)';
    const args = record.args;
    calls.push({
      name,
      args:
        typeof args === 'object' && args !== null && !Array.isArray(args)
          ? (args as Json)
          : (args === undefined ? {} : (args as Json)),
    });
  }
  return calls;
}

function readPreferences(frame: ChatFrame): Preferences {
  const state = asRecord(frame.state);
  const preferences = asRecord(state?.preferences);
  return {
    style: typeof preferences?.style === 'string' ? preferences.style : null,
    budget_thb: asNumber(preferences?.budget_thb),
    category: typeof preferences?.category === 'string' ? preferences.category : null,
  };
}

/**
 * Turns the frames of one turn into the turn itself.
 *
 * The `done` frame is authoritative — it is what the client acts on. The
 * `delta` frames are only used to measure the time to the first token, and the
 * `error` frame wins over everything: a turn that failed has no answer, and
 * reporting the partial text as if it were the answer would be a lie.
 */
export function readTurn(frames: readonly ChatFrame[], firstTokenMs: number | null, latencyMs: number): ChatTurn {
  const done = frames.find((frame) => frame.type === 'done');
  const error = frames.find((frame) => frame.type === 'error');

  if (!done || error) {
    const message =
      error && typeof error.message === 'string'
        ? error.message
        : 'the turn ended without a done frame';
    return {
      ok: false,
      error: message,
      reply: '',
      tool_calls: [],
      iterations: 0,
      hit_iteration_cap: false,
      truncated: false,
      products: null,
      comparison: null,
      design: null,
      preferences: { style: null, budget_thb: null, category: null },
      chat_turns_left: null,
      usage: null,
      first_token_ms: firstTokenMs,
      latency_ms: latencyMs,
    };
  }

  return {
    ok: true,
    error: null,
    reply: typeof done.reply === 'string' ? done.reply : '',
    tool_calls: readToolCalls(done),
    iterations: asNumber(done.iterations) ?? 0,
    hit_iteration_cap: done.hit_iteration_cap === true,
    truncated: done.truncated === true,
    products: Array.isArray(done.products) ? (done.products as SearchProduct[]) : null,
    comparison: asRecord(done.comparison) ? (done.comparison as unknown as ComparisonView) : null,
    design: asRecord(done.design) ? (done.design as unknown as DesignView) : null,
    preferences: readPreferences(done),
    chat_turns_left: asNumber(done.chat_turns_left),
    usage: readUsage(done),
    first_token_ms: firstTokenMs,
    latency_ms: latencyMs,
  };
}

/** Sends one message to the chat route and reads the turn back. */
export type ChatTransport = (message: string) => Promise<Response>;

export async function runChatTurn(send: ChatTransport, message: string): Promise<ChatTurn> {
  const startedAt = Date.now();
  const response = await send(message);

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      detail = body.message ?? body.error ?? detail;
    } catch {
      // A body that is not JSON is not worth more than the status line.
    }
    return {
      ok: false,
      error: detail,
      reply: '',
      tool_calls: [],
      iterations: 0,
      hit_iteration_cap: false,
      truncated: false,
      products: null,
      comparison: null,
      design: null,
      preferences: { style: null, budget_thb: null, category: null },
      chat_turns_left: null,
      usage: null,
      first_token_ms: null,
      latency_ms: Date.now() - startedAt,
    };
  }

  const read = await readSse(response, startedAt);

  // The first *text* frame is what a person would call "the answer starting".
  // A turn that opens with a tool call says nothing until the tool is back,
  // so the first frame of any kind would be the wrong number to report.
  return readTurn(read.frames, read.first_delta_ms, read.total_ms);
}

// ---------------------------------------------------------------------------
// What the turn left in the database
// ---------------------------------------------------------------------------

export interface FitToolResult {
  product_id: string;
  product_name: string;
  verdict: 'fits' | 'tight' | 'does_not_fit';
  reasons: string[];
  space: { width_cm: number; depth_cm: number; height_cm: number | null } | null;
  price_thb: number;
  /** The room left on each axis, in centimetres. */
  clearances: { width: number; depth: number; height: number | null };
}

/**
 * The clearances one fit result carries, one per axis it checked.
 *
 * The height is skipped when the ceiling was never measured, so the list is
 * shorter than three — and a number that is not in it is a number the rule
 * did not produce.
 */
function axisClearances(fit: Record<string, unknown> | null): number[] {
  if (!fit) return [];

  const values: number[] = [];
  for (const name of ['width', 'depth', 'height']) {
    const axis = asRecord(fit[name]);
    const value = asNumber(axis?.clearance_cm);
    if (value !== null) values.push(value);
  }

  return values;
}

/**
 * Every clearance number the tools have produced in these messages.
 *
 * Both tools that judge a fit are read: `checkFit` for one product, and
 * `compareOptions` for the products it compared. A number the bot repeats
 * from either one is a number the rule produced, and the results script has
 * to know that it is allowed to say it.
 */
export function extractClearances(messages: readonly Message[]): number[] {
  const values: number[] = [];

  for (const message of messages) {
    const content = asRecord(message.content);
    const parts = content?.parts;
    if (!Array.isArray(parts)) continue;

    for (const part of parts) {
      const record = asRecord(part);
      if (!record || record.kind !== 'toolResult') continue;
      const result = asRecord(record.result);
      if (!result) continue;

      if (record.name === 'checkFit') {
        values.push(...axisClearances(asRecord(result.fit)));
      } else if (record.name === 'compareOptions') {
        const products = result.products;
        if (!Array.isArray(products)) continue;
        for (const product of products) {
          const row = asRecord(product);
          values.push(...axisClearances(asRecord(row?.fit)));
        }
      }
    }
  }

  return values;
}

/**
 * The `checkFit` results of a session, newest last.
 *
 * Read out of the stored transcript rather than out of the stream: the `done`
 * frame does not carry the tool's own answer, and the tool's answer is the
 * one that has to be right.
 *
 * The transcript is jsonb, so it is treated as untrusted — a row written by an
 * older version, or edited by hand, must not take the script down.
 */
export function extractFitResults(messages: readonly Message[]): FitToolResult[] {
  const results: FitToolResult[] = [];

  for (const message of messages) {
    const content = asRecord(message.content);
    const parts = content?.parts;
    if (!Array.isArray(parts)) continue;

    for (const part of parts) {
      const record = asRecord(part);
      if (!record || record.kind !== 'toolResult' || record.name !== 'checkFit') continue;

      const result = asRecord(record.result);
      if (!result) continue;

      const product = asRecord(result.product);
      const fit = asRecord(result.fit);
      const verdict = fit?.verdict;
      if (typeof verdict !== 'string') continue;
      if (verdict !== 'fits' && verdict !== 'tight' && verdict !== 'does_not_fit') continue;

      const space = asRecord(result.space);
      const reasons = Array.isArray(fit?.reasons)
        ? fit.reasons.filter((reason): reason is string => typeof reason === 'string')
        : [];

      const width = asRecord(fit?.width);
      const depth = asRecord(fit?.depth);
      const height = asRecord(fit?.height);

      results.push({
        product_id: typeof product?.id === 'string' ? product.id : '',
        product_name: typeof product?.name_th === 'string' ? product.name_th : '',
        verdict,
        reasons,
        space: space
          ? {
              width_cm: asNumber(space.width_cm) ?? 0,
              depth_cm: asNumber(space.depth_cm) ?? 0,
              height_cm: asNumber(space.height_cm),
            }
          : null,
        price_thb: asNumber(result.price_thb) ?? 0,
        clearances: {
          width: asNumber(width?.clearance_cm) ?? 0,
          depth: asNumber(depth?.clearance_cm) ?? 0,
          height: height ? asNumber(height.clearance_cm) ?? 0 : null,
        },
      });
    }
  }

  return results;
}
