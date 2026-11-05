/**
 * In-process sliding-window rate limiter.
 *
 * The spec requires "Rate limit by session and IP: 20 chat turns per hour".
 * This implements both halves with one small data structure.
 *
 * Scope note: this is per-process. With more than one Node worker (or a
 * serverless deployment that runs several instances) each process keeps its own
 * counters, so the effective limit becomes N × the configured value. Moving the
 * counters into Postgres or Redis is a drop-in replacement behind the same
 * three functions.
 */

interface Window {
  /** Timestamps of accepted requests, oldest first. */
  hits: number[];
}

/** The window the spec's "20 chat turns per hour" is measured over. */
export const HOUR_MS = 60 * 60 * 1000;

/** The key a session's turns are counted under. */
export function sessionKey(sessionId: string): string {
  return `session:${sessionId}`;
}

/** The key a client's turns are counted under. */
export function ipKey(ip: string): string {
  return `ip:${ip}`;
}

const windows = new Map<string, Window>();

/** Drop windows we can never read again, so the map cannot grow unbounded. */
function sweep(now: number, windowMs: number): void {
  for (const [key, window] of windows) {
    const newest = window.hits[window.hits.length - 1];
    if (newest !== undefined && now - newest > windowMs) windows.delete(key);
  }
}

export interface RateLimitResult {
  ok: boolean;
  /** How many requests remain in the current window. */
  remaining: number;
  /** Unix ms when the window frees up a slot. */
  retryAfterMs: number;
  limit: number;
}

export interface RateLimitOptions {
  key: string;
  limit: number;
  windowMs: number;
}

/** Records one accepted request. Call only after `check` returned ok. */
export function consume(options: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const cutoff = now - options.windowMs;

  const existing = windows.get(options.key);
  const hits = (existing?.hits ?? []).filter((t) => t > cutoff);

  if (hits.length >= options.limit) {
    // Do not push: we are rejecting, so this slot must stay available.
    windows.set(options.key, { hits });
    const oldest = hits[0] ?? now;
    return {
      ok: false,
      remaining: 0,
      retryAfterMs: Math.max(0, oldest + options.windowMs - now),
      limit: options.limit,
    };
  }

  hits.push(now);
  windows.set(options.key, { hits });
  sweep(now, options.windowMs);

  return {
    ok: true,
    remaining: options.limit - hits.length,
    retryAfterMs: 0,
    limit: options.limit,
  };
}

/** Reads current state without consuming. */
export function peek(options: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const cutoff = now - options.windowMs;
  const hits = (windows.get(options.key)?.hits ?? []).filter((t) => t > cutoff);
  if (hits.length >= options.limit) {
    const oldest = hits[0] ?? now;
    return {
      ok: false,
      remaining: 0,
      retryAfterMs: Math.max(0, oldest + options.windowMs - now),
      limit: options.limit,
    };
  }
  return {
    ok: true,
    remaining: options.limit - hits.length,
    retryAfterMs: 0,
    limit: options.limit,
  };
}

/** Test seam. */
export function resetRateLimits(): void {
  windows.clear();
}

/**
 * Best-effort client IP. Behind a proxy this reads `x-forwarded-for`; the first
 * entry is the original client.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip') ?? 'unknown';
}