/**
 * The provider-neutral tool-use loop.
 *
 * The spec caps this at 6 iterations. After the cap we stop and return whatever
 * text the model last produced, so the user still gets an answer instead of a
 * spinner that never resolves.
 *
 * Tool failures are returned to the model as data, never thrown: the model can
 * then correct its arguments. That is the spec's "Zod validation returns error
 * objects to the LLM" rule, applied to every tool.
 */

import type { DbClient, Json, Session } from '@/lib/db/types';
import {
  modelText,
  userText,
  type LlmDeltaHandler,
  type LlmFinishReason,
  type LlmMessage,
  type LlmProvider,
  type LlmStepInput,
  type LlmStepResult,
  type LlmUsage,
  type ToolCall,
  type ToolSpec,
} from './types';

export const MAX_TOOL_ITERATIONS = 6;

/**
 * One step, streaming when the provider can and the caller is listening.
 *
 * Keeping the choice here is what lets the loop stay provider-neutral: the
 * route only ever sees deltas, and never learns whether the adapter behind them
 * has a streaming API at all.
 */
async function step(
  provider: LlmProvider,
  input: LlmStepInput,
  onDelta: LlmDeltaHandler | undefined,
): Promise<LlmStepResult> {
  if (onDelta && provider.runStepStream) return provider.runStepStream(input, onDelta);
  return provider.runStep(input);
}

/**
 * What a tool is told about the turn it was called from.
 *
 * Optional on purpose: a tool that needs the session (looking a photo up,
 * reading the quota) says so, and the loop passes this when the caller knows
 * it. Keeping it out of the signature means the majority of tools stay
 * `(args) => Json`.
 */
export interface ToolContext {
  db: DbClient;
  session: Session;
  /**
   * The conversation so far, tool results included.
   *
   * A tool that needs to know what has already been established — the space a
   * `checkFit` judged against, say — reads it from here rather than from a
   * global. It is the working history, so a tool sees the calls made earlier
   * in this turn as well as the earlier turns.
   */
  history?: readonly LlmMessage[];
}

export type ToolExecutor = (args: Json, context?: ToolContext) => Promise<Json>;

export interface ToolLoopInput {
  provider: LlmProvider;
  history: readonly LlmMessage[];
  systemInstruction: string;
  tools: readonly ToolSpec[];
  executeTool: (call: ToolCall, context?: ToolContext) => Promise<Json>;
  /** Forwarded to every tool call. Omit when no tool needs the session. */
  toolContext?: ToolContext;
  maxIterations?: number;
  /**
   * Called with text as the model produces it. Purely for display — the loop's
   * own behaviour is identical whether or not it is set, and a provider that
   * cannot stream just means the user sees the answer all at once.
   */
  onDelta?: LlmDeltaHandler;
  /**
   * Called at the start of each model step. The model opens with a preamble,
   * calls a tool, then writes the real answer — so a UI showing deltas needs to
   * know that the second step replaces the first rather than extending it.
   */
  onStep?: () => void;
  /**
   * Called with each tool call, just before it runs.
   *
   * A step alone says "the model is thinking". This says what it is thinking
   * about — searching the catalogue, measuring the space, reading the room
   * photo — so the interface can say so instead of showing a bare spinner.
   */
  onTool?: (call: ToolCall) => void;
}

export interface ToolLoopResult {
  text: string;
  /** Every call the model made, in order. Useful for the transcript. */
  toolCalls: ToolCall[];
  iterations: number;
  hitIterationCap: boolean;
  /**
   * True when the model came back with nothing to say.
   *
   * Either the answer was cut off — the token budget ran out while it was
   * thinking — or it was blocked. The turn still has to say *something*, so
   * `text` holds a short apology, but the caller is told the truth through
   * this flag: a step-8 run that reports "the bot answered" would be lying.
   */
  truncated: boolean;
  /** The history to persist, including the tool round-trips. */
  history: LlmMessage[];
  /** Wall-clock cost of each model step, oldest first. */
  stepDurationsMs: number[];
  /** Token cost of each model step, oldest first. */
  usage: LlmUsage[];
}

/** A step that failed still has to appear in the timings, or the totals lie. */
const NO_USAGE: LlmUsage = {};

/**
 * What the loop says when the model said nothing.
 *
 * An empty bubble reads as a broken app, and the user has no way to tell that
 * apart from the app having forgotten them. A short, honest line is better
 * than silence — and the `truncated` flag is what tells the rest of the
 * system that this was not an answer.
 */
function fallbackText(reason: LlmFinishReason): string {
  if (reason === 'safety') return 'ขออภัยครับ คำถามนี้อยู่นอกขอบเขตที่ผมช่วยได้';
  return 'ขออภัยครับ ตอบไม่ทัน ลองถามอีกครั้งนะครับ';
}

export async function runToolLoop(input: ToolLoopInput): Promise<ToolLoopResult> {
  const maxIterations = input.maxIterations ?? MAX_TOOL_ITERATIONS;

  // Working copy — we append to it as the loop progresses.
  const history: LlmMessage[] = [...input.history];
  const seenCalls: ToolCall[] = [];

  let text = '';
  let iterations = 0;
  let hitIterationCap = false;
  const stepDurationsMs: number[] = [];
  const usage: LlmUsage[] = [];

  for (; iterations < maxIterations; iterations += 1) {
    input.onStep?.();
    const startedAt = Date.now();
    const result = await step(
      input.provider,
      {
        history,
        systemInstruction: input.systemInstruction,
        tools: input.tools,
      },
      input.onDelta,
    );
    stepDurationsMs.push(Date.now() - startedAt);
    usage.push(result.usage ?? NO_USAGE);

    // Keep any prose the model emitted alongside its tool calls — it is often a
    // "กำลังค้นหาให้นะครับ" preamble the user should see.
    if (result.text.trim()) text = result.text;

    if (result.toolCalls.length === 0) {
      // A step with neither text nor a tool call is a model that could not
      // finish: the answer was cut off, or it was blocked. The turn has to
      // say something — and the flag tells the caller that this was not an
      // answer, so nobody reports it as one.
      const saidNothing = !result.text.trim();
      history.push(modelText(result.text));
      return {
        text: saidNothing ? fallbackText(result.finishReason) : text,
        toolCalls: seenCalls,
        iterations: iterations + 1,
        hitIterationCap: false,
        truncated: saidNothing,
        history,
        stepDurationsMs,
        usage,
      };
    }

    seenCalls.push(...result.toolCalls);
    history.push({
      role: 'model',
      parts: [
        ...(result.text.trim() ? [{ kind: 'text' as const, text: result.text }] : []),
        ...result.toolCalls.map((call) => ({ kind: 'toolCall' as const, call })),
      ],
    });

    // Run every call from this step, then return all results in ONE user message.
    // Batching keeps the history shape Gemini expects.
    const results: LlmMessage = { role: 'user', parts: [] };
    for (const call of result.toolCalls) {
      let outcome: Json;
      try {
        input.onTool?.(call);
        // The history travels with the context so a tool can see what has
        // already been established in this conversation.
        const context = input.toolContext ? { ...input.toolContext, history } : undefined;
        outcome = await input.executeTool(call, context);
      } catch (err) {
        outcome = {
          error: err instanceof Error ? err.message : 'tool execution failed',
          tool: call.name,
        };
      }
      results.parts.push({
        kind: 'toolResult',
        callId: call.id ?? call.name,
        name: call.name,
        result: outcome,
      });
    }
    history.push(results);

    if (result.finishReason === 'safety') {
      return {
        text: text || fallbackText('safety'),
        toolCalls: seenCalls,
        iterations: iterations + 1,
        hitIterationCap: false,
        truncated: !text.trim(),
        history,
        stepDurationsMs,
        usage,
      };
    }
  }

  // Iteration cap reached: ask once for a plain-text answer so the user is not
  // left with an empty bubble.
  hitIterationCap = true;
  let truncated = false;
  try {
    input.onStep?.();
    const summaryStartedAt = Date.now();
    const summary = await step(
      input.provider,
      {
        history: [
          ...history,
          userText('สรุปสั้นๆ ให้ผู้ใช้อ่านได้เลยว่าตอนนี้เป็นอย่างไร แล้วหยุด ไม่ต้องเรียกเครื่องมือเพิ่ม'),
        ],
        systemInstruction: input.systemInstruction,
        tools: [],
      },
      input.onDelta,
    );
    stepDurationsMs.push(Date.now() - summaryStartedAt);
    usage.push(summary.usage ?? NO_USAGE);
    if (summary.text.trim()) text = summary.text;
    else truncated = true;
    history.push(modelText(summary.text));
  } catch {
    // Fall through with the text we already have.
  }

  // No answer at all: say something rather than leave the user with a bubble
  // that is empty, and let the flag say that this was not a reply. A preamble
  // from an earlier step is not an answer either, so it goes too.
  if (!text.trim() || truncated) {
    text = fallbackText('other');
    truncated = true;
  }

  return { text, toolCalls: seenCalls, iterations, hitIterationCap, truncated, history, stepDurationsMs, usage };
}

/** Convenience: the shape we persist as `messages.content` for a stored turn. */
export function extractUserText(history: readonly LlmMessage[]): string {
  const first = history[0];
  if (!first) return '';
  return first.parts
    .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

export function extractToolNames(history: readonly LlmMessage[]): string[] {
  return history.flatMap((m) =>
    m.parts.filter((p) => p.kind === 'toolCall').map((p) => (p as { call: ToolCall }).call.name),
  );
}