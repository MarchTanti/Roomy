/**
 * Image entry point.
 *
 * Mirrors `lib/llm/index.ts`: callers import `getImageProvider()` and never
 * know which service is live. The test seam lets a test drive the whole
 * `/api/generate` route with a stub provider and no network.
 */

import { requireEnv } from '../env';
import { createGeminiImageProvider } from './gemini';
import type { ImageProvider } from './types';

let cached: ImageProvider | null = null;
let override: ImageProvider | null = null;

export function getImageProvider(): ImageProvider {
  if (override) return override;
  if (cached) return cached;
  cached = createGeminiImageProvider(requireEnv('GEMINI_API_KEY'));
  return cached;
}

/** Test seam: force a provider, or pass null to restore the real one. */
export function setImageProviderForTesting(provider: ImageProvider | null): void {
  override = provider;
}

/** Drops the memoised provider and any test override. */
export function resetImageProvider(): void {
  cached = null;
  override = null;
}

export { buildImagePrompt } from './prompt';
export type { ImagePromptInput } from './prompt';
export { applySimulatedLabel, labelLayout, SIMULATED_LABEL } from './label';
export { markArea } from './mark-area';
export { resolveProductReference } from './reference';
export type { ReferenceImage } from './reference';
export { ImageError } from './types';
export type {
  ImageProvider,
  ImageRequest,
  ImageResult,
  ImageFailure,
} from './types';
