-- ---------------------------------------------------------------------------
-- RoomyAI — retention helpers, locked down
--
-- Run this after 0001_init.sql, in the SQL editor:
--
--   supabase/migrations/0002_retention.sql
--
-- It changes no table and no column. It only fixes who may run the two
-- SECURITY DEFINER functions that 0001 created.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Why this file exists
--
-- In Postgres, `create function` grants EXECUTE to PUBLIC by default. Both of
-- these functions are SECURITY DEFINER, so they run with the privileges of
-- their owner and ignore the RLS policies on the tables:
--
--   consume_image_quota(uuid)      decrements the quota of ANY session
--   delete_expired_sessions(int)   deletes EVERY session older than N days
--
-- With the default grant, any role that can reach the database — `anon` and
-- `authenticated` included, since the anon key is meant to be public — could
-- call them. A quota someone else can spend for you is a nuisance; a sweep
-- someone else can run is a data-loss bug.
--
-- The service role is the only role that needs them: the server adapter calls
-- them with the service-role key, and the app's own cleanup path does the
-- deletion in application code (see lib/session/purge.ts).
-- ---------------------------------------------------------------------------

revoke execute on function public.consume_image_quota(uuid) from public;
revoke execute on function public.delete_expired_sessions(integer) from public;

grant execute on function public.consume_image_quota(uuid) to service_role;
grant execute on function public.delete_expired_sessions(integer) to service_role;

-- ---------------------------------------------------------------------------
-- A note on what the SQL sweep can and cannot do
--
-- `delete_expired_sessions()` deletes the rows in `storage.objects` — the
-- *metadata* of the photos — but not the objects in the bucket itself. The
-- files stay in storage until something calls the Storage API.
--
-- The app's own cleanup (`npm run cleanup`, or POST /api/cleanup) removes the
-- real files first and the rows second, so the bucket does not keep the
-- pictures. Use that one in production; the SQL helper is kept for a database
-- that wants a pg_cron schedule, and then it is only a safety net for the
-- rows.
-- ---------------------------------------------------------------------------
