/**
 * The pictures.
 *
 * They are downloaded once, made smaller, and kept in `public/product-images/`
 * so the app serves them itself — the shops' servers are not part of the
 * request path when someone opens the chat, and the image model gets the
 * same file the card shows.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

import { fetchBinary } from './http';

/** The longest edge a catalogue picture is kept at. */
const MAX_EDGE = 900;

export interface SavedImage {
  /** The path the catalogue row points at. */
  url: string;
  /** Where the picture came from, for the record. */
  from: string;
}

/**
 * Downloads a picture and writes it under public/product-images/.
 *
 * Returns null when the picture cannot be fetched — a row without a picture
 * is better than a row pointing at a broken image.
 */
export async function saveProductImage(id: string, remoteUrl: string): Promise<SavedImage | null> {
  let bytes: Buffer;
  try {
    bytes = await fetchBinary(remoteUrl);
  } catch {
    return null;
  }

  try {
    const jpeg = await sharp(bytes, { failOn: 'none' })
      .rotate()
      .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();

    const directory = path.join(process.cwd(), 'public', 'product-images');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${id}.jpg`), jpeg);
    return { url: `/product-images/${id}.jpg`, from: remoteUrl };
  } catch {
    return null;
  }
}
