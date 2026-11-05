/**
 * One chat turn.
 *
 *   POST /api/chat   { session_id, message }
 *
 * Flow:
 *   1. Rate limit by session id AND by client IP (spec: 20 turns/hour each).
 *   2. Load the session, rebuild the LLM history from stored messages.
 *   3. Run the provider-neutral tool loop (max 6 iterations).
 *   4. Persist the user turn, the tool round-trip, and the assistant reply.
 *   5. Fold any preferences the model expressed back into session state, so the
 *      database stays the single source of truth rather than the model's memory.
 */

import { z } from 'zod';

import { getDb } from '@/lib/db';
import type { Json, MessageRole, SessionState } from '@/lib/db/types';
import { extractDesign } from '@/lib/design/tool';
import type { DesignView } from '@/lib/design/view';
import { MissingEnvError, settings } from '@/lib/env';
import { buildSystemInstruction } from '@/lib/llm/prompt';
import { runToolLoop } from '@/lib/llm/loop';
import { mayActOnSession } from '@/lib/session/ownership';
import {
  TOOL_SPECS,
  executeToolCall,
  extractSearchProducts,
  extractComparison,
  type SearchProduct,
} from '@/lib/llm/tools';
import { getLlm } from '@/lib/llm';
import { clientIp, consume as consumeRateLimit, HOUR_MS, ipKey, peek, sessionKey } from '@/lib/rate-limit';
import { isLlmMessage, dropUnsignedToolCalls, trimHistory, type LlmMessage } from '@/lib/llm/history';

export const dynamic = 'force-dynamic';
/**
 * A turn that designs a room waits for the picture.
 *
 * The drawing is the slow part — tens of seconds — so the platform needs to
 * know this route is not a quick one. The same limit as the placement route,
 * which also waits for an image.
 */
export const maxDuration = 120;

const ChatBody = z.object({
  session_id: z.string().min(1),
  message: z.string().min(1).max(4000),
});

export async function POST(request: Request): Promise<Response> {
  // --- parse -------------------------------------------------------------
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = ChatBody.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_body', issues: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }
  const { session_id: sessionId, message } = parsed.data;

  // --- rate limit --------------------------------------------------------
  const limit = settings.chatTurnsPerHour();
  const ip = clientIp(request);

  for (const [scope, key] of [
    ['session', sessionKey(sessionId)],
    ['ip', ipKey(ip)],
  ] as const) {
    const result = consumeRateLimit({ key: `${scope}:${key}`, limit, windowMs: HOUR_MS });
    if (!result.ok) {
      return Response.json(
        {
          error: 'rate_limited',
          scope,
          limit,
          retry_after_seconds: Math.ceil(result.retryAfterMs / 1000),
          message:
            scope === 'session'
              ? `คุณส่งข้อความครบ ${limit} ครั้งใน 1 ชั่วโมงแล้ว เริ่มเซสชันใหม่เพื่อคุยต่อได้เลย`
              : `เครื่องนี้ถูกจำกัดที่ ${limit} ครั้ง/ชั่วโมง กรุณารอสักครู่`,
        },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(result.retryAfterMs / 1000)) } },
      );
    }
  }

  // --- session -----------------------------------------------------------
  try {
    const db = getDb();
    const session = await db.getSession(sessionId);
    if (!session) return Response.json({ error: 'session_not_found' }, { status: 404 });

    // A session with an owner is that account's: only the account may talk in
    // it. A session without one is a guest's, and its id is the only key —
    // the way it has always been.
    if (!(await mayActOnSession(session, request))) {
      return Response.json({ error: 'session_forbidden' }, { status: 403 });
    }

    // --- history ---------------------------------------------------------
    // Narrow row-by-row: `messages.content` is plain jsonb, so a single bad
    // row must not poison the rest of the conversation.
    const stored = await db.listMessages(sessionId);
    const history: LlmMessage[] = [];
    for (const row of stored) {
      if (isLlmMessage(row.content)) history.push(row.content);
    }

    // Turns stored before the adapter started echoing Gemini's thought
    // signature cannot be replayed — the API rejects them outright. Only Gemini
    // needs this, so it is gated on the live provider rather than applied to
    // every history unconditionally.
    //
    // Trimming comes second: it has to reason about what survives the drop, and
    // it keeps the request from growing without bound as the chat goes on.
    //
    // `?history=N` overrides the cap, but only outside production — editing
    // .env.local forces a dev-server restart, which makes sweeping values
    // tedious, and this knob has no business being reachable from the internet.
    const historyOverride = readHistoryOverride(request);
    const replayable = trimHistory(
      getLlm().id === 'gemini' ? dropUnsignedToolCalls(history) : history,
      historyOverride ?? settings.maxHistoryMessages(),
    );

    const userTurn: LlmMessage = { role: 'user', parts: [{ kind: 'text', text: message }] };
    const workingHistory: LlmMessage[] = [...replayable, userTurn];

    // --- run -------------------------------------------------------------
    const systemInstruction = buildSystemInstruction(session.state);

    // Everything that can be answered with a status code has been answered by
    // now, so from here on failures can only be reported inside the stream.
    const encoder = new TextEncoder();
    let closed = false;
    const startedAt = Date.now();
    let firstTokenMs: number | null = null;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (payload: unknown) => {
          if (closed) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        };

        try {
          const loop = await runToolLoop({
            provider: getLlm(),
            history: workingHistory,
            systemInstruction,
            tools: TOOL_SPECS,
            executeTool: executeToolCall,
            // Tools that need to know which session a turn belongs to (looking a
            // room photo up, for one) get it from here rather than reaching for a
            // global.
            toolContext: { db, session },
            // The model opens with a preamble before calling a tool and then
            // writes the real answer. The step event tells the UI to discard the
            // preamble, so the bubble ends up holding exactly the text we
            // persist rather than both.
            onStep: () => send({ type: 'step' }),
            // The name of the tool, so the interface can say what is being done
            // instead of only that something is.
            onTool: (call) => send({ type: 'tool', name: call.name }),
            onDelta: (delta) => {
              firstTokenMs ??= Date.now() - startedAt;
              send({ type: 'delta', text: delta });
            },
          });

          // --- persist ---------------------------------------------------
          // `messages.role` is 'user' | 'assistant' | 'tool'; our LlmMessage role
          // is 'user' | 'model'. The mapping lives here so no other layer has to
          // know.
          //
          // The user's turn is inside `workingHistory`, so it falls *before* the
          // slice below and has to be written explicitly — otherwise every
          // question is dropped and the next turn rebuilds a history with the
          // user's own messages missing.
          await db.addMessage(sessionId, { role: 'user', content: userTurn as unknown as Json });

          const newMessages: LlmMessage[] = loop.history.slice(workingHistory.length);
          for (const m of newMessages) {
            const role: MessageRole = m.role === 'model' ? 'assistant' : 'user';
            await db.addMessage(sessionId, { role, content: m as unknown as Json });
          }

          // The products of the last search, so the client can show a card per
          // product and the user can ask for a picture of one.
          //
          // Read out of *this turn's* messages, not the whole history: a turn
          // that searched nothing has nothing to show, and re-offering the
          // last search's cards under every new bubble would fill the
          // conversation with the same pictures.
          const products = extractSearchProducts(newMessages);

          // The comparison of the last compareOptions call, so the client can
          // show the numbers in a table next to the answer. Same rule: the
          // table belongs to the turn that asked for it.
          const comparison = extractComparison(newMessages);

          // The room the model designed, if it designed one this turn. The
          // picture and the list of pieces belong to the turn that drew them.
          const design = extractDesign(newMessages);

          const nextState = foldState(session.state, loop.toolCalls, design, products);
          await db.updateSessionState(sessionId, nextState);

          // Counts and timings only — never message text, per the spec's rule
          // about not logging chat contents.
          const tokens = loop.usage.reduce(
            (acc, u) => ({
              in: acc.in + (u.promptTokens ?? 0),
              out: acc.out + (u.outputTokens ?? 0),
              think: acc.think + (u.thoughtTokens ?? 0),
            }),
            { in: 0, out: 0, think: 0 },
          );
          console.log(
            `[api/chat] hist=${replayable.length} steps=${loop.iterations} ` +
              `first_token=${firstTokenMs ?? '-'}ms total=${Date.now() - startedAt}ms ` +
              `step_ms=[${loop.stepDurationsMs.join(',')}] ` +
              `tokens_in=${tokens.in} tokens_out=${tokens.out} tokens_thought=${tokens.think}`,
          );

          send({
            type: 'done',
            reply: loop.text,
            tool_calls: loop.toolCalls.map((c) => ({ name: c.name, args: c.args })),
            iterations: loop.iterations,
            hit_iteration_cap: loop.hitIterationCap,
            // True when the model could not finish — the answer was cut off or
            // blocked. The reply is a short apology, but a caller that reports
            // on the run has to know this was not an answer.
            truncated: loop.truncated,
            state: nextState,
            products: products.length > 0 ? products : null,
            comparison,
            // The room that was designed, with its picture and its pieces.
            design: design ? design.view : null,
            // Token counts, so a caller can report the cost of the turn.
            // Numbers only — the text they were counted from is never sent.
            usage: tokens,
            // How many turns are left in this session's hour, so the interface
            // can show the budget before it runs out.
            chat_turns_left: peek({
              key: sessionKey(sessionId),
              limit: settings.chatTurnsPerHour(),
              windowMs: HOUR_MS,
            }).remaining,
          });
        } catch (err) {
          console.error('[api/chat] turn failed:', err instanceof Error ? err.stack : err);
          send({
            type: 'error',
            error: err instanceof MissingEnvError ? 'server_not_configured' : 'chat_failed',
            message: err instanceof Error ? err.message : 'unexpected error',
          });
        } finally {
          closed = true;
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        // Stops a proxy from buffering the whole response and undoing the point.
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    if (err instanceof MissingEnvError) {
      return Response.json({ error: 'server_not_configured', key: err.key }, { status: 503 });
    }
    // Log server-side only. The message is returned to the client, but never
    // the stack — and per the spec we must not log image contents or the
    // user's chat text here.
    console.error('[api/chat] turn failed:', err instanceof Error ? err.stack : err);
    const message = err instanceof Error ? err.message : 'unexpected error';
    return Response.json({ error: 'chat_failed', message }, { status: 500 });
  }
}

/**
 * Dev-only history cap override, e.g. `POST /api/chat?history=4`.
 *
 * Returns undefined outside development, when it is set to a non-integer, or
 * when the value is negative — in every case the configured default wins.
 */
function readHistoryOverride(request: Request): number | undefined {
  if (process.env.NODE_ENV === 'production') return undefined;
  const raw = new URL(request.url).searchParams.get('history');
  if (raw === null) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

// ---------------------------------------------------------------------------
// Session-state folding
//
// Whatever the model asks `searchFurniture` for becomes the session's stored
// preferences, so the next turn sees the same facts the database does.
// ---------------------------------------------------------------------------

function foldState(
  state: SessionState,
  toolCalls: ReadonlyArray<{ name: string; args: Json }>,
  design: { view: DesignView; brief: SessionState['design_brief'] } | null,
  products: readonly SearchProduct[],
): SessionState {
  const preferences = { ...state.preferences };

  for (const call of toolCalls) {
    if (call.name !== 'searchFurniture') continue;
    if (typeof call.args !== 'object' || call.args === null || Array.isArray(call.args)) continue;
    const args = call.args as Record<string, Json>;

    if (typeof args.style === 'string' && args.style) preferences.style = args.style;
    if (typeof args.category === 'string' && args.category) preferences.category = args.category;
    if (typeof args.max_price_thb === 'number') preferences.budget_thb = args.max_price_thb;
  }

  const next: SessionState = { ...state, preferences };

  // `shown_products` is what the model may refer back to — "ตัวที่แรนด์สอง" —
  // without searching again. This turn's results are appended to what earlier
  // turns showed, and the list is capped so it cannot grow without bound.
  if (products.length > 0) {
    const merged = [...state.shown_products, ...products.map((product) => product.id)];
    next.shown_products = [...new Set(merged)].slice(-12);
  }

  // The room the user asked for. The next turn refines it rather than starting
  // over, so "เปลี่ยนเป็นสีฟ้า" means something.
  if (design?.brief) {
    next.design_brief = design.brief;
  }

  return next;
}