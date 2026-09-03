-- SDIGF Phase 05c — db/007_provider_settings.sql
--
-- AI provider configuration for the read-only assistant, stored under
-- envelope encryption with role separation.
--
-- Runs against sdigf_backend, after 006.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- NAMING — READ THIS FIRST
-- ═══════════════════════════════════════════════════════════════════════════
--
-- "007" is the SEVENTH FILE IN THIS DIRECTORY. See migration-note.txt: this
-- directory's numbering is local to Phase 05/07 and is offset from the
-- numbering used by Phase 04's db/ directory.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THREAT MODEL — WHY THE KEY IS SPLIT IN TWO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Two administrators, two kinds of access:
--   SERVER ADMIN     controls Dokploy and the environment. Holds PROVIDER_KEK.
--   DASHBOARD ADMIN  the application's admin role. Holds the session that
--                    writes this table.
-- Neither alone can read the provider API key. The database holds ciphertext
-- and a nonce; the environment holds the key-encrypting key; only the running
-- backend, holding both, can decrypt — and it never returns the plaintext to
-- any client or log.
--
--   Compromise                Attacker gets
--   database only             ciphertext, useless without the KEK
--   environment only          KEK, nothing to decrypt
--   dashboard admin session   can rotate the API key, cannot read it
--   server admin alone        KEK, but still needs the database row
--
-- Rotating the API key never needs Dokploy. Rotating the KEK never needs the
-- dashboard. The encryption is what makes that separation real.
--
-- HONEST LIMITATION, stated here so no later reader has to discover it: on the
-- proof-of-concept deployment, database and environment sit on ONE VPS, so
-- compromising both is a single compromise. The separation is real in design
-- and becomes real in effect when database and application run on separate
-- hosts — the production shape. Same framing as the ledger: the mechanism is
-- demonstrated here; the guarantee materialises when distributed.
--
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE provider_settings (
  -- Singleton. One greenhouse, one provider. A second row is a bug and must
  -- fail at the constraint, not succeed quietly — the same reasoning as the
  -- single-ACTIVE-config partial index in 001.
  id                  SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  provider            TEXT        NOT NULL CHECK (provider IN ('anthropic')),
  model               TEXT        NOT NULL CHECK (length(model) BETWEEN 1 AND 128),

  -- AES-256-GCM output: ciphertext || 16-byte auth tag. Tampering is detected
  -- by the tag, not decrypted into garbage.
  api_key_ciphertext  BYTEA       NOT NULL,
  -- Fresh random 12-byte nonce per write. Reusing a nonce under GCM is
  -- catastrophic, so uniqueness is the writer's job and the length is the
  -- database's job.
  api_key_nonce       BYTEA       NOT NULL CHECK (octet_length(api_key_nonce) = 12),

  -- The only part of the key ever shown again: "Configured · ends in …XXXX".
  api_key_last4       CHAR(4)     NOT NULL,

  -- First 16 hex characters of SHA-256(PROVIDER_KEK). Lets the backend tell
  -- "the KEK was rotated — re-entry required, by design" apart from "the KEK
  -- is the same but the tag failed — the ciphertext was tampered with". The
  -- two deserve different log lines. A truncated hash of a 256-bit random key
  -- reveals nothing usable about the key.
  kek_fingerprint     CHAR(16)    NOT NULL,

  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Session-attributed. No FK, for the same reason commands.issued_by has
  -- none: a deleted actor must not make the row unloadable, and the audit
  -- trail — not this column — is where attribution is proven.
  updated_by          UUID        NOT NULL
);

COMMENT ON TABLE provider_settings IS
  'AI provider credentials for the Phase 05c read-only assistant. API key stored as AES-256-GCM ciphertext under PROVIDER_KEK from the environment. Never holds plaintext. Singleton row.';
COMMENT ON COLUMN provider_settings.kek_fingerprint IS
  'Truncated SHA-256 of the KEK that sealed this row. Distinguishes KEK rotation (expected, re-enter key) from ciphertext tampering (unexpected, log loudly).';

-- ── event_type ──────────────────────────────────────────────────────────────
-- Setting or rotating the provider key is a security-relevant administrative
-- act. Recorded as its own type, chained strictly by Phase 07, same as
-- APPROVAL_POLICY_CHANGED.

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
    'ESTOP_TRIGGERED',
    'ESTOP_CLEARED',
    'KEY_REGISTERED',
    'KEY_REVOKED',
    'APPROVAL_POLICY_CHANGED',
    -- Phase 05c. Detail carries provider, model and last4 only — never the
    -- ciphertext, never the nonce, never the plaintext.
    'PROVIDER_CONFIG_CHANGED'
  ));

-- ── ref_table ───────────────────────────────────────────────────────────────

ALTER TABLE server_events DROP CONSTRAINT IF EXISTS server_events_ref_table_check;

ALTER TABLE server_events ADD CONSTRAINT server_events_ref_table_check
  CHECK (ref_table IN ('config_profiles', 'commands', 'user_keys', 'provider_settings', 'none'));

COMMIT;

-- ============================================================================
-- VERIFY
-- ============================================================================
-- INSERT INTO provider_settings (id, provider, model, api_key_ciphertext, api_key_nonce,
--   api_key_last4, kek_fingerprint, updated_by)
-- VALUES (2, 'anthropic', 'x', '\x00', '\x000000000000000000000000', 'abcd',
--   '0123456789abcdef', gen_random_uuid());
-- -- must fail: id = 1 is the only permitted row
--
-- SELECT conname FROM pg_constraint WHERE conname = 'server_events_event_type_check';
-- -- one row; and an INSERT with event_type = 'PROVIDER_CONFIG_CHANGED' must succeed
