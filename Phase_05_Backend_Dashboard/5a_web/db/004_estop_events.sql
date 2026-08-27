-- SDIGF Phase 05b — db/004_estop_events.sql
--
-- Allows ESTOP_TRIGGERED and ESTOP_CLEARED in server_events.
--
-- Runs against sdigf_backend, after 003.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- server_events.event_type carries a CHECK constraint listing every event the
-- system may record. Emergency stop was specified after that list was written,
-- so the first attempt to record one failed with a constraint violation and the
-- route returned a 500.
--
-- That is the constraint working correctly. A schema that accepted any string
-- would have taken the row silently, and the audit trail would have grown an
-- event type nobody had declared — which is exactly the kind of drift a
-- tamper-evident log cannot tolerate, because Phase 07 chains these rows and
-- has to know what it is chaining.
--
-- The alternative to a closed list is an open one, and it is worse here. This
-- table is the narrative half of the ledger; an unconstrained event_type means
-- a typo produces a new category rather than an error, and counting events by
-- type for the thesis silently under-reports.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ref_table IS ALSO WIDENED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- An emergency stop references no row in config_profiles or commands — it is a
-- greenhouse-wide state change with no target. Recording it against
-- config_profiles with ref_id 0, as the estop service currently does, is a
-- dishonest pointer: it names a table the event has nothing to do with.
--
-- 'none' is added so an event with no referent can say so, rather than pointing
-- somewhere arbitrary and leaving a future reader to work out that ref_id 0
-- means "ignore this field".

BEGIN;

-- ── event_type ──────────────────────────────────────────────────────────────

ALTER TABLE server_events DROP CONSTRAINT IF EXISTS server_events_event_type_check;

ALTER TABLE server_events ADD CONSTRAINT server_events_event_type_check
  CHECK (event_type IN (
    'CONFIG_CREATED',
    'CONFIG_PROPOSED',
    'CONFIG_APPROVED',
    'CONFIG_REJECTED',
    'CONFIG_ACTIVATED',
    'CONFIG_EXPIRED',
    'CONFIG_SUPERSEDED',
    'COMMAND_ISSUED',
    'COMMAND_RELEASED',
    -- Contract v4 §3.9. Trigger and clear are recorded as SEPARATE types
    -- rather than one ESTOP event with a state field, because they carry
    -- different authority — a farmer may trigger, only an engineer may clear —
    -- and an audit query asking "who has ever cleared a stop" should not have
    -- to filter on a JSON field to find out.
    'ESTOP_TRIGGERED',
    'ESTOP_CLEARED',
    -- Key and policy changes were being recorded as CONFIG_CREATED with a
    -- `kind` discriminator buried in detail — legible to code, invisible to
    -- anyone reading the trail. Named properly now.
    'KEY_REGISTERED',
    'KEY_REVOKED',
    -- Lowering the approval threshold converts a multi-signature system into a
    -- single-signature one. That deserves its own event type, not a variant of
    -- something else.
    'APPROVAL_POLICY_CHANGED'
  ));

-- ── ref_table ───────────────────────────────────────────────────────────────

ALTER TABLE server_events DROP CONSTRAINT IF EXISTS server_events_ref_table_check;

ALTER TABLE server_events ADD CONSTRAINT server_events_ref_table_check
  CHECK (ref_table IN ('config_profiles', 'commands', 'user_keys', 'none'));

COMMENT ON COLUMN server_events.event_type IS
  'Closed list, deliberately. Phase 07 chains these rows and must know what it is chaining; an open column would let a typo create a category rather than raise an error.';
COMMENT ON COLUMN server_events.ref_table IS
  'Which table ref_id points into, or ''none'' for greenhouse-wide events such as an emergency stop that reference no row.';

COMMIT;

-- ============================================================================
-- VERIFY
-- ============================================================================
-- INSERT INTO server_events (gh_id, event_type, ref_table, ref_id, detail)
--   VALUES ('gh1','ESTOP_TRIGGERED','none',0,'{"seq":1,"state":"stopped"}');
-- -- must succeed
--
-- INSERT INTO server_events (gh_id, event_type, ref_table, ref_id)
--   VALUES ('gh1','ESTOP_TRIGGERD','none',0);
-- -- must fail: a typo is an error, not a new category
