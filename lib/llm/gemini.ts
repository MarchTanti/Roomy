/**
 * Gemini adapter — the only `LlmProvider` implementation today.
 *
 * Handles the three conventions that differ from Anthropic's SDK:
 *   1. Tool schemas are passed as full JSON Schema via `parametersJsonSchema`.
 *   2. `functionResponse` parts must be sent in a `user`-role message, not a
 *      `model`-role one. `toGeminiContents` handles that re-shaping.
 *   3. Every `functionCall` carries an opaque `thoughtSignature` that has to be
 *      echoed back verbatim on the next request, or the API answers HTTP 400.
 *      `toToolCalls` reads it off the raw part — the SDK's `response.functionCalls`
 *      getter throws it away.
 *
 * Everything above this file is provider-neutral.
 */

import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from '@google/genai';

import { settings } from '../env';
import {
  LlmError,
  type LlmDeltaHandler,
  type LlmMessage,
  type LlmProvider,
  type LlmStepInput,
  type LlmStepResult,
  type LlmUsage,
  type ToolCall,
  type ToolSpec,
} from './types';

function toFunctionDeclaration(spec: ToolSpec): FunctionDeclaration {
  return {
    name: spec.name,
    description: spec.description,
    parametersJsonSchema: spec.parameters as unknown as Record<string, unknown>,
  };
}

/** Re-shapes our neutral history into Gemini's `Content[]`. */
function toGeminiContents(history: readonly LlmMessage[]): Content[] {
  const contents: Content[] = [];

  for (const message of history) {
    const parts: Part[] = [];

    for (const part of message.parts) {
      switch (part.kind) {
        case 'text':
          parts.push({ text: part.text });
          break;
        case 'toolCall':
          parts.push({
            functionCall: {
              // Gemini matches responses by name, not by id.
              name: part.call.name,
              args: part.call.args as Record<string, unknown>,
            },
            // The opaque token has to go back on the same part it arrived on.
            // Without it Gemini answers HTTP 400 on the next turn.
            ...(part.call.signature ? { thoughtSignature: part.call.signature } : {}),
          });
          break;
        case 'toolResult':
          parts.push({
            functionResponse: {
              name: part.name,
              response:
                part.result !== null && typeof part.result === 'object' && !Array.isArray(part.result)
                  ? (part.result as Record<string, unknown>)
                  : { result: part.result },
            },
          });
          break;
      }
    }

    if (parts.length > 0) {
      contents.push({ role: message.role, parts });
    }
  }

  return contents;
}

/**
 * Reads function calls off the raw parts rather than `response.functionCalls`.
 *
 * That convenience getter maps `part.functionCall` and nothing else, so it
 * silently discards the sibling `thoughtSignature` — which is exactly the field
 * Gemini refuses to accept a functionCall without. Pairing them here is what
 * keeps the tool loop able to send a valid second request.
 */
function toToolCalls(parts: readonly Part[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const part of parts) {
    const call = part.functionCall;
    if (!call) continue;
    calls.push({
      id: typeof call.id === 'string' ? call.id : null,
      name: typeof call.name === 'string' ? call.name : '(unnamed)',
      args: (call.args ?? {}) as ToolCall['args'],
      signature: typeof part.thoughtSignature === 'string' ? part.thoughtSignature : undefined,
    });
  }
  return calls;
}

function toFinishReason(raw: unknown): LlmStepResult['finishReason'] {
  const reason = String(raw ?? '').toUpperCase();
  if (reason === 'STOP') return 'stop';
  if (reason === 'MAX_TOKENS') return 'max_tokens';
  if (reason === 'SAFETY' || reason === 'PROHIBITED_CONTENT' || reason === 'RECITATION') {
    return 'safety';
  }
  return 'other';
}

function requestParams(input: LlmStepInput) {
  return {
    model: settings.llmModel(),
    contents: toGeminiContents(input.history),
    config: {
      systemInstruction: input.systemInstruction,
      tools: [{ functionDeclarations: input.tools.map(toFunctionDeclaration) }],
      // The budget covers the thinking *and* the answer — Gemini 3 counts a
      // thought token against `maxOutputTokens` the same as a written one. At
      // 1,024 the model spent ~980 tokens thinking and had nothing left to
      // write with, so the turn came back empty (finishReason MAX_TOKENS, no
      // content at all). Measured: it thinks ~1,200 tokens and then answers in
      // a few hundred, so 4,096 leaves room for both without letting the
      // thinking balloon.
      maxOutputTokens: 4096,
      temperature: 0.7,
    },
  };
}

/**
 * True for a part the model wants the user to see.
 *
 * Streaming also delivers the model's own reasoning as parts flagged
 * `thought: true`. The non-streaming `response.text` getter skips those, and so
 * must we — otherwise the internal reasoning leaks into the chat bubble.
 */
function isVisibleText(part: Part): part is Part & { text: string } {
  return typeof part.text === 'string' && part.text.length > 0 && part.thought !== true;
}

function toUsage(raw: unknown): LlmUsage | undefined {
  const u = raw as {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  } | null;
  if (!u) return undefined;
  return {
    promptTokens: u.promptTokenCount,
    outputTokens: u.candidatesTokenCount,
    thoughtTokens: u.thoughtsTokenCount,
  };
}

export function createGeminiProvider(apiKey: string): LlmProvider {
  const client = new GoogleGenAI({ apiKey });

  const fail = (err: unknown): never => {
    const message = err instanceof Error ? err.message : String(err);
    throw new LlmError(`Gemini request failed: ${message}`, err);
  };

  return {
    id: 'gemini',

    async runStep(input: LlmStepInput): Promise<LlmStepResult> {
      if (input.history.length === 0) {
        throw new LlmError('runStep: history is empty');
      }

      try {
        const response = await client.models.generateContent(requestParams(input));

        return {
          text: response.text ?? '',
          toolCalls: toToolCalls(response.candidates?.[0]?.content?.parts ?? []),
          finishReason: toFinishReason(response.candidates?.[0]?.finishReason),
          usage: toUsage(response.usageMetadata),
        };
      } catch (err) {
        return fail(err);
      }
    },

    async runStepStream(input: LlmStepInput, onDelta: LlmDeltaHandler): Promise<LlmStepResult> {
      if (input.history.length === 0) {
        throw new LlmError('runStep: history is empty');
      }

      try {
        const stream = await client.models.generateContentStream(requestParams(input));

        let text = '';
        // Function calls arrive whole (the Gemini API does not stream partial
        // arguments), so collecting the parts across chunks is safe.
        const callParts: Part[] = [];
        let finishReason: unknown;
        let usage: LlmUsage | undefined;

        for await (const chunk of stream) {
          const parts = chunk.candidates?.[0]?.content?.parts ?? [];
          for (const part of parts) {
            if (isVisibleText(part)) {
              text += part.text;
              onDelta(part.text);
            }
            if (part.functionCall) callParts.push(part);
          }
          finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
          // Streaming reports totals only once, on the last chunk that has them.
          usage = toUsage(chunk.usageMetadata) ?? usage;
        }

        return {
          text,
          toolCalls: toToolCalls(callParts),
          finishReason: toFinishReason(finishReason),
          usage,
        };
      } catch (err) {
        return fail(err);
      }
    },
  };
}