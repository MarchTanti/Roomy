/**
 * Read-only post-migration verification.
 *
 *   npx tsx scripts/verify-supabase.ts
 *
 * Confirms — without writing a single row — that the migration produced
 * every object the spec needs:
 *   - 5 tables present (one row each from pg_catalog isn't accessible, so we
 *     count via `select id, count(*) from <table> head:true`).
 *   - private `room-photos` bucket exists.
 *   - `consume_image_quota` plpgsql function exists.
 *
 * Exits non-zero if anything is missing. Read-only against the project.
 */

import { createClient } from '@supabase/supabase-js';

import { loadEnvLocal } from './_load-env';

loadEnvLocal();

const REQUIRED_TABLES = [
  'products',
  'sessions',
  'messages',
  'images',
  'generation_jobs',
] as const;

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function record(name: string, ok: boolean, detail = ''): Check {
  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
  return { name, ok, detail };
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
    process.exit(1);
  }

  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const checks: Check[] = [];

  // 1. Every required table is present.
  for (const table of REQUIRED_TABLES) {
    const { count, error } = await client
      .from(table)
      .select('id', { count: 'exact', head: true });
    if (error) {
      checks.push(record(table, false, error.message));
      continue;
    }
    if (table === 'products') {
      checks.push(record(table, (count ?? 0) >= 30, `rows=${count ?? 0} (target ≥ 30)`));
    } else {
      checks.push(record(table, true, `rows=${count ?? 0}`));
    }
  }

  // 2. Private `room-photos` bucket exists.
  const { data: bucket, error: bucketErr } = await client.storage.getBucket('room-photos');
  if (bucketErr) {
    checks.push(record('room-photos bucket', false, bucketErr.message));
  } else {
    checks.push(
      record(
        'room-photos bucket',
        bucket?.public === false,
        `public=${bucket?.public} name=${bucket?.name}`,
      ),
    );
  }

  // 3. `consume_image_quota` callable. Calling it with an unknown session_id
  //    must return 0 and must not modify anything (the WHERE filters by id,
  //    which doesn't match a UUID that has no row).
  const { data: rpcOk, error: rpcErr } = await client.rpc('consume_image_quota', {
    p_session_id: '00000000-0000-0000-0000-000000000000',
  });
  checks.push(
    record(
      'consume_image_quota',
      !rpcErr && rpcOk === 0,
      rpcErr ? `err=${rpcErr.message}` : `unknown session → 0 (idempotent)`,
    ),
  );

  // 4. Spot-check: that the seeded catalog round-trips.
  const { data: sample, error: sampleErr } = await client
    .from('products')
    .select('id, name_en, price_thb, category')
    .eq('category', 'sofa')
    .order('price_thb', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (sampleErr || !sample) {
    checks.push(record('sample row', false, sampleErr?.message ?? 'no row'));
  } else {
    checks.push(
      record(
        'sample row',
        sample.price_thb > 0 && typeof sample.name_en === 'string',
        `${sample.name_en} (THB ${sample.price_thb})`,
      ),
    );
  }

  // ---- Summary ----
  const failed = checks.filter((c) => !c.ok);
  console.log('');
  console.log(`Total: ${checks.length - failed.length}/${checks.length} OK`);
  if (failed.length > 0) {
    console.error('Failed:');
    for (const f of failed) console.error(`  ✗ ${f.name}: ${f.detail}`);
    process.exit(1);
  }

  console.log('\nSupabase is fully wired. `npm run dev` next.');
}

main().catch((err) => {
  console.error('verify crashed:', err);
  process.exit(1);
});
