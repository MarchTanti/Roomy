/**
 * Storage key conventions.
 *
 * Every photo in the `room-photos` bucket lives at:
 *
 *   <session_id>/<image_id>.jpg
 *
 * The `<session_id>` segment is what the RLS policies (and `delete_expired_sessions()`)
 * use to scope reads and deletes. Centralising the format here means there is
 * exactly one place to change if we ever rename or re-shape the prefix.
 */

const EXT = '.jpg';
const SEP = '/';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function imageKey(sessionId: string, imageId: string): string {
  if (!UUID_RE.test(sessionId)) {
    throw new Error(`imageKey: sessionId is not a UUID: "${sessionId}"`);
  }
  if (!UUID_RE.test(imageId)) {
    throw new Error(`imageKey: imageId is not a UUID: "${imageId}"`);
  }
  return `${sessionId}${SEP}${imageId}${EXT}`;
}

export interface ParsedImageKey {
  sessionId: string;
  imageId: string;
  extension: string;
}

export function parseImageKey(path: string): ParsedImageKey {
  const idx = path.lastIndexOf(SEP);
  if (idx === -1) throw new Error(`parseImageKey: missing path separator in "${path}"`);
  const folder = path.slice(0, idx);
  const filename = path.slice(idx + 1);
  const dot = filename.lastIndexOf('.');
  if (dot === -1) throw new Error(`parseImageKey: missing extension in "${path}"`);

  const sessionId = folder;
  const imageId = filename.slice(0, dot);
  const extension = filename.slice(dot + 1);

  if (!UUID_RE.test(sessionId)) {
    throw new Error(`parseImageKey: sessionId is not a UUID: "${sessionId}"`);
  }
  if (!UUID_RE.test(imageId)) {
    throw new Error(`parseImageKey: imageId is not a UUID: "${imageId}"`);
  }
  return { sessionId, imageId, extension };
}

/** True iff the given storage path matches the convention. Use in tests. */
export function isValidImageKey(path: string): boolean {
  try {
    parseImageKey(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * True iff the value is a UUID.
 *
 * A session id becomes a folder name in the bucket and a folder name on disk,
 * so it has to be checked before it is used as one — the guard against a
 * caller walking out of the uploads directory.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
