/**
 * One-off probe. Confirms URL + service-role key against the live project
 * without applying the migration or writing any rows.
 *
 *   npx tsx scripts/probe-supabase.ts
 */

import { createClient } from '@supabase/supabase-js';

import { requireEnv } from '../lib/env';

async function main(): Promise<void> {
  // Force-load the env vars from .env.local so this works without `npm run`.
  await import('./_load-env').then((m) => m.loadEnvLocal());

  const url = requireEnv('SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  console.log(`URL = ${url}`);
  console.log(`service-role key = ${serviceRoleKey.slice(0, 12)}…${serviceRoleKey.slice(-4)} (length ${serviceRoleKey.length})`);

  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // `head: true` returns only the count, no rows. A 200 with count 0 means the
  // table doesn't exist yet (migration needed). Any other error = bad creds/URL.
  const { count, error } = await client
    .from('products')
    .select('id', { count: 'exact', head: true });

  if (error) {
    console.error('Probe failed:');
    console.error(`  code=${'code' in error ? error.code : '(none)'}`);
    console.error(`  message=${error.message}`);
    if (/Invalid API/i.test(error.message) || /JWT/i.test(error.message)) {
      console.error('  → looks like the URL is wrong or the key is rejected. Check Project URL.');
    } else if (/relation .* does not exist/i.test(error.message)) {
      console.error('  → auth looks good. Now run the migration in SQL editor.');
    }
    process.exit(1);
  }

  console.log(`Probe OK — `);
  console.log(`  products row count = ${count ?? 0}`);
  console.log(`  (0 here is expected: the migration has not been applied yet)`);
}

main().catch((err) => {
  console.error('probe crashed:', err);
  process.exit(1);
});
