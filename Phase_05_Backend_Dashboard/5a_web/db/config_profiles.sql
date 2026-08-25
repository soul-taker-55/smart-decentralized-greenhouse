-- SDIGF migration 004 — 05a tables: config_profiles, server_events, commands
--
-- These three tables do not exist on the live database (confirmed 2026-08-25 via
-- direct query — 0 rows returned for all three names, and \dt lists 11 tables with
-- none of these present). An earlier session record called this "migration 003" —
-- that was wrong. 003 is 003_cfg_src_none.sql and only widens a CHECK constraint.
--
-- Written from MQTT contract v4 (Phase_04_Logging/4b_contracts/mqtt_contract_v4.md),
-- not from the pre-contract draft in db/old/sdigf-db-schema.sql, which defines tables
-- of the same family under a different, superseded shape.
--
-- Safe to run against the live database: this only adds new tables and comments on
-- existing ones. It does not touch telemetry, actuator_state, or edge_events.

BEGIN;

-- ============================================================================
-- 1. CONFIG_PROFILES — one row per config version
-- ============================================================================
--
-- Holds both the editable values (cfg) and the exact signed artifact derived from
-- them (cfg_canonical, cfg_hash). The backend computes and stores cfg_canonical and
-- cfg_hash at creation time using the ONE shared canonicalization implementation —
-- see contract v4 §5 and the frozen test vector. This table never stores a second,
-- independently-derived canonical string; if cfg changes, a new row is created.
--
-- created_by is nullable on purpose: 05a has no auth. 05b fills this in without
-- an ALTER TABLE.

CREATE TABLE config_profiles (
  id              BIGSERIAL PRIMARY KEY,
  gh_id           TEXT NOT NULL DEFAULT 'gh1',
  ver             INT NOT NULL,
  name            TEXT,

  cfg             JSONB NOT NULL,          -- the editable values, contract §4 shape
  cfg_canonical   TEXT NOT NULL,           -- exact string that was/will be hashed+signed
  cfg_hash        TEXT NOT NULL,           -- sha256(cfg_canonical), lowercase hex

  status          TEXT NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN (
                      'DRAFT', 'PROPOSED', 'PARTIALLY_APPROVED', 'APPROVED', 'ACTIVE',
                      'REJECTED', 'EXPIRED', 'SUPERSEDED'
                    )),

  parent_id       BIGINT REFERENCES config_profiles(id),
  ttl_expires_at  TIMESTAMPTZ,

  created_by      TEXT,                    -- NULLABLE — filled in by 05b
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (gh_id, ver)
);

-- Exactly one ACTIVE profile per greenhouse — enforced at the database level, not
-- trusted to application logic. This is the actual gate: even a service-layer bug
-- that tries to activate two profiles at once will fail on this constraint.
CREATE UNIQUE INDEX idx_config_profiles_one_active
  ON config_profiles (gh_id)
  WHERE status = 'ACTIVE';

CREATE INDEX idx_config_profiles_status ON config_profiles (gh_id, status, created_at DESC);

COMMENT ON TABLE config_profiles IS
  'Config versions for 05a. Exactly one ACTIVE row per gh_id, enforced by idx_config_profiles_one_active. cfg_canonical/cfg_hash are computed by the shared canonicalization implementation, never re-derived per-caller.';
COMMENT ON COLUMN config_profiles.created_by IS
  'NULLABLE — no auth in 05a. Filled in by 05b once identity exists.';

-- ============================================================================
-- 2. SERVER_EVENTS — one row per config change or manual command
-- ============================================================================
--
-- actor_id/actor_role are nullable now for the same reason as created_by above.
-- ref_id points at whichever table the event concerns (config_profiles.id or
-- commands.id) — kept generic rather than two nullable FK columns, since exactly
-- one of the two event families applies to any given row.

CREATE TABLE server_events (
  id            BIGSERIAL PRIMARY KEY,
  time          TIMESTAMPTZ NOT NULL DEFAULT now(),
  gh_id         TEXT NOT NULL DEFAULT 'gh1',

  event_type    TEXT NOT NULL CHECK (event_type IN (
                  'CONFIG_CREATED', 'CONFIG_PROPOSED', 'CONFIG_APPROVED',
                  'CONFIG_REJECTED', 'CONFIG_ACTIVATED', 'CONFIG_EXPIRED',
                  'CONFIG_SUPERSEDED', 'COMMAND_ISSUED', 'COMMAND_RELEASED'
                )),

  ref_table     TEXT NOT NULL CHECK (ref_table IN ('config_profiles', 'commands')),
  ref_id        BIGINT NOT NULL,

  actor_id      TEXT,          -- NULLABLE — filled in by 05b
  actor_role    TEXT,          -- NULLABLE — filled in by 05b

  detail        JSONB,         -- free-form context: diff summary, rejection reason, etc.
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_server_events_time ON server_events (time DESC);
CREATE INDEX idx_server_events_ref ON server_events (ref_table, ref_id);

COMMENT ON TABLE server_events IS
  'One row per config change or manual command, from the 05a service layer only. actor_id/actor_role nullable until 05b adds identity.';

-- ============================================================================
-- 3. COMMANDS — manual actuator overrides, matching down/cmd (contract §3.7)
-- ============================================================================
--
-- ttl_s is NOT NULL: contract §3.7 rule 4 — "Required — no unbounded manual
-- overrides." value is used only for action='set' (canopy position); NULL otherwise.
-- Ack fields are populated by the bridge/backend reading up/ack, not guessed here.

CREATE TABLE commands (
  id            TEXT PRIMARY KEY,          -- matches down/cmd's own id field, e.g. "c8f21e"
  gh_id         TEXT NOT NULL DEFAULT 'gh1',
  target        TEXT NOT NULL,             -- actuator key or 'canopy'
  action        TEXT NOT NULL CHECK (action IN ('on', 'off', 'set', 'release')),
  value         INT,                       -- canopy position 0-100; NULL for on/off/release
  ttl_s         INT NOT NULL CHECK (ttl_s > 0),

  issued_by     TEXT,                      -- NULLABLE — filled in by 05b
  issued_role   TEXT,                      -- NULLABLE — filled in by 05b
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Correlation with up/ack, once the edge (or a Stage 2 mock) can send one.
  acked_at      TIMESTAMPTZ,
  ack_result    TEXT CHECK (ack_result IN ('accepted', 'rejected')),
  ack_reason    JSONB
);

CREATE INDEX idx_commands_issued_at ON commands (issued_at DESC);
CREATE INDEX idx_commands_target ON commands (gh_id, target, issued_at DESC);

COMMENT ON TABLE commands IS
  'Manual per-actuator overrides matching down/cmd (contract v4 §3.7). ttl_s is mandatory — no unbounded overrides. Ack fields populated once an edge or Stage 2 mock can publish up/ack.';

-- ============================================================================
-- 4. DEPRECATION MARKERS — pre-contract draft tables, wrong spec
-- ============================================================================
--
-- These six tables are live on this database but were built from a schema draft
-- that predates the frozen contract. Do not build on them, do not drop them without
-- checking for data first (row counts not yet verified as of this migration).

COMMENT ON TABLE users IS
  'DEPRECATED — pre-contract draft schema, wrong spec. 05b will define the real users/keys table. Do not build on this.';
COMMENT ON TABLE ledger IS
  'DEPRECATED — pre-contract draft schema, wrong spec. Phase 07 will define the real hash-chained ledger. Do not build on this.';
COMMENT ON TABLE config_proposals IS
  'DEPRECATED — pre-contract draft schema, superseded by config_profiles (migration 004). Do not build on this.';
COMMENT ON TABLE config_approvals IS
  'DEPRECATED — pre-contract draft schema. M-of-N approval will be modeled in 05b against config_profiles. Do not build on this.';
COMMENT ON TABLE config_history IS
  'DEPRECATED — pre-contract draft schema, superseded by config_profiles status lifecycle + server_events. Do not build on this.';
COMMENT ON TABLE mqtt_retained_messages IS
  'DEPRECATED — pre-contract draft schema. Retained messages are broker state and are never treated as source of truth (see server_tier_journal.md §5); the backend reconstructs from config_profiles instead. Do not build on this.';

COMMIT;

-- ============================================================================
-- VERIFY
-- ============================================================================
-- \d config_profiles
-- \d server_events
-- \d commands
--
-- -- Confirm the one-active-per-greenhouse constraint works:
-- INSERT INTO config_profiles (gh_id, ver, cfg, cfg_canonical, cfg_hash, status)
--   VALUES ('gh1', 1, '{}', '{}', 'test1', 'ACTIVE');
-- INSERT INTO config_profiles (gh_id, ver, cfg, cfg_canonical, cfg_hash, status)
--   VALUES ('gh1', 2, '{}', '{}', 'test2', 'ACTIVE');
-- -- second insert must fail with a unique-violation on idx_config_profiles_one_active
--
-- -- Then clean up the test rows:
-- DELETE FROM config_profiles WHERE gh_id = 'gh1' AND cfg_hash IN ('test1','test2');
