/**
 * Environment access.
 *
 * Every value is read lazily through a getter so that a missing variable only
 * throws when something actually needs it. Step 1 (setup + seed) must be able to
 * run with an empty `.env.local`, so importing this module must never throw.
 *
 * Nothing here is ever exposed to the client: no `NEXT_PUBLIC_*` prefix is used
 * for secrets, per the spec's "keep all API keys server-side" rule.
 */

export class MissingEnvError extends Error {
  constructor(
    readonly key: string,
    detail?: string,
  ) {
    super(
      detail ??
        `Missing environment variable: ${key}. Copy .env.example to .env.local and fill it in.`,
    );
    this.name = 'MissingEnvError';
  }
}

/**
 * The server cannot keep anything between requests.
 *
 * The local adapter writes files, and a serverless instance keeps its files
 * read-only apart from `/tmp` — and `/tmp` is thrown away with the instance,
 * so a session written there would be gone before anyone came back. The
 * deployment needs Postgres, so this names the setting that is missing
 * instead of letting the filesystem say "permission denied".
 *
 * It is a `MissingEnvError` in everything but the wording: the routes that
 * already answer 503 for a missing setting answer 503 for this too.
 */
export class NoWritableStorageError extends MissingEnvError {
  constructor(key: string, detail: string) {
    super(key, detail);
    this.name = 'NoWritableStorageError';
  }
}

/** Reads a trimmed, non-empty env var, or undefined if unset/blank. */
export function readEnv(key: string): string | undefined {
  const raw = process.env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Reads a required env var, throwing a helpful error when it is absent. */
export function requireEnv(key: string): string {
  const value = readEnv(key);
  if (value === undefined) throw new MissingEnvError(key);
  return value;
}

export function readEnvNumber(key: string, fallback: number): number {
  const value = readEnv(key);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Which DB adapter to use. `local` needs zero credentials. */
export function dbAdapter(): 'local' | 'supabase' {
  return readEnv('DB_ADAPTER') === 'supabase' ? 'supabase' : 'local';
}

/** True when both Supabase credentials are present. */
export function hasSupabase(): boolean {
  return readEnv('SUPABASE_URL') !== undefined && readEnv('SUPABASE_SERVICE_ROLE_KEY') !== undefined;
}

export const settings = {
  /** Chat model. Must support function calling. */
  llmModel: () => readEnv('LLM_MODEL') ?? 'gemini-3.8-flash',
  /**
   * Room photo analysis. Shares the chat model by default — one model that both
   * sees and speaks avoids a second vision dependency, and it already has to be
   * capable enough to drive the tool loop. Override with VISION_MODEL only if
   * you want the analysis on a different (or larger) model than the chat.
   */
  visionModel: () => readEnv('VISION_MODEL') ?? readEnv('LLM_MODEL') ?? 'gemini-3.8-flash',
  /** Image editing model for the ImageEditProvider adapter. */
  imageModel: () => readEnv('IMAGE_MODEL') ?? 'gemini-3.1-flash-image',
  imageQuotaPerSession: () => readEnvNumber('IMAGE_QUOTA_PER_SESSION', 10),
  /**
   * How many room photos one session may upload.
   *
   * Separate from the image quota on purpose: that budget is for *generated*
   * images, the ones that cost a generation call. This one just stops a single
   * session filling the bucket.
   */
  roomPhotosPerSession: () => readEnvNumber('ROOM_PHOTOS_PER_SESSION', 4),
  signedUrlTtlSeconds: () => readEnvNumber('SIGNED_URL_TTL_SECONDS', 3600),
  maxUploadMb: () => readEnvNumber('MAX_UPLOAD_MB', 8),
  uploadLongEdgePx: () => readEnvNumber('UPLOAD_LONG_EDGE_PX', 1536),
  chatTurnsPerHour: () => readEnvNumber('CHAT_TURNS_PER_HOUR', 20),
  /**
   * How many stored messages to resend to the model each turn. Lower is faster
   * and cheaper; the session state in the system instruction is what keeps the
   * bot remembering facts, not the transcript.
   */
  maxHistoryMessages: () => readEnvNumber('MAX_HISTORY_MESSAGES', 16),
  /** Hard timeout for one image-generation job, per the spec. */
  generationTimeoutMs: () => readEnvNumber('GENERATION_TIMEOUT_MS', 90_000),
  /**
   * The secrets that authorise the retention sweep over HTTP.
   *
   * `CLEANUP_SECRET` is ours. `CRON_SECRET` is the name Vercel looks for: when
   * it is set, Vercel sends its value back as `Authorization: Bearer …` on
   * every cron request. Reading both means a deployment needs **one**
   * variable, not two that have to be kept in step — and either one alone is
   * enough to switch the sweep on.
   *
   * Empty means the sweep is off: with no secret there is nothing to compare
   * the token against, and an open "delete everything older than N days"
   * endpoint is not a thing to leave on the internet. The npm script does not
   * need it — it runs on the machine that holds the credentials.
   */
  cleanupSecrets: () =>
    [readEnv('CLEANUP_SECRET'), readEnv('CRON_SECRET')].filter(
      (value): value is string => value !== undefined,
    ),
  /** How long a session and its photos are kept before the sweep removes them. */
  retentionDays: () => readEnvNumber('RETENTION_DAYS', 7),
};