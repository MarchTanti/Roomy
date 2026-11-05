-- ===========================================================================
-- RoomyAI Project — 0003_auth.sql
--
-- Run this after 0001_init.sql and 0002_retention.sql, in the SQL editor.
-- The app works without it — chat, guests and everything else — but the
-- sign-in page will say that the account tables are not ready yet.
--
-- What it adds:
--
--   users          the accounts, whoever holds them
--   auth_sessions  the signed-in sessions (a token's hash, not the token)
--   sessions.user_id  which account a chat session belongs to
--
-- Who may read these rows: nobody but the server. The service role bypasses
-- RLS by design — that is what it is for — and the anon key gets nothing,
-- because there are no policies at all on the two new tables.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- users
--
-- One row per person. `provider` says where the account actually lives:
--
--   'local'     we hashed the password ourselves (scrypt) and store it here
--   'supabase'  Supabase Auth holds the password; this row is our mirror of
--               the account, keyed by `provider_id`
--
-- The email is unique, so one address is one account across both worlds.
-- ---------------------------------------------------------------------------
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  display_name  text,
  provider      text not null check (provider in ('local', 'supabase')),
  provider_id   text,
  password_hash text,
  created_at    timestamptz not null default now()
);

-- Looking an account up by the provider's own id is the hot path when
-- Supabase Auth is the one in use.
create unique index if not exists users_provider_idx
  on users (provider, provider_id)
  where provider_id is not null;

-- ---------------------------------------------------------------------------
-- auth_sessions
--
-- A signed-in session. The browser holds the token; the database holds its
-- SHA-256. A copy of this table is therefore useless to anyone who gets hold
-- of it — there is nothing in it that can be signed in with.
--
-- `revoked_at` is what "sign out" writes. Deleting the row would work too,
-- but keeping it makes it possible to see that a session existed and when it
-- was ended.
-- ---------------------------------------------------------------------------
create table if not exists auth_sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

-- The lookup is always "the token hash", so this is the index that matters.
create index if not exists auth_sessions_user_idx on auth_sessions (user_id);

-- ---------------------------------------------------------------------------
-- sessions.user_id
--
-- Which account a chat session belongs to. Null means a guest session: it is
-- not in anybody's history, and the retention sweep removes it like any other.
--
-- `on delete set null` rather than `cascade`: deleting an account must not
-- delete somebody's conversations on its own. The history page then shows the
-- conversation without an owner, which is better than losing it.
-- ---------------------------------------------------------------------------
alter table sessions add column if not exists user_id uuid references users(id) on delete set null;

-- The history page asks for one account's sessions, newest first.
create index if not exists sessions_user_idx on sessions (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row-level security
--
-- RLS is on and there are no policies, which means: with the anon key (or any
-- other non-service role) these tables return nothing at all — not an error,
-- just no rows. The service role, which the server adapter uses, bypasses RLS
-- and does the real work in application code.
--
-- The account tables are the ones place where "the browser key can read this"
-- would be a real leak: a row holds an email address, and `users` holds
-- password hashes.
-- ---------------------------------------------------------------------------
alter table users         enable row level security;
alter table auth_sessions enable row level security;

drop policy if exists users_read on users;
drop policy if exists auth_sessions_read on auth_sessions;

-- ---------------------------------------------------------------------------
-- A note on `sessions.user_id` and RLS
--
-- The `sessions_own` policy from 0001 still applies: a row is visible only to
-- the session that owns it, and that is decided by the `app.session_id` GUC.
-- The new column does not change that. A signed-in account reaches its own
-- sessions through the service role on the server, never from the browser.
-- ---------------------------------------------------------------------------
