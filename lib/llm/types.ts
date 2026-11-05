/**
 * Provider-neutral types for the LLM layer.
 *
 * The route handler never imports the Gemini SDK directly. It talks to an
 * `LlmProvider`, which performs exactly ONE step: given a message history plus
 * a tool list, return either text or zero-or-more tool calls.
 *
 * The tool-use loop itself lives in `loop.ts` and is shared by every provider,
 * so swapping Gemini for something else later cannot change orchestration.
 */

import type { Json } from '@/lib/db/types';

// ---------------------------------------------------------------------------
// Tool declarations
// ---------------------------------------------------------------------------

/**
 * One node of a tool's JSON Schema.
 *
 * Nested objects are allowed because some tools take a list of things with
 * several fields each — a room design takes a list of pieces, and a piece has
 * a category, a note and a width.
 */
export interface ToolSchemaNode {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: readonly string[];
  items?: ToolSchemaNode;
  properties?: Record<string, ToolSchemaNode>;
  required?: readonly string[];
}

/** JSON Schema subset. Kept small on purpose — every field maps 1:1 to Gemini. */
export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, ToolSchemaNode>;
  required?: readonly string[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

// ---------------------------------------------------------------------------
// Conversation parts
// ---------------------------------------------------------------------------

export interface ToolCall {
  /** Provider-assigned id, when the provider supplies one. */
  id: string | null;
  name: string;
  args: Json;
  /**
   * Opaque provider token that MUST be echoed back verbatim with the call on
   * every later turn.
   *
   * Today only Gemini sets it (it calls the field `thoughtSignature` and
   * attaches it to the `functionCall` part). Gemini rejects the entire request
   * with HTTP 400 if a functionCall comes back without it, so it has to ride
   * along inside `LlmMessage` — which means it is persisted with the turn and
   * replayed on the next one. Do not strip it: the failure mode is a 400 on the
   * *following* request, long after anything here looks wrong.
   */
  signature?: string;
}

export type LlmPart =
  | { kind: 'text'; text: string }
  /** The model asking for a tool. Only ever appears in `model` messages. */
  | { kind: 'toolCall'; call: ToolCall }
  /** Our answer to a toolCall. Always sent back as a `user` message. */
  | { kind: 'toolResult'; callId: string; name: string; result: Json };

export interface LlmMessage {
  role: 'user' | 'model';
  parts: LlmPart[];
}

export function userText(text: string): LlmMessage {
  return { role: 'user', parts: [{ kind: 'text', text }] };
}

export function modelText(text: string): LlmMessage {
  return { role: 'model', parts: [{ kind: 'text', text }] };
}

// ---------------------------------------------------------------------------
// One provider step
// ---------------------------------------------------------------------------

export interface LlmStepInput {
  /** Full history, oldest first. Must start with a `user` message. */
  history: readonly LlmMessage[];
  systemInstruction: string;
  tools: readonly ToolSpec[];
}

export type LlmFinishReason = 'stop' | 'max_tokens' | 'safety' | 'other';

/**
 * What one step cost.
 *
 * `thoughtTokens` is separate from `outputTokens` on purpose: the model reasons
 * before it answers, and that reasoning is billed and timed but never shown. A
 * turn that spends 3,000 thought tokens is slow for a reason no amount of
 * history trimming will fix.
 */
export interface LlmUsage {
  promptTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
}

export interface LlmStepResult {
  /** Concatenated text the model produced. May be empty when it only calls tools. */
  text: string;
  toolCalls: ToolCall[];
  finishReason: LlmFinishReason;
  usage?: LlmUsage;
}

/** Receives text as the model produces it, fragment by fragment. */
export type LlmDeltaHandler = (delta: string) => void;

/** The seam. One adapter today (Gemini); a future provider adds one file. */
export interface LlmProvider {
  readonly id: string;
  runStep(input: LlmStepInput): Promise<LlmStepResult>;
  /**
   * Optional streaming variant. Calls `onDelta` for each text fragment and
   * resolves to exactly the same `LlmStepResult` as `runStep` — same text,
   * same tool calls, same finish reason.
   *
   * Optional so a provider that cannot stream still works: the loop falls back
   * to `runStep` and the user sees the whole answer at once.
   */
  runStepStream?(input: LlmStepInput, onDelta: LlmDeltaHandler): Promise<LlmStepResult>;
}

export class LlmError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'LlmError';
  }
}