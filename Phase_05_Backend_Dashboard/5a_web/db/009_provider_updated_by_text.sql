-- SDIGF Phase 05c — db/009_provider_updated_by_text.sql
--
-- Correction to 007. Runs against sdigf_backend, after 008.
--
-- "009" is the NINTH FILE IN THIS DIRECTORY (see migration-note.txt).
--
-- WHAT WAS WRONG
-- 007 declared provider_settings.updated_by as UUID. users.id is TEXT
-- (003_auth.sql), and every other attribution column in this schema —
-- server_events.actor_id, commands.issued_by, config_profiles.created_by —
-- is TEXT to match. The status query joins users on updated_by and Postgres
-- correctly refused "text = uuid". Caught by the first live GET /api/provider
-- returning 500; the column type was assumed, not read.
--
-- The table is empty at this point (no key has been stored yet), so the
-- type change carries no data and cannot fail on a cast.

BEGIN;

ALTER TABLE provider_settings
  ALTER COLUMN updated_by TYPE TEXT USING updated_by::text;

COMMENT ON COLUMN provider_settings.updated_by IS
  'users.id of the dashboard administrator who last set or rotated the key. TEXT to match users.id. No FK, same reasoning as commands.issued_by.';

COMMIT;

-- VERIFY
-- SELECT data_type FROM information_schema.columns
--  WHERE table_name = 'provider_settings' AND column_name = 'updated_by';
-- -- text
