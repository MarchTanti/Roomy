-- ---------------------------------------------------------------------------
-- RoomyAI — the session state, with the room that was designed
--
-- Run this after 0001_init.sql, in the SQL editor:
--
--   supabase/migrations/0005_session_state_design_brief.sql
--
-- It changes no table and no column. It only realigns the default of one
-- column.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Why this file exists
--
-- The assistant can now design a room, not only place one piece of furniture.
-- The brief of that room — the style, the colours, the size the user gave,
-- and which catalogue row answered each request — is kept in the session, so
-- that "เปลี่ยนเป็นสีฟ้า" has a room to change.
--
-- That brief is a tenth field of `sessions.state`. `0001_init.sql` sets the
-- column's default to the nine fields of the spec, so a row created outside
-- the app — or a row created before this file ran — arrives without it.
--
-- The application does not depend on the default: both adapters normalise
-- the state on read, and a missing `design_brief` simply means "no room has
-- been designed yet". This file makes the database agree with the shape the
-- code writes, so a row created by hand, by a script, or by an older version
-- of the app is the same shape as one the app made.
--
-- Re-running this file is safe.
-- ---------------------------------------------------------------------------

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
    "generated_image_ids": [],
    "design_brief": null
  }
$json$::jsonb;

-- ---------------------------------------------------------------------------
-- After this, the default reads:
--
--   select column_default
--     from information_schema.columns
--    where table_name = 'sessions' and column_name = 'state';
--
-- Rows that already exist keep the state they have. The application fills a
-- missing `design_brief` with null when it reads them, so no row needs
-- updating for the feature to work.
-- ---------------------------------------------------------------------------
