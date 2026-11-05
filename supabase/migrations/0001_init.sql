-- ===========================================================================
-- RoomyAI Project — 0001_init.sql
--
-- Apply with the Supabase CLI (`supabase db push`) or paste into the SQL editor.
--
-- Conventions: every dimension is centimetres, every price is THB.
-- `products` is global. Every other table is scoped by `session_id` and carries
-- RLS policies so a leaked browser key cannot read another session's rows.
-- ===========================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- products (global, not session-scoped)
-- ---------------------------------------------------------------------------
create table if not exists products (
  id          text primary key,
  source      text not null check (source in ('ikea', 'homepro', 'manual')),
  source_url  text not null,
  name_th     text,
  name_en     text not null,
  category    text not null,
  style_tags  text[] not null default '{}',
  color       text,
  material    text,
  price_thb   numeric not null check (price_thb >= 0),
  width_cm    numeric not null check (width_cm  > 0),
  depth_cm    numeric not null check (depth_cm  > 0),
  height_cm   numeric not null check (height_cm > 0),
  image_url   text not null,
  in_stock    boolean not null default true
);

-- searchFurniture filters on category, style_tags, price and in_stock.
create index if not exists products_category_idx on products (category);
create index if not exists products_price_idx    on products (price_thb);
create index if not exists products_style_idx    on products using gin (style_tags);

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
create table if not exists sessions (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  state            jsonb not null default '{}'::jsonb,
  image_quota_left int not null default 10
);

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------
create table if not exists messages (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  role       text not null check (role in ('user', 'assistant', 'tool')),
  content    jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists messages_session_idx on messages (session_id, created_at);

-- The column default above is '{}', which does not match the shape
-- `emptySessionState()` produces in lib/db/types.ts. A row created outside the
-- app would then be missing eight of the nine fields. Align the default with
-- the code so both sides agree. Re-running this file is safe.
alter table sessions alter column state set default $json$
  {
    "room_image_id": null,
    "room_analysis": null,
    "preferences": { "style": null, "budget_thb": null, "category": null },
    "reference_cm": null,
    "reference_line": null,
    "selected_area": null,
    "shown_products": [],
    "selected_product_id": null,
    "generated_image_ids": []
  }
$json$::jsonb;

-- ---------------------------------------------------------------------------
-- images
-- ---------------------------------------------------------------------------
create table if not exists images (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references sessions(id) on delete cascade,
  kind         text not null check (kind in ('room', 'generated')),
  storage_path text not null,
  product_id   text references products(id) on delete set null,
  area         jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists images_session_idx on images (session_id, created_at);

-- ---------------------------------------------------------------------------
-- generation_jobs
-- ---------------------------------------------------------------------------
create table if not exists generation_jobs (
  id               uuid primary key default gen_random_uuid(),
  session_id       uuid not null references sessions(id) on delete cascade,
  status           text not null default 'queued'
                     check (status in ('queued', 'running', 'done', 'failed')),
  room_image_id    uuid references images(id) on delete set null,
  product_id       text references products(id) on delete set null,
  area             jsonb not null,
  result_image_id  uuid references images(id) on delete set null,
  error            text,
  created_at       timestamptz not null default now()
);

create index if not exists jobs_session_idx on generation_jobs (session_id, created_at);
create index if not exists jobs_status_idx  on generation_jobs (status);

-- ---------------------------------------------------------------------------
-- Atomic image quota
--
-- generatePlacement calls this. Doing the read-then-write in application code
-- would let two concurrent requests both pass the "is there quota left?" check.
-- ---------------------------------------------------------------------------
create or replace function consume_image_quota(p_session_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_left int;
begin
  update sessions
     set image_quota_left = image_quota_left - 1
   where id = p_session_id
     and image_quota_left > 0
  returning image_quota_left into v_left;

  if v_left is null then
    -- No row updated: unknown session, or the quota was already spent.
    select 0 into v_left;
  end if;

  return v_left;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
--
-- The server adapter uses the SERVICE ROLE key, which bypasses RLS — it already
-- scopes every query by session_id in application code. These policies are the
-- second line of defence for anything holding the anon/browser key: without
-- the `app.session_id` GUC set, the session-scoped tables return nothing.
-- ---------------------------------------------------------------------------

create or replace function current_session_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.session_id', true), '')::uuid
$$;

alter table products           enable row level security;
alter table sessions           enable row level security;
alter table messages           enable row level security;
alter table images             enable row level security;
alter table generation_jobs    enable row level security;

-- The catalog is public to read; only the service role may write it.
drop policy if exists products_read on products;
create policy products_read on products
  for select
  using (true);

-- Everything below is visible only to the session that owns it.
drop policy if exists sessions_own on sessions;
create policy sessions_own on sessions
  for all
  using (id = current_session_id())
  with check (id = current_session_id());

drop policy if exists messages_own on messages;
create policy messages_own on messages
  for all
  using (session_id = current_session_id())
  with check (session_id = current_session_id());

drop policy if exists images_own on images;
create policy images_own on images
  for all
  using (session_id = current_session_id())
  with check (session_id = current_session_id());

drop policy if exists jobs_own on generation_jobs;
create policy jobs_own on generation_jobs
  for all
  using (session_id = current_session_id())
  with check (session_id = current_session_id());

-- ---------------------------------------------------------------------------
-- Private storage bucket for room photos
--
-- Object keys are "<session_id>/<image_id>.jpg" so the RLS policy can key off
-- the first path segment.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('room-photos', 'room-photos', false)
on conflict (id) do nothing;

drop policy if exists room_photos_read on storage.objects;
create policy room_photos_read on storage.objects
  for select
  using (
    bucket_id = 'room-photos'
    and (storage.foldername(name))[1] = current_session_id()::text
  );

drop policy if exists room_photos_insert on storage.objects;
create policy room_photos_insert on storage.objects
  for insert
  with check (
    bucket_id = 'room-photos'
    and (storage.foldername(name))[1] = current_session_id()::text
  );

drop policy if exists room_photos_delete on storage.objects;
create policy room_photos_delete on storage.objects
  for delete
  using (
    bucket_id = 'room-photos'
    and (storage.foldername(name))[1] = current_session_id()::text
  );

-- ---------------------------------------------------------------------------
-- 7-day retention
--
-- Schedule with pg_cron (daily). Rows cascade; storage objects are removed in
-- the same transaction by listing the bucket prefix first.
-- ---------------------------------------------------------------------------
create or replace function delete_expired_sessions(p_days int default 7)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted int;
begin
  delete from storage.objects
   where bucket_id = 'room-photos'
     and (storage.foldername(name))[1] in (
       select id::text from sessions where created_at < now() - make_interval(days => p_days)
     );

  delete from sessions
   where created_at < now() - make_interval(days => p_days);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;