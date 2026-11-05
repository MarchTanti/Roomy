/**
 * Polite fetching.
 *
 * Both shops are crawled the way a person with a browser would be: one
 * request at a time, a pause between them, a browser's user agent, and a
 * cache on disk so a second run does not ask the same question twice.
 *
 * The cache lives under `.data/catalog-cache/`, which the repo already
 * ignores. `--refresh` ignores the cache and asks again.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** The pause between two requests, in milliseconds. */
const PAUSE_MS = 400;

const TIMEOUT_MS = 60_000;

const RETRIES = 2;

let lastRequestAt = 0;

/** True when the run was asked not to use the cache. */
export const refreshing = process.argv.includes('--refresh');

function cachePath(url: string): string {
  const hash = crypto.createHash('sha1').update(url).digest('hex');
  return path.join(process.cwd(), '.data', 'catalog-cache', `${hash}.txt`);
}

async function pause(): Promise<void> {
  const wait = lastRequestAt + PAUSE_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

async function request(url: string, accept: string): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    await pause();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: accept,
          'Accept-Language': 'th,en;q=0.8',
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return response;
    } catch (err) {
      lastError = err;
      if (attempt < RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`could not fetch ${url}: ${lastError instanceof Error ? lastError.message : lastError}`);
}

/** Fetches a page as text, using the on-disk cache when it is allowed to. */
export async function fetchText(url: string): Promise<string> {
  const file = cachePath(url);
  if (!refreshing) {
    const cached = await fs.readFile(file, 'utf8').catch(() => null);
    if (cached !== null) return cached;
  }

  const response = await request(url, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
  const text = await response.text();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
  return text;
}

/** Fetches a file as bytes. Pictures are not cached: they are downloaded once. */
export async function fetchBinary(url: string): Promise<Buffer> {
  const response = await request(url, 'image/*,*/*;q=0.8');
  return Buffer.from(await response.arrayBuffer());
}

/** Fetches a plain-text document (a sitemap), cached like a page. */
export async function fetchDocument(url: string): Promise<string> {
  return fetchText(url);
}

/**
 * Fetches a gzipped document.
 *
 * HomePro serves its category sitemap as a `.xml.gz` file — the bytes are a
 * gzip archive, not a document with an encoding header, so the server does
 * not unpack it for us.
 */
export async function fetchGzipDocument(url: string): Promise<string> {
  const file = cachePath(url);
  if (!refreshing) {
    const cached = await fs.readFile(file, 'utf8').catch(() => null);
    if (cached !== null) return cached;
  }

  const response = await request(url, 'application/xml,text/xml,*/*;q=0.8');
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = zlib.gunzipSync(bytes).toString('utf8');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
  return text;
}
