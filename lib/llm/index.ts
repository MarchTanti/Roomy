/**
 * LLM entry point.
 *
 * Mirrors `lib/db/index.ts`: callers import `getLlm()` and never know which
 * provider is live. Swapping providers is a one-line change here plus one
 * adapter file.
 */

import { readEnv, requireEnv } from '../env';
import { createGeminiProvider } from './gemini';
import type { LlmProvider } from './types';
import { createGeminiRoomAnalyzer, type RoomAnalyzer } from './vision';

let cached: LlmProvider | null = null;
let override: LlmProvider | null = null;
let cachedAnalyzer: RoomAnalyzer | null = null;
let analyzerOverride: RoomAnalyzer | null = null;

export function activeLlm(): 'gemini' | 'none' {
  return readEnv('GEMINI_API_KEY') ? 'gemini' : 'none';
}

export function getLlm(): LlmProvider {
  if (override) return override;
  if (cached) return cached;
  cached = createGeminiProvider(requireEnv('GEMINI_API_KEY'));
  return cached;
}

/**
 * Room photo analysis. Same key and same SDK as the chat, but a separate
 * interface because the shape is different: no history, no tools, no text
 * output — just bytes in and a validated `RoomAnalysis` out.
 */
export function getRoomAnalyzer(): RoomAnalyzer {
  if (analyzerOverride) return analyzerOverride;
  if (cachedAnalyzer) return cachedAnalyzer;
  cachedAnalyzer = createGeminiRoomAnalyzer(requireEnv('GEMINI_API_KEY'));
  return cachedAnalyzer;
}

/**
 * Test seam: force a provider, bypassing `GEMINI_API_KEY`. Pass `null` to
 * restore the real one. Lets a test drive the whole `/api/chat` route with a
 * scripted provider and no network.
 */
export function setLlmForTesting(provider: LlmProvider | null): void {
  override = provider;
}

/** Test seam for `getRoomAnalyzer`, same idea as `setLlmForTesting`. */
export function setRoomAnalyzerForTesting(analyzer: RoomAnalyzer | null): void {
  analyzerOverride = analyzer;
}

/** Test seam: drop the memoised provider and any test override. */
export function resetLlm(): void {
  cached = null;
  override = null;
  cachedAnalyzer = null;
  analyzerOverride = null;
}

export * from './types';
export { runToolLoop, MAX_TOOL_ITERATIONS } from './loop';
export type { ToolLoopInput, ToolLoopResult, ToolExecutor } from './loop';
export { TOOL_SPECS, executeToolCall } from './tools';
export { SYSTEM_PROMPT, buildSystemInstruction, serializeSessionState } from './prompt';
export { VisionError } from './vision';
export type { RoomAnalyzer } from './vision';