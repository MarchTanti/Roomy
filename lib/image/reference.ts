/**
 * The piece's own picture, as a reference for the image model.
 *
 * The catalogue row points at a picture of the item: an illustration today, a
 * photograph once the catalogue is curated with real ones. Either way it is
 * the only way the image model can see the *actual* piece. Without it the
 * model is told what the piece is in words and draws whatever those words
 * suggest — a sofa that is grey and about the right size, but not the sofa in
 * the card above the chat.
 *
 * Two kinds of source are supported:
 *
 *   - a file under `public/product-images/` — read from disk, and drawn out
 *     when it is an SVG, because the model takes raster pictures.
 *   - an https URL — the picture of a real product on a CDN. It is fetched
 *     here, capped and re-encoded, so the model is never handed a URL and the
 *     server never forwards an unknown address to a third party.
 *
 * A picture that cannot be read is not an error. The generation goes on with
 * the piece described in words, exactly as it went on before, and the user is
 * none the wiser.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

/** A picture the model can look at. */
export interface ReferenceImage {
  /** The picture itself. */
  bytes: Buffer;
  /** What kind of picture it is. */
  mimeType: string;
}

/** The longest edge the model is sent. */
const MAX_EDGE = 1024;

/** The biggest picture that is fetched. */
const MAX_BYTES = 8 * 1024 * 1024;

/** How long a remote picture may take. */
const FETCH_TIMEOUT_MS = 10_000;

/** How many redirects a remote picture may take. */
const MAX_REDIRECTS = 3;

/**
 * Where the catalogue's pictures live.
 *
 * The same override the upload store has, so a test can point it somewhere
 * else and the server can be started from another directory.
 */
function publicDir(): string {
  return process.env.ROOMY_PUBLIC_DIR ?? path.join(process.cwd(), 'public');
}

/**
 * The picture of the piece the catalogue row points at.
 *
 * Null when there is no picture to be had: a row without one, a file that is
 * not there, or a source the server will not follow.
 */
export async function resolveProductReference(
  imageUrl: string | null | undefined,
): Promise<ReferenceImage | null> {
  const url = (imageUrl ?? '').trim();
  if (!url) return null;
  if (url.startsWith('/product-images/')) return localPicture(url);
  if (/^https:\/\//i.test(url)) return remotePicture(url);
  return null;
}

/**
 * A picture from the catalogue's own folder.
 *
 * Only the file name is used, so a row cannot point outside the folder.
 */
async function localPicture(urlPath: string): Promise<ReferenceImage | null> {
  const name = path.basename(urlPath);
  if (!name || name === '.' || name === '..') return null;

  try {
    const bytes = await fs.readFile(path.join(publicDir(), 'product-images', name));
    return await prepare(bytes);
  } catch {
    return null;
  }
}

/**
 * A picture from the web — a real product photograph on a CDN.
 *
 * Redirects are followed by hand, a few at a time, because every hop is
 * another address the server would fetch.
 */
async function remotePicture(url: string): Promise<ReferenceImage | null> {
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const parsed = safeUrl(current);
    if (!parsed || !isPublicHost(parsed.hostname)) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(parsed, { signal: controller.signal, redirect: 'manual' });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) return null;
        current = new URL(location, parsed).toString();
        continue;
      }

      if (!res.ok) return null;
      const type = (res.headers.get('content-type') ?? '').toLowerCase();
      if (!type.startsWith('image/')) return null;

      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_BYTES) return null;

      return await prepare(bytes);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}

/** Only https, and only an address that can be parsed at all. */
function safeUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Hosts that are not on the internet.
 *
 * The catalogue is a file the owner curates, but a row is still an address
 * the server would fetch, and an address that points at the machine itself is
 * not one to follow.
 */
function isPublicHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (name === 'localhost' || name.endsWith('.local') || name.endsWith('.internal')) return false;
  if (name === '::1' || name === '0.0.0.0') return false;

  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(name);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 169 && b === 254) return false;
  }

  return true;
}

/**
 * The picture, ready to be sent: a raster, and small enough to travel.
 *
 * An SVG is drawn out first — the model takes pictures, not drawings — and
 * everything else is re-encoded as JPEG so the payload stays small.
 */
async function prepare(bytes: Buffer): Promise<ReferenceImage | null> {
  try {
    const meta = await sharp(bytes, { failOn: 'none' }).metadata();
    if (!meta.width || !meta.height) return null;

    const resized = sharp(bytes, { failOn: 'none' }).resize({
      width: MAX_EDGE,
      height: MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    });

    if (meta.format === 'svg') {
      return { bytes: await resized.png().toBuffer(), mimeType: 'image/png' };
    }

    return {
      bytes: await resized.flatten({ background: '#ffffff' }).jpeg({ quality: 88 }).toBuffer(),
      mimeType: 'image/jpeg',
    };
  } catch {
    return null;
  }
}
