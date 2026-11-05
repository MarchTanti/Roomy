/**
 * The shape of `results.json`.
 *
 * Step 8 of the build plan asks for one file that holds what the system
 * actually did, so a reader can check the claims without taking the README's
 * word for it. It has two halves:
 *
 *   - `catalogue_fit` — every product in the catalogue put against one
 *     measured space, judged by the fit rule. No model involved, so the
 *     numbers in it are the database's and the rule's.
 *   - `chat_scenarios` — the end-to-end conversations, run through the real
 *     `/api/chat` route, with the checks that say whether each one behaved.
 *
 * The file is a *record*, not a configuration: nothing reads it back at
 * runtime. It is written by `npm run results` and read by a person.
 */

import type { Preferences, Json } from '../db/types';
import type { DesignView } from '../design/view';
import type { ComparisonView, SearchProduct } from '../llm/tools';
import type { CatalogueFitResult } from './catalogue-fit';

// ---------------------------------------------------------------------------
// The catalogue sweep
// ---------------------------------------------------------------------------

export interface CatalogueFitSection extends CatalogueFitResult {
  /** Where the space came from — a default, or a flag on the command line. */
  space_source: string;
}

// ---------------------------------------------------------------------------
// The chat scenarios
// ---------------------------------------------------------------------------

/** One automated check on one turn. */
export interface ScenarioCheck {
  /** What was checked, in English, so the report can list it. */
  name: string;
  ok: boolean;
  /** What was seen, in Thai where the answer was in Thai. */
  detail: string;
}

/** A tool call, as the route reported it. */
export interface ReportedToolCall {
  name: string;
  args: Json;
}

export interface ChatScenarioResult {
  /** A slug: `search_by_style_and_budget`. */
  name: string;
  /** The Thai label the report shows. */
  title: string;
  /** Why this scenario is in the set. */
  intent: string;
  /** Exactly what was sent. */
  prompt: string;
  /** The second message, when the scenario needed two turns. */
  follow_up: string | null;
  /** Which scenario of the run this was, counting from 1. */
  turn: number;
  /** How many chat turns the scenario took. */
  turns: number;
  /** True when every check passed. */
  ok: boolean;
  /** The model's answer to the last turn, verbatim. */
  reply: string;
  /** The model's answer to the turn before it, when there was one. */
  previous_reply: string | null;
  tool_calls: ReportedToolCall[];
  iterations: number;
  hit_iteration_cap: boolean;
  /** True when the model could not finish, so the reply is an apology. */
  truncated: boolean;
  /** The products the client would show as cards, from the search result. */
  products: SearchProduct[] | null;
  /** The comparison the client would show as a table, if there was one. */
  comparison: ComparisonView | null;
  /** The room the last turn designed, if it designed one. */
  design: DesignView | null;
  /** The preferences the database kept after the turn. */
  preferences: Preferences;
  /** How many chat turns the session had left in the hour. */
  chat_turns_left: number | null;
  /** Wall-clock time for the whole scenario. */
  latency_ms: number;
  /** Time to the first token of the first answer. */
  first_token_ms: number | null;
  /** Token counts. Numbers only — never the text they were counted from. */
  usage: { in: number; out: number; think: number } | null;
  checks: ScenarioCheck[];
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

export interface ResultsAppInfo {
  /** `local` or `supabase`. */
  adapter: 'local' | 'supabase';
  /** `gemini` or `none`. */
  llm: string;
  llm_model: string;
  image_model: string;
}

export interface ResultsSummary {
  scenarios: number;
  scenarios_passed: number;
  checks: number;
  checks_failed: number;
}

export interface ResultsFile {
  /** ISO 8601, UTC. */
  generated_at: string;
  app: ResultsAppInfo;
  catalogue_fit: CatalogueFitSection;
  chat_scenarios: ChatScenarioResult[];
  summary: ResultsSummary;
}
