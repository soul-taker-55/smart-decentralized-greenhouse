-- SDIGF migration 003 — allow cfg_src = 'none'
--
-- Contract v4 §3.3 defines three values for cfg.src:
--
--   mqtt  received from the server
--   nvs   last-known-good restored after a restart with no broker
--   none  never received a config — running compiled-in defaults
--
-- The original CHECK permitted only the first two. The bridge therefore mapped
-- 'none' to NULL before the constraint ever saw it, which is why nothing ever
-- errored — and why every first-boot health message has been silently losing
-- this field.
--
-- That matters because cfg_src is the field the thesis leans on to demonstrate
-- edge autonomy. NULL cannot distinguish "device has never been configured"
-- from "the field was malformed or absent", and the first-boot case is exactly
-- where the autonomy argument is most visible.
--
-- Safe to run against the live database: this widens an accepted set, it does
-- not narrow one, so no existing row can be invalidated.

BEGIN;

ALTER TABLE edge_events DROP CONSTRAINT IF EXISTS edge_events_cfg_src_check;

ALTER TABLE edge_events ADD CONSTRAINT edge_events_cfg_src_check
  CHECK (cfg_src IN ('mqtt', 'nvs', 'none'));

COMMENT ON COLUMN edge_events.cfg_src IS
  'mqtt = received from server; nvs = last-known-good after restart with no broker '
  '(direct evidence of edge autonomy); none = never configured, running compiled-in defaults.';

COMMIT;

-- Verify:
--   \d edge_events
-- The constraint should now read: cfg_src = ANY (ARRAY['mqtt','nvs','none'])
--
-- Historical rows are NOT backfilled. Health messages written before this
-- migration have cfg_src = NULL with the true value still present in the
-- payload JSONB. They can be recovered if ever needed with:
--
--   UPDATE edge_events
--      SET cfg_src = payload->'cfg'->>'src'
--    WHERE cfg_src IS NULL
--      AND payload->'cfg'->>'src' IN ('mqtt','nvs','none');
--
-- Left as a comment rather than executed: the affected rows are infrastructure
-- verification data, not the thesis dataset, and rewriting history in a table
-- that feeds an integrity argument is a habit worth not forming.
