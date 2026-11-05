/**
 * The retention sweep, from the command line. `npm run cleanup`
 *
 * The same purge the HTTP endpoint runs, without the secret check: this runs
 * on the machine that holds the credentials, so there is nothing to authorise.
 * Point a cron job at it, or run it by hand.
 */

import { settings } from '../lib/env';
import { getDb } from '../lib/db';
import { purgeExpiredSessions } from '../lib/session/purge';
import { getPhotoStore } from '../lib/storage/store';
import { loadEnvLocal } from './_load-env';

loadEnvLocal();

async function main(): Promise<void> {
  const days = settings.retentionDays();
  const result = await purgeExpiredSessions(getDb(), days, getPhotoStore());

  console.log(
    `[cleanup] kept ${days} days — removed ${result.sessions_deleted} session(s) and ` +
      `${result.photos_deleted} photo(s)`,
  );

  for (const failure of result.failures) {
    console.error(`[cleanup] could not purge session ${failure.session_id}: ${failure.error}`);
  }

  // A failed session is a real problem: its photos are still there. Say so in
  // the exit code, so a cron job notices.
  if (result.failures.length > 0) process.exitCode = 1;
}

void main();
