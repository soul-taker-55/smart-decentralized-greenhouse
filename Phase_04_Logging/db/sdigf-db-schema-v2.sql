-- SDIGF — Migration 002
-- Aligns the Phase 04 schema with the frozen MQTT contract v1,
-- and adds the retention-immune telemetry archive.
--
-- Safe to run as-is: the database currently holds no telemetry, so the
-- telemetry hypertable is dropped and recreated rather than altered.
-- Run this BEFORE building the 04d bridge and BEFORE collecting any data
-- intended for the thesis.

BEGIN;

-- ============================================================================
-- 1. TELEMETRY — rebuilt to match the contract
-- ============================================================================
--
-- Five mismatches with the frozen contract, all fixed here:
--
--   (a) value was NOT NULL. The contract's null rule states that when q is
--       'fail' or 'init', val is ALWAYS null — never 0, never a sentinel like
--       -127. A NOT NULL column makes a failed reading unstorable, which would
--       have forced the bridge to either invent a value or silently drop the
--       row. Both destroy the record of the failure itself.
--
--   (b) quality_flag allowed ('OK','STALE','ERROR'). The contract defines
--       lowercase 'ok','stale','fail','init'. 'init' has no equivalent at all,
--       and it is not decorative: a DHT11 needs seconds before its first read,
--       so without it "broken" and "not yet asked" are indistinguishable.
--
--   (c) No seq column. The contract mandates deduplication on
--       (greenhouse_id, seq, sensor_name) — impossible without storing seq.
--
--   (d) No separation of device time from server receive time. The contract's
--       tsq field distinguishes NTP-synced timestamps from seconds-since-boot.
--       An ESP32 without NTP reports boot-relative time, which is meaningless
--       as wall clock. Storing only one timestamp discards the ability to tell
--       which kind it was.
--
--   (e) No unit-of-record for reboots. seq resets to 0 on restart, so a
--       decreasing seq is a reboot, not a duplicate — the bridge must be able
--       to record that distinction.

DROP TABLE IF EXISTS telemetry CASCADE;

CREATE TABLE telemetry (
  time          TIMESTAMPTZ NOT NULL,   -- server receive time; always trustworthy
  device_ts     BIGINT,                 -- device-reported epoch or seconds-since-boot
  ts_quality    TEXT NOT NULL DEFAULT 'ntp'
                  CHECK (ts_quality IN ('ntp', 'boot')),
  greenhouse_id TEXT NOT NULL DEFAULT 'gh1',
  seq           BIGINT NOT NULL,
  sensor_name   TEXT NOT NULL,
  value         DOUBLE PRECISION,       -- NULL when quality_flag is 'fail' or 'init'
  unit          TEXT,
  quality_flag  TEXT NOT NULL DEFAULT 'ok'
                  CHECK (quality_flag IN ('ok', 'stale', 'fail', 'init')),

  -- The null rule, enforced in the database rather than trusted to the bridge.
  -- A bridge bug that writes 0 for a failed sensor would otherwise be invisible
  -- and would quietly corrupt every average computed afterwards.
  CONSTRAINT null_rule CHECK (
    (quality_flag IN ('fail', 'init') AND value IS NULL)
    OR
    (quality_flag IN ('ok', 'stale')  AND value IS NOT NULL)
  )
);

SELECT create_hypertable('telemetry', 'time', if_not_exists => TRUE);

-- Deduplication. TimescaleDB requires any unique index on a hypertable to
-- include the partitioning column, hence 'time' leads. This is not a
-- limitation here: a redelivered QoS 1 message or a republication after
-- reconnect carries the same device timestamp, so genuine duplicates collide
-- on every column in this key.
--
-- The bridge should INSERT ... ON CONFLICT DO NOTHING and treat the conflict
-- as expected traffic, not an error.
CREATE UNIQUE INDEX idx_telemetry_dedup
  ON telemetry (time, greenhouse_id, sensor_name, seq);

CREATE INDEX idx_telemetry_greenhouse_sensor
  ON telemetry (greenhouse_id, sensor_name, time DESC);
CREATE INDEX idx_telemetry_time ON telemetry (time DESC);

ALTER TABLE telemetry SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'greenhouse_id,sensor_name',
  timescaledb.compress_orderby   = 'time DESC'
);

-- Compression after 24h rather than 1h. Late-arriving messages after a
-- reconnect would otherwise land in an already-compressed chunk.
SELECT add_compression_policy('telemetry', INTERVAL '24 hours', if_not_exists => TRUE);
SELECT add_retention_policy('telemetry', INTERVAL '90 days', if_not_exists => TRUE);

COMMENT ON TABLE telemetry IS
  'Live sensor readings. 90-day retention, compressed after 24h. This is operational data — the thesis dataset lives in telemetry_archive.';
COMMENT ON COLUMN telemetry.time IS
  'Server receive time. Always usable for ordering, unlike device_ts.';
COMMENT ON COLUMN telemetry.ts_quality IS
  'ntp = device_ts is epoch seconds; boot = device_ts is seconds since boot and meaningless as wall clock.';

-- ============================================================================
-- 2. ACTUATOR STATE — new table, and the reason Phase 04 exists
-- ============================================================================
--
-- The original schema had no actuator table. That is not a small gap: the
-- stated done-condition for Phase 04 is that the conflict-frequency question
-- can be answered from stored data, and both conflicts are defined by actuator
-- behaviour.
--
--   Conflict A — fans (cooling, but exhausting humidity) against the
--                humidifier. Measuring this requires knowing when each was on.
--   Conflict B — canopy shading against the photoperiod window.
--
-- Sensor readings alone cannot answer either. Without this table the bridge
-- would store telemetry perfectly and still leave Phase 08 an assumption
-- rather than a finding.

CREATE TABLE actuator_state (
  time          TIMESTAMPTZ NOT NULL,
  device_ts     BIGINT,
  greenhouse_id TEXT NOT NULL DEFAULT 'gh1',
  seq           BIGINT NOT NULL,
  actuator      TEXT NOT NULL,          -- pump, s_fan, internal_fan, n_fan,
                                        -- humidifier, lights, grow_light, canopy
  is_on         BOOLEAN,                -- NULL for canopy, which is positional
  position_pct  INT CHECK (position_pct BETWEEN 0 AND 100),  -- canopy only
  src           TEXT NOT NULL DEFAULT 'auto'
                  CHECK (src IN ('auto', 'manual', 'safety')),
  for_s         INT,                    -- seconds held in current state
  ovr_s         INT,                    -- manual override seconds remaining
  vent_stage    INT CHECK (vent_stage BETWEEN 0 AND 3)
);

SELECT create_hypertable('actuator_state', 'time', if_not_exists => TRUE);

CREATE UNIQUE INDEX idx_actuator_dedup
  ON actuator_state (time, greenhouse_id, actuator, seq);

CREATE INDEX idx_actuator_lookup
  ON actuator_state (greenhouse_id, actuator, time DESC);

-- src = 'safety' marks every point where the firmware envelope overrode both
-- the control loop and any operator command. These rows are the direct
-- evidence for the edge-autonomy argument, so they are worth finding quickly.
CREATE INDEX idx_actuator_safety
  ON actuator_state (time DESC) WHERE src = 'safety';

ALTER TABLE actuator_state SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'greenhouse_id,actuator',
  timescaledb.compress_orderby   = 'time DESC'
);
SELECT add_compression_policy('actuator_state', INTERVAL '24 hours', if_not_exists => TRUE);
SELECT add_retention_policy('actuator_state', INTERVAL '90 days', if_not_exists => TRUE);

COMMENT ON TABLE actuator_state IS
  'Actuator state over time. Required for conflict-frequency analysis; sensor data alone cannot answer whether fans and humidifier opposed each other.';

-- ============================================================================
-- 3. EDGE EVENTS — health, status, reboots
-- ============================================================================
--
-- Low volume, high diagnostic value. cfg_src is the one field that empirically
-- demonstrates edge autonomy: when it reads 'nvs', the edge is running on its
-- own stored configuration with no server involvement. That is the project's
-- central claim, observable rather than asserted.

CREATE TABLE edge_events (
  id            BIGSERIAL PRIMARY KEY,
  time          TIMESTAMPTZ NOT NULL DEFAULT now(),
  greenhouse_id TEXT NOT NULL DEFAULT 'gh1',
  event_type    TEXT NOT NULL CHECK (event_type IN (
                  'ONLINE', 'OFFLINE', 'HEALTH', 'REBOOT', 'ACK', 'CONFIG_APPLIED'
                )),
  seq           BIGINT,
  boot_reason   TEXT,          -- power_on | watchdog | panic | brownout | sw_reset
  cfg_src       TEXT CHECK (cfg_src IN ('mqtt', 'nvs')),
  cfg_ver       INT,
  cfg_hash      TEXT,
  payload       JSONB,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_edge_events_time ON edge_events (time DESC);
CREATE INDEX idx_edge_events_type ON edge_events (event_type, time DESC);

COMMENT ON TABLE edge_events IS
  'Health, connection state, reboots and config acks. cfg_src = nvs is direct evidence of edge autonomy.';

-- ============================================================================
-- 4. TELEMETRY ARCHIVE — the thesis dataset
-- ============================================================================
--
-- Plain tables, not hypertables: no compression policy, no retention policy,
-- nothing scheduled that can remove rows. The live tables above are
-- operational data governed by policy; these are evidence, governed by
-- nothing.
--
-- The distinction matters beyond convenience. If the thesis dataset lived in a
-- table with a retention policy attached, a single configuration change months
-- from now could delete the observations an argument rests on, silently and
-- with no error. Separating them makes that impossible rather than merely
-- unlikely.

CREATE TABLE telemetry_archive (
  LIKE telemetry INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_telemetry_archive_dedup
  ON telemetry_archive (time, greenhouse_id, sensor_name, seq);
CREATE INDEX idx_telemetry_archive_lookup
  ON telemetry_archive (greenhouse_id, sensor_name, time DESC);

CREATE TABLE actuator_state_archive (
  LIKE actuator_state INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_actuator_archive_dedup
  ON actuator_state_archive (time, greenhouse_id, actuator, seq);
CREATE INDEX idx_actuator_archive_lookup
  ON actuator_state_archive (greenhouse_id, actuator, time DESC);

COMMENT ON TABLE telemetry_archive IS
  'Thesis dataset. No retention policy, no compression policy. Append-only by trigger.';
COMMENT ON TABLE actuator_state_archive IS
  'Thesis dataset. No retention policy, no compression policy. Append-only by trigger.';

-- ----------------------------------------------------------------------------
-- 4a. Append-only enforcement
-- ----------------------------------------------------------------------------
-- Reuses the same pattern as the ledger. Enforcement in the database rather
-- than in application code means the guarantee holds against your own future
-- mistakes, not only against malice — which is the realistic threat to a
-- research dataset.

CREATE OR REPLACE FUNCTION prevent_archive_modification() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Archive is append-only: no UPDATE or DELETE allowed on %', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER telemetry_archive_immutable_update
  BEFORE UPDATE ON telemetry_archive
  FOR EACH ROW EXECUTE FUNCTION prevent_archive_modification();
CREATE TRIGGER telemetry_archive_immutable_delete
  BEFORE DELETE ON telemetry_archive
  FOR EACH ROW EXECUTE FUNCTION prevent_archive_modification();

CREATE TRIGGER actuator_archive_immutable_update
  BEFORE UPDATE ON actuator_state_archive
  FOR EACH ROW EXECUTE FUNCTION prevent_archive_modification();
CREATE TRIGGER actuator_archive_immutable_delete
  BEFORE DELETE ON actuator_state_archive
  FOR EACH ROW EXECUTE FUNCTION prevent_archive_modification();

-- ----------------------------------------------------------------------------
-- 4b. The copy procedure
-- ----------------------------------------------------------------------------
-- Idempotent by construction: ON CONFLICT DO NOTHING against the archive's own
-- unique index. Running it twice is harmless, running it on a schedule needs no
-- bookkeeping, and a failed run is corrected by the next one rather than
-- leaving a gap to reconcile by hand.
--
-- The 24-hour lag is deliberate. Copying rows the moment they arrive risks
-- capturing an incomplete picture — a late message after a reconnect, or a
-- bridge caught mid-write. Anything older than a day has settled.

CREATE OR REPLACE FUNCTION archive_telemetry(lag INTERVAL DEFAULT INTERVAL '24 hours')
RETURNS TABLE (telemetry_rows BIGINT, actuator_rows BIGINT) AS $$
DECLARE
  t_count BIGINT;
  a_count BIGINT;
BEGIN
  INSERT INTO telemetry_archive (
    time, device_ts, ts_quality, greenhouse_id, seq, sensor_name,
    value, unit, quality_flag
  )
  SELECT time, device_ts, ts_quality, greenhouse_id, seq, sensor_name,
         value, unit, quality_flag
  FROM telemetry
  WHERE time < now() - lag
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS t_count = ROW_COUNT;

  INSERT INTO actuator_state_archive (
    time, device_ts, greenhouse_id, seq, actuator,
    is_on, position_pct, src, for_s, ovr_s, vent_stage
  )
  SELECT time, device_ts, greenhouse_id, seq, actuator,
         is_on, position_pct, src, for_s, ovr_s, vent_stage
  FROM actuator_state
  WHERE time < now() - lag
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS a_count = ROW_COUNT;

  RETURN QUERY SELECT t_count, a_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION archive_telemetry IS
  'Idempotent copy of settled rows into the archive. Safe to run repeatedly; safe to miss a run.';

-- ----------------------------------------------------------------------------
-- 4c. Schedule it
-- ----------------------------------------------------------------------------
-- Uses TimescaleDB's own job runner, so there is no external cron to forget
-- about and nothing to configure outside the database.

CREATE OR REPLACE PROCEDURE archive_telemetry_job(job_id INT, config JSONB)
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM archive_telemetry();
END;
$$;

SELECT add_job('archive_telemetry_job', INTERVAL '6 hours');

-- ============================================================================
-- 5. RETENTION SAFETY CHECK
-- ============================================================================
-- Answers one question directly: is anything in the archive at risk of being
-- deleted? Worth running before relying on the dataset for anything.

CREATE OR REPLACE VIEW archive_safety AS
  SELECT
    'telemetry_archive' AS table_name,
    (SELECT count(*) FROM telemetry_archive) AS row_count,
    (SELECT min(time) FROM telemetry_archive) AS oldest,
    (SELECT max(time) FROM telemetry_archive) AS newest,
    NOT EXISTS (
      SELECT 1 FROM timescaledb_information.jobs
      WHERE hypertable_name = 'telemetry_archive'
        AND proc_name = 'policy_retention'
    ) AS retention_free
  UNION ALL
  SELECT
    'actuator_state_archive',
    (SELECT count(*) FROM actuator_state_archive),
    (SELECT min(time) FROM actuator_state_archive),
    (SELECT max(time) FROM actuator_state_archive),
    NOT EXISTS (
      SELECT 1 FROM timescaledb_information.jobs
      WHERE hypertable_name = 'actuator_state_archive'
        AND proc_name = 'policy_retention'
    );

COMMENT ON VIEW archive_safety IS
  'Confirms the archive holds data and that no retention policy has been attached to it.';

COMMIT;

-- ============================================================================
-- VERIFY
-- ============================================================================
-- \d telemetry
-- \d actuator_state
-- SELECT * FROM archive_safety;
-- SELECT * FROM timescaledb_information.jobs;
-- SELECT * FROM archive_telemetry(INTERVAL '0 seconds');   -- force an immediate copy
