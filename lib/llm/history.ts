/**
 * Type guard for message rows stored in the `messages` table.
 *
 * `messages.content` is a plain `jsonb` column, so anything could in principle
 * live there. This narrows it back to our `LlmMessage` shape and drops rows that
 * do not match, so one malformed row cannot break the whole history.
 */

import type { Json } from '@/lib/db/types';
import type { LlmMessage, LlmPart } from './types';

export type { LlmMessage };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPart(value: unknown): value is LlmPart {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'text':
      return typeof value.text === 'string';
    case 'toolCall':
      return isRecord(value.call) && typeof value.call.name === 'string';
    case 'toolResult':
      return typeof value.name === 'string' && 'result' in value;
    default:
      return false;
  }
}

export function isLlmMessage(value: Json | unknown): value is LlmMessage {
  if (!isRecord(value)) return false;
  if (value.role !== 'user' && value.role !== 'model') return false;
  if (!Array.isArray(value.parts)) return false;
  return value.parts.every(isPart);
}

/**
 * How much of the stored conversation to resend to the model.
 *
 * Every turn was resending everything, so each request was larger than the one
 * before — which is most of why a turn took 7s early on and 10s by the fourth.
 * The spec's own design already answers this: facts live in `SessionState` (in
 * the system instruction) rather than in the transcript, so old chat turns are
 * context, not the source of truth, and losing the oldest ones costs little.
 */
export const MAX_HISTORY_MESSAGES = 16;

/** A model message that asks for a tool. */
function isCallTurn(message: LlmMessage | undefined): boolean {
  return !!message && message.role === 'model' && message.parts.some((p) => p.kind === 'toolCall');
}

/** A user message that is nothing but answers to tool calls. */
function isResultTurn(message: LlmMessage): boolean {
  return (
    message.role === 'user' && message.parts.length > 0 && message.parts.every((p) => p.kind === 'toolResult')
  );
}

/**
 * Keeps the most recent messages, cutting only where Gemini will accept it.
 *
 * A `functionCall` turn has to sit immediately after a user turn or after a
 * `functionResponse` turn. That gives exactly three illegal cut points, all of
 * which the API rejects with "function call turn comes immediately after a user
 * turn or after a function response turn":
 *
 *   1. starting ON a `functionResponse` — its call is gone
 *   2. starting ON a `functionCall`  — nothing precedes it
 *   3. cutting between a `functionCall` and its result
 *
 * When the naive cut lands on one, slide forward until it does not. That can
 * drop a few extra messages, and in the worst case (a history with no legal
 * start at all) it drops everything — correctness beats sending a request the
 * API will refuse.
 *
 * The check runs even when nothing needs trimming, because a history can begin
 * illegally on its own: once earlier turns have been dropped by an earlier
 * trim, the remaining window may open on a `functionCall`.
 */
export function trimHistory(
  history: readonly LlmMessage[],
  limit = MAX_HISTORY_MESSAGES,
): LlmMessage[] {
  if (limit <= 0) return [];

  let start = Math.max(0, history.length - limit);

  while (start < history.length) {
    const legal = !isResultTurn(history[start]) && !isCallTurn(history[start]) && !isCallTurn(history[start - 1]);
    if (legal) break;
    start += 1;
  }

  return history.slice(start);
}

/**
 * Removes tool round trips the provider would refuse to replay.
 *
 * Gemini rejects a `functionCall` that arrives without its opaque signature,
 * and there is no way to mint one after the fact. So a turn written before the
 * adapter started echoing signatures would fail the API check on *every*
 * future message in that session — the user is locked out of the conversation
 * over one stale row.
 *
 * Dropping the call and its result costs the model one round trip of memory.
 * Keeping it costs the user every message they try to send. Model turns left
 * with nothing but a preamble are dropped too; empty messages are removed so we
 * never send a `Content` with zero parts.
 */
export function dropUnsignedToolCalls(history: readonly LlmMessage[]): LlmMessage[] {
  // toolResult.callId is `call.id ?? call.name`, so key the orphaned results by
  // the same value the loop wrote.
  const orphaned = new Set<string>();
  const kept: LlmMessage[] = [];

  for (const message of history) {
    if (message.role !== 'model') {
      kept.push(message);
      continue;
    }
    const parts: LlmPart[] = [];
    for (const part of message.parts) {
      if (part.kind === 'toolCall' && !part.call.signature) {
        orphaned.add(part.call.id ?? part.call.name);
        continue;
      }
      parts.push(part);
    }
    if (parts.length > 0) kept.push({ role: message.role, parts });
  }

  return kept
    .map((message) =>
      message.role === 'user'
        ? { ...message, parts: message.parts.filter((p) => p.kind !== 'toolResult' || !orphaned.has(p.callId)) }
        : message,
    )
    .filter((message) => message.parts.length > 0);
}