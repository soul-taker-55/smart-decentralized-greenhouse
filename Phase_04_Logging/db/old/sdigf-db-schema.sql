-- Smart Decentralized Greenhouse (SDIGF) — Phase 4 Database Schema
-- PostgreSQL 16 + TimescaleDB Extension
-- Ground truth for telemetry, config history, users, and hash-chained ledger

-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- USERS & ROLES (Phase 5a/7)
-- ============================================================================

CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  account_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'AGRICULTURE_ENGINEER', 'FARMER')),
  public_key_fingerprint TEXT NOT NULL UNIQUE,  -- SHA256(public_key), hexadecimal
  public_key_pem TEXT NOT NULL,                  -- PEM-encoded Ed25519 public key
  active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT valid_email CHECK (email ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}$')
);

CREATE INDEX idx_users_account_id ON users(account_id);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_active ON users(active);

-- ============================================================================
-- CONFIG LIFECYCLE (Phase 5a)
-- ============================================================================

CREATE TABLE config_proposals (
  id BIGSERIAL PRIMARY KEY,
  proposal_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  proposer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  config_hash TEXT NOT NULL,  -- SHA256 of canonical (sorted-key) JSON, hexadecimal
  config_json JSONB NOT NULL, -- full config values
  state TEXT NOT NULL DEFAULT 'DRAFT' CHECK (state IN (
    'DRAFT', 'PROPOSED', 'PARTIALLY_APPROVED', 'APPROVED', 'ACTIVE', 'REJECTED', 'EXPIRED'
  )),
  approval_threshold INT NOT NULL DEFAULT 2,
  rejection_count INT NOT NULL DEFAULT 0,
  ttl_expires_at TIMESTAMPTZ NOT NULL,
  activated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_config_proposals_state ON config_proposals(state);
CREATE INDEX idx_config_proposals_proposer_id ON config_proposals(proposer_id);
CREATE INDEX idx_config_proposals_config_hash ON config_proposals(config_hash);
CREATE INDEX idx_config_proposals_ttl_expires_at ON config_proposals(ttl_expires_at);

-- Approval signatures per proposal; one row per signer
CREATE TABLE config_approvals (
  id BIGSERIAL PRIMARY KEY,
  proposal_id BIGINT NOT NULL REFERENCES config_proposals(id) ON DELETE CASCADE,
  approver_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('APPROVE', 'REJECT')),
  signature TEXT NOT NULL,  -- Ed25519 signature over config_hash, base64-encoded
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(proposal_id, approver_id)  -- one vote per user per proposal
);

CREATE INDEX idx_config_approvals_proposal_id ON config_approvals(proposal_id);
CREATE INDEX idx_config_approvals_approver_id ON config_approvals(approver_id);

-- ============================================================================
-- TELEMETRY (Phase 4 — high volume, time-series)
-- ============================================================================

CREATE TABLE telemetry (
  time TIMESTAMPTZ NOT NULL,
  greenhouse_id TEXT NOT NULL DEFAULT 'gh1',
  sensor_name TEXT NOT NULL,
  value FLOAT8 NOT NULL,
  unit TEXT,
  quality_flag TEXT DEFAULT 'OK' CHECK (quality_flag IN ('OK', 'STALE', 'ERROR'))
);

-- Convert to hypertable for compression, rollups, and efficient time-range queries
SELECT create_hypertable('telemetry', 'time', if_not_exists => TRUE);

-- Compression: keep only 1 hour uncompressed, compress older data
ALTER TABLE telemetry SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'greenhouse_id,sensor_name'
);

SELECT add_compression_policy('telemetry', INTERVAL '1 hour', if_not_exists => TRUE);

-- Retention: 90 days (enough for thesis analysis + operational review)
SELECT add_retention_policy('telemetry', INTERVAL '90 days', if_not_exists => TRUE);

CREATE INDEX idx_telemetry_greenhouse_sensor ON telemetry(greenhouse_id, sensor_name, time DESC);
CREATE INDEX idx_telemetry_time ON telemetry(time DESC);

-- ============================================================================
-- CONFIG HISTORY (Phase 4 — audit trail, low volume)
-- ============================================================================

CREATE TABLE config_history (
  id BIGSERIAL PRIMARY KEY,
  greenhouse_id TEXT NOT NULL DEFAULT 'gh1',
  config_proposal_id BIGINT REFERENCES config_proposals(id) ON DELETE SET NULL,
  config_hash TEXT NOT NULL,
  config_json JSONB NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_config_history_greenhouse_id ON config_history(greenhouse_id);
CREATE INDEX idx_config_history_activated_at ON config_history(activated_at DESC);
CREATE INDEX idx_config_history_config_hash ON config_history(config_hash);

-- ============================================================================
-- LEDGER (Phase 9 — hash-chained, append-only, immutable)
-- ============================================================================

CREATE TABLE ledger (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'CONFIG_APPROVED', 'CONFIG_ACTIVATED', 'ROLE_CHANGE', 'USER_ONBOARDED', 'SIGNATURE_ADDED'
  )),
  entity_id TEXT NOT NULL,         -- config_hash, user account_id, or proposal_id
  entity_type TEXT NOT NULL,       -- 'config', 'user', 'proposal'
  author_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  payload JSONB NOT NULL,          -- event-specific data
  content_hash TEXT NOT NULL,      -- SHA256(event_type || entity_id || payload), hexadecimal
  prev_hash TEXT,                  -- SHA256 of previous ledger row (NULL for first row)
  signature_count INT NOT NULL DEFAULT 0,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chain_integrity CHECK (
    (id = 1 AND prev_hash IS NULL) OR (id > 1 AND prev_hash IS NOT NULL)
  )
);

CREATE INDEX idx_ledger_event_type ON ledger(event_type);
CREATE INDEX idx_ledger_entity_id ON ledger(entity_id);
CREATE INDEX idx_ledger_author_id ON ledger(author_id);
CREATE INDEX idx_ledger_recorded_at ON ledger(recorded_at DESC);
CREATE INDEX idx_ledger_content_hash ON ledger(content_hash);

-- Prevent UPDATE and DELETE on ledger (immutable append-only)
CREATE OR REPLACE FUNCTION prevent_ledger_modification() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Ledger is immutable: no UPDATE or DELETE allowed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_immutable_update
  BEFORE UPDATE ON ledger
  FOR EACH ROW
  EXECUTE FUNCTION prevent_ledger_modification();

CREATE TRIGGER ledger_immutable_delete
  BEFORE DELETE ON ledger
  FOR EACH ROW
  EXECUTE FUNCTION prevent_ledger_modification();

-- ============================================================================
-- SUPPORT TABLES
-- ============================================================================

-- Track MQTT message retention and replay for Phase 4 bridge verification
CREATE TABLE mqtt_retained_messages (
  id BIGSERIAL PRIMARY KEY,
  topic TEXT NOT NULL UNIQUE,
  payload BYTEA NOT NULL,
  qos INT NOT NULL DEFAULT 1 CHECK (qos IN (0, 1, 2)),
  retained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_to_db_at TIMESTAMPTZ
);

CREATE INDEX idx_mqtt_retained_messages_topic ON mqtt_retained_messages(topic);

-- ============================================================================
-- VIEWS & UTILITIES
-- ============================================================================

-- Active config: most recent config_history record
CREATE OR REPLACE VIEW active_config AS
  SELECT * FROM config_history
  WHERE activated_at = (SELECT MAX(activated_at) FROM config_history)
  LIMIT 1;

-- Pending proposals: not yet APPROVED or REJECTED
CREATE OR REPLACE VIEW pending_proposals AS
  SELECT * FROM config_proposals
  WHERE state IN ('DRAFT', 'PROPOSED', 'PARTIALLY_APPROVED')
    AND ttl_expires_at > now()
  ORDER BY created_at ASC;

-- Ledger chain verification view: recompute each row's content_hash and check prev_hash links
CREATE OR REPLACE VIEW ledger_chain_verification AS
  WITH computed_hashes AS (
    SELECT
      id,
      content_hash AS stored_hash,
      encode(digest(event_type || entity_id || payload::text, 'sha256'), 'hex') AS computed_hash,
      prev_hash AS stored_prev,
      LAG(content_hash) OVER (ORDER BY id) AS computed_prev,
      recorded_at,
      event_type
    FROM ledger
  )
  SELECT
    id,
    stored_hash,
    computed_hash,
    (stored_hash = computed_hash) AS hash_valid,
    stored_prev,
    computed_prev,
    (stored_prev IS NOT DISTINCT FROM computed_prev) AS chain_valid,
    event_type,
    recorded_at
  FROM computed_hashes
  ORDER BY id;

-- ============================================================================
-- COMMENTS FOR DOCUMENTATION
-- ============================================================================

COMMENT ON TABLE users IS 'User identities with client-generated Ed25519 public keys. Private keys never transmitted.';
COMMENT ON TABLE config_proposals IS 'Configuration change proposals with M-of-N approval workflow. State machine enforces lifecycle.';
COMMENT ON TABLE config_approvals IS 'Per-signer approval records. Proposer signature does not count toward threshold.';
COMMENT ON TABLE telemetry IS 'High-volume sensor readings (temperature, humidity, light, soil, etc.) with TimescaleDB compression and retention.';
COMMENT ON TABLE config_history IS 'Audit trail of activated configurations. Immutable record of what was running when.';
COMMENT ON TABLE ledger IS 'Hash-chained append-only event log. Proves config approval and signature validity, does not verify sensor honesty.';
COMMENT ON TABLE mqtt_retained_messages IS 'Bridge-side record of retained messages for verification against broker persistence.';
COMMENT ON VIEW ledger_chain_verification IS 'Validate ledger integrity: recompute hashes and check prev_hash links. Use in recovery tests and audits.';
