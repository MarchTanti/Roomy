-- ---------------------------------------------------------------------------
-- RoomyAI — the two product references, with their delete rule
--
-- Run this after 0001_init.sql, in the SQL editor:
--
--   supabase/migrations/0004_product_fk_set_null.sql
--
-- It changes no table and no column. It only rebuilds two foreign keys.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Why this file exists
--
-- `0001_init.sql` creates `images.product_id` and `generation_jobs.product_id`
-- as `references products(id) on delete set null`. That rule is the point:
-- the catalogue can be replaced, and an image that was placed against a piece
-- of furniture must survive the piece being removed.
--
-- A database created from an earlier version of `0001_init.sql` has the plain
-- `references products(id)` rule instead, which Postgres reads as ON DELETE
-- NO ACTION. The seed then fails with
--
--   update or delete on table "products" violates foreign key constraint
--   "images_product_id_fkey" on table "images"
--
-- and the catalogue cannot be replaced at all. This puts the rule back.
--
-- The application no longer depends on it: `deleteProductsExcept` clears the
-- two references itself before deleting the products, so the seed works
-- against a database with either rule. This file makes the database agree
-- with the schema it is supposed to have, so that anything else which relies
-- on the rule — a hand-written delete, a future migration — behaves the way
-- the rest of the project expects.
-- ---------------------------------------------------------------------------

-- The columns have to be able to hold null for ON DELETE SET NULL to work.
-- These are no-ops on a database that already has them nullable.
alter table images alter column product_id drop not null;
alter table generation_jobs alter column product_id drop not null;

-- Dropping and re-adding is how a delete rule is changed in Postgres — there
-- is no `alter constraint ... on delete` syntax.
alter table images drop constraint if exists images_product_id_fkey;
alter table images
  add constraint images_product_id_fkey
  foreign key (product_id) references products(id) on delete set null;

alter table generation_jobs drop constraint if exists generation_jobs_product_id_fkey;
alter table generation_jobs
  add constraint generation_jobs_product_id_fkey
  foreign key (product_id) references products(id) on delete set null;

-- ---------------------------------------------------------------------------
-- After this, the two constraints read:
--
--   select conname, confdeltype
--     from pg_constraint
--    where conname in ('images_product_id_fkey', 'generation_jobs_product_id_fkey');
--
-- `confdeltype` = 'n' means NO ACTION, 'c' means CASCADE, 'd' means SET NULL.
-- Both rows should read 'd'.
-- ---------------------------------------------------------------------------
