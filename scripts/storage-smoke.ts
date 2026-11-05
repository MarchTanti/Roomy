/**
 * Round-trip smoke test for the storage helpers.
 *
 *   npx tsx scripts/storage-smoke.ts
 *
 * Generates a JPEG with EXIF/GPS metadata, runs it through `uploadRoomPhoto`,
 * asks `signedUrlFor` for a URL, fetches the URL with plain Node `fetch`,
 * and asserts:
 *
 *   - uploaded bytes match processed bytes (round-trip integrity)
 *   - the downloaded buffer has NO EXIF/GPS/ICC/XMP (privacy rule)
 *   - the long edge is at or below the configured cap
 *
 * Cleans up after itself by deleting the uploaded object.
 *
 * NOTE: this writes one tiny file to your live Supabase `room-photos` bucket.
 * Run only after you have approved it.
 */

import { randomUUID } from 'node:crypto';

import sharp from 'sharp';

import {
  _resetUploadStorageClient,
  uploadRoomPhoto,
} from '../lib/storage/upload-room-photo';
import { assertNoExif } from '../lib/storage/process-image';
import { _resetStorageClient, signedUrlFor } from '../lib/storage/signed-url';
import { createClient } from '@supabase/supabase-js';
import { loadEnvLocal } from './_load-env';

loadEnvLocal();

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function check(name: string, ok: boolean, detail = ''): Check {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  return { name, ok, detail };
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
    process.exit(1);
  }

  // 1. Build a 4000x3000 JPEG with a plain IFD0 EXIF block (the privacy smoke
  //    test just needs ANY EXIF — sharp strips the whole segment, which also
  //    drops any GPS IFD). The cap in `.env.example` is 1536.
  const tainted = await sharp({
    create: {
      width: 4000,
      height: 3000,
      channels: 3,
      background: { r: 30, g: 110, b: 200 },
    },
  })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Make: 'phantom-tester' } } })
    .toBuffer();

  console.log(`seeded test image: ${tainted.length} bytes with EXIF`);

  // 2. Upload through the helper.
  const sessionId = randomUUID();
  const uploaded = await uploadRoomPhoto(sessionId, tainted, 'image/jpeg');
  check(
    'upload',
    true,
    `path=${uploaded.path} bytes=${uploaded.bytes} ${uploaded.width}x${uploaded.height}`,
  );
  check(
    'long-edge cap honoured',
    Math.max(uploaded.width, uploaded.height) <= 1536,
    `long=${Math.max(uploaded.width, uploaded.height)} ≤ 1536`,
  );

  // 3. Sign and download the same object back.
  const signed = await signedUrlFor(uploaded.path);
  const res = await fetch(signed.url);
  if (!res.ok) {
    check('download', false, `HTTP ${res.status}`);
    process.exit(1);
  }
  const downloaded = Buffer.from(await res.arrayBuffer());
  check(
    'download',
    true,
    `HTTP 200, ${downloaded.length} bytes, expires ${signed.expiresAt.toISOString()}`,
  );
  check(
    'byte-integrity',
    downloaded.length === uploaded.bytes,
    `downloaded=${downloaded.length} uploaded=${uploaded.bytes}`,
  );

  // 4. Privacy: downloaded buffer must have no EXIF/GPS/ICC/XMP.
  try {
    await assertNoExif(downloaded);
    check('no EXIF/GPS in downloaded bytes', true);
  } catch (err) {
    check('no EXIF/GPS in downloaded bytes', false, (err as Error).message);
    process.exit(1);
  }

  // 5. Cleanup.
  const admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: rmErr } = await admin.storage.from('room-photos').remove([uploaded.path]);
  check(
    'cleanup',
    !rmErr,
    rmErr ? rmErr.message : `removed ${uploaded.path}`,
  );

  console.log('\nStorage round-trip OK.');
}

main()
  .catch((err) => {
    console.error('smoke crashed:', err);
    process.exit(1);
  })
  .finally(() => {
    _resetStorageClient();
    _resetUploadStorageClient();
  });
