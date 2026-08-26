-- SDIGF Phase 05b — db/003_auth.sql
--
-- Identity, client-generated signing keys, and M-of-N threshold approval.
--
-- Runs against sdigf_backend, after 001 and 002.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THIS MIGRATION IS DEFENDING AGAINST
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The claim this phase supports is: a single engineer cannot unilaterally
-- change what the greenhouse does, and an administrator cannot forge an
-- approval that was never given.
--
-- Three things in this schema carry that claim, and each is a database
-- constraint rather than application logic, because application logic can be
-- bypassed by a bug and a constraint cannot:
--
--   1. UNIQUE (config_profile_id, key_id) on config_approvals.
--      One key, one vote. P-256 signatures are NON-DETERMINISTIC — the same
--      key signing the same hash twice produces different bytes. Without this
--      constraint an approver could submit the same approval repeatedly and
--      inflate a quorum, and every signature would verify. This is the single
--      most important line in the file.
--
--   2. NO private key column, anywhere.
--      Private keys are generated in the browser and never transmitted. The
--      schema has nowhere to put one, so a future well-meaning change that
--      "helpfully" stores them would require a migration and a review rather
--      than a patch. If the server held private keys, an administrator could
--      manufacture a quorum and the entire multi-signature argument collapses.
--
--   3. key_id DERIVED FROM THE PUBLIC KEY, not assigned.
--      Because key_id is a function of the key material, "one key one vote"
--      and "one key_id one vote" are the same statement. An assigned
--      identifier could be reused across keys, which would make the uniqueness
--      constraint above enforce nothing.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THIS SCHEMA DOES NOT DEFEND AGAINST — STATE THIS IN THE THESIS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- An administrator creates users and assigns roles. An administrator who mints
-- two engineer accounts can satisfy a 2-of-N threshold with two keys they
-- control. No schema prevents this; only the recorded role-change history makes
-- it visible after the fact, which is why role assignment is an audited event
-- rather than a silent UPDATE.
--
-- The precise guarantee is therefore narrower than "approvals cannot be
-- forged": approvals cannot be forged FOR KEYS THE SERVER DOES NOT HOLD.
-- Since the server holds none, a past approval cannot be fabricated. A future
-- one can be manufactured by an administrator willing to create accounts, and
-- the record shows they did.

BEGIN;

-- ============================================================================
-- 1. USERS
-- ============================================================================
--
-- id is TEXT, not a serial, because 001 already declared config_profiles
-- .created_by, server_events.actor_id and commands.issued_by as TEXT. Those
-- columns were the 05b seam and this migration fills them without altering
-- them — which was the point of leaving them nullable rather than absent.
--
-- The id is human-legible ('eng-hala', 'farmer-01') because it appears in the
-- audit trail, in up/cmd payloads, and eventually in a ledger a reader has to
-- interpret. An opaque UUID there would make the record technically complete
-- and practically unreadable.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  username      TEXT NOT NULL UNIQUE,

  -- The settled matrix. ADMIN is deliberately excluded from operational and
  -- agronomic authority: they manage users, API configuration and server
  -- status, and are otherwise read-only. That exclusion is a separation-of-
  -- duties contribution, not an oversight, and the CHECK keeps a fourth role
  -- from appearing without a migration and a conversation.
  --
  -- 'farmer' covers what is elsewhere called a viewer. They are the same role;
  -- two names for one thing invites drift between code and interface.
  role          TEXT NOT NULL CHECK (role IN ('admin', 'engineer', 'farmer')),

  -- Argon2id or bcrypt output, including its own salt and parameters. NULL
  -- until the user completes an invite and sets it — an account that exists
  -- but cannot yet authenticate is a real state, not a defect.
  password_hash TEXT,

  status        TEXT NOT NULL DEFAULT 'invited'
                  CHECK (status IN ('invited', 'active', 'suspended')),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    TEXT REFERENCES users(id),   -- NULL for the bootstrap admin
  activated_at  TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ
);

CREATE INDEX idx_users_role ON users (role) WHERE status = 'active';

COMMENT ON TABLE users IS
  'Accounts. No self-registration — every account originates from an admin invite. Note there is no private key column anywhere in this schema, by design.';
COMMENT ON COLUMN users.role IS
  'admin | engineer | farmer. ADMIN CANNOT propose or approve configs or issue commands — separation of duties. farmer and viewer are the same role.';

-- ============================================================================
-- 2. INVITES
-- ============================================================================
--
-- Single-use, short-lived, role-scoped. The role is fixed at invite time so a
-- link cannot be redeemed for a role other than the one an admin chose.
--
-- THE TOKEN ITSELF IS NOT STORED. Only its SHA-256. A leaked database dump
-- therefore does not yield usable invite links. This mirrors password handling
-- for the same reason: a credential the server can read is a credential an
-- attacker who reaches the server can use.

CREATE TABLE invites (
  id            BIGSERIAL PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,        -- sha256 of the token, lowercase hex
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Duplicated from users.role deliberately. If an admin changed a user's role
  -- between issuing and redemption, the invite must still grant what was
  -- intended when it was created — and the discrepancy is then visible rather
  -- than silently resolved in the admin's favour.
  role          TEXT NOT NULL CHECK (role IN ('admin', 'engineer', 'farmer')),

  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    TEXT REFERENCES users(id)
);

-- Partial index: only unredeemed invites are worth looking up.
CREATE INDEX idx_invites_open ON invites (token_hash) WHERE used_at IS NULL;

COMMENT ON TABLE invites IS
  'Single-use, short-lived, role-scoped onboarding links. Stores sha256(token), never the token — a database dump must not yield usable invites.';

-- ============================================================================
-- 3. SESSIONS
-- ============================================================================
--
-- Server-side sessions rather than self-contained tokens, so revocation is
-- immediate. A suspended account with a valid stateless token stays valid until
-- expiry; a suspended account with a server-side session does not. Given that
-- this system can actuate equipment, "logged out means logged out" is worth the
-- extra lookup.

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,            -- sha256 of the cookie value
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent    TEXT,
  ip            TEXT
);

CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expiry ON sessions (expires_at);

-- ============================================================================
-- 4. USER KEYS — public halves only
-- ============================================================================
--
-- ENGINEERS ONLY. Admins and farmers approve nothing, so a keypair for them
-- would be an unused credential that still has to be protected. Not enforced by
-- a CHECK because the role lives on another table; enforced in the service
-- layer and asserted in tests.
--
-- ─── STORAGE FORMAT, AND WHY THIS ONE ──────────────────────────────────────
--
-- public_key holds the RAW UNCOMPRESSED POINT as lowercase hex: 04 || X || Y,
-- 65 bytes, 130 hex characters. This is exactly what WebCrypto's exportKey
-- ('raw') produces and exactly what mbedtls_ecp_point_read_binary consumes.
--
-- SPKI/DER was the alternative and was rejected. Phase 03 must ship a signed
-- trusted-key list to a microcontroller over MQTT, where every byte is a byte
-- of a 2048-byte receive buffer, and where a DER parser is a parser that can be
-- fed hostile input. The raw point needs no parsing: it is a fixed-length field
-- with a fixed prefix.
--
-- The SPKI form remains derivable when a Node or browser API wants it, by
-- prepending the fixed 26-byte P-256 header:
--   3059301306072a8648ce3d020106082a8648ce3d030107034200
-- so nothing is lost by storing the compact form.
--
-- ─── key_id IS DERIVED, NOT ASSIGNED ───────────────────────────────────────
--
--   key_id = 'eng-' || left(sha256(public_key_bytes), 8)
--
-- Because it is a function of the key material, an identifier cannot be moved
-- between keys or reused. That is what makes the UNIQUE (config_profile_id,
-- key_id) constraint on approvals mean "one key, one vote" rather than merely
-- "one label, one vote".

CREATE TABLE user_keys (
  key_id        TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  public_key    TEXT NOT NULL UNIQUE,        -- 04||X||Y, lowercase hex, 130 chars
  alg           TEXT NOT NULL DEFAULT 'es256' CHECK (alg = 'es256'),

  -- Revoked keys are RETAINED, never deleted. Signatures they produced remain
  -- in config_approvals, and a verifier walking history must still be able to
  -- resolve the key that made them. Deleting a revoked key would make every
  -- past approval by that engineer unverifiable — destroying evidence in the
  -- name of hygiene.
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'revoked')),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ,
  revoked_by    TEXT REFERENCES users(id),
  revoke_reason TEXT
);

-- An engineer holds at most one active key. Losing a key means revocation and a
-- fresh invite, not accumulating spares — several simultaneously valid keys per
-- person makes "who approved this" ambiguous exactly when it matters.
CREATE UNIQUE INDEX idx_user_keys_one_active
  ON user_keys (user_id)
  WHERE status = 'active';

COMMENT ON TABLE user_keys IS
  'PUBLIC halves only. Private keys are generated in the browser via WebCrypto and never transmitted — there is deliberately nowhere here to put one. Raw 04||X||Y hex, chosen so Phase 03 can ship a compact device-consumable key list without a DER parser on the ESP32.';
COMMENT ON COLUMN user_keys.key_id IS
  'Derived: eng- || left(sha256(public_key),8). Derived rather than assigned so that one key_id is one key, which is what makes the approval uniqueness constraint meaningful.';
COMMENT ON COLUMN user_keys.status IS
  'Revoked keys are retained, never deleted — past signatures must stay verifiable.';

-- ============================================================================
-- 5. APPROVAL POLICY — the M in M-of-N
-- ============================================================================
--
-- A separate table rather than a constant, because the threshold is an
-- operational decision that will change, and because CHANGING IT IS ITSELF A
-- SECURITY-RELEVANT ACT. Lowering the threshold from 2 to 1 converts a
-- multi-signature system into a single-signature one. That must leave a record,
-- which a hardcoded constant edited in a deploy would not.
--
-- The service layer writes a server_events row on every change here. The ledger
-- in a later phase chains those rows for the same reason.

CREATE TABLE approval_policy (
  gh_id         TEXT PRIMARY KEY DEFAULT 'gh1',

  -- Distinct approvers required, EXCLUDING the proposer.
  threshold_m   INT NOT NULL DEFAULT 2 CHECK (threshold_m >= 1),

  -- Hours a proposal remains open before expiring. A proposal that sits
  -- indefinitely is a signature-gathering opportunity that never closes.
  proposal_ttl_hours INT NOT NULL DEFAULT 72 CHECK (proposal_ttl_hours > 0),

  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    TEXT REFERENCES users(id)
);

INSERT INTO approval_policy (gh_id, threshold_m, proposal_ttl_hours)
VALUES ('gh1', 2, 72);

COMMENT ON TABLE approval_policy IS
  'M-of-N threshold and proposal TTL. A table rather than a constant because lowering the threshold is a security-relevant act that must be recorded, not a deploy-time edit.';
COMMENT ON COLUMN approval_policy.threshold_m IS
  'Distinct approvers required, EXCLUDING the proposer. A proposer cannot approve their own proposal.';

-- ============================================================================
-- 6. CONFIG APPROVALS — one row per signature or rejection
-- ============================================================================
--
-- This is the table server_events.signature_ref points at. Signature BYTES live
-- here; the narrative lives in server_events. Phase 07 joins the two rather than
-- duplicating either.
--
-- ─── THE CONSTRAINT THAT CARRIES THE WHOLE CLAIM ───────────────────────────
--
-- UNIQUE (config_profile_id, key_id)
--
-- P-256 signatures are non-deterministic: the same key signing the same hash
-- twice yields different bytes, and both verify. Counting signatures rather than
-- distinct keys would let one approver reach a 2-of-N threshold alone by
-- submitting twice. Deduplicating in application code would work until the first
-- race between two concurrent submissions; the database constraint holds under
-- concurrency, which is where the bug would otherwise live.
--
-- ─── WHY REJECTIONS SHARE THIS TABLE ───────────────────────────────────────
--
-- A rejection is a signed opinion about a specific config hash, exactly like an
-- approval. Storing them together means one uniqueness rule covers both, so an
-- engineer cannot approve and then reject the same proposal, or vice versa. One
-- key, one decision.

CREATE TABLE config_approvals (
  id                BIGSERIAL PRIMARY KEY,
  config_profile_id BIGINT NOT NULL REFERENCES config_profiles(id) ON DELETE CASCADE,

  key_id            TEXT NOT NULL REFERENCES user_keys(key_id),
  user_id           TEXT NOT NULL REFERENCES users(id),

  decision          TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),

  -- The hash actually signed. Stored rather than looked up, because verification
  -- must be able to detect a config_profiles row edited after approval: if the
  -- profile's cfg_hash no longer matches this value, the approval no longer
  -- covers what is stored. That mismatch is the tamper signal.
  cfg_hash          TEXT NOT NULL,

  -- Raw r||s, IEEE P1363, 64 bytes as 128 lowercase hex characters — the form
  -- WebCrypto produces natively. Firmware converts to ASN.1 DER for mbedTLS;
  -- the two are NOT interchangeable, and the failure mode is a signature that
  -- verifies in Node and silently fails on the ESP32.
  signature         TEXT,

  -- Free text, and only on rejection. One rejection kills a proposal, so the
  -- reason is the only record of why a change was refused.
  reason            TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ONE KEY, ONE VOTE. See the block comment above.
  UNIQUE (config_profile_id, key_id)
);

CREATE INDEX idx_config_approvals_profile ON config_approvals (config_profile_id);
CREATE INDEX idx_config_approvals_key ON config_approvals (key_id);

COMMENT ON TABLE config_approvals IS
  'One row per signed approval or rejection. UNIQUE (config_profile_id, key_id) is what prevents quorum inflation: P-256 signatures are non-deterministic, so counting signatures instead of distinct keys would let one approver satisfy a threshold alone.';
COMMENT ON COLUMN config_approvals.cfg_hash IS
  'The hash actually signed. If config_profiles.cfg_hash later differs, the approval no longer covers what is stored — that mismatch is the tamper signal.';
COMMENT ON COLUMN config_approvals.signature IS
  'Raw r||s (IEEE P1363), 128 hex chars. NOT ASN.1 DER — firmware converts. Never deduplicate on signature equality; P-256 signatures are non-deterministic.';

-- ============================================================================
-- 7. ROLE CHANGES — audited, because they can manufacture a quorum
-- ============================================================================
--
-- An administrator who can silently mint engineers can satisfy any threshold.
-- No schema prevents that. What the schema can do is refuse to let it happen
-- quietly.
--
-- Recorded separately from server_events because Phase 07 chains these
-- specifically: a ledger that records approvals but not who was granted the
-- power to approve proves less than it appears to.

CREATE TABLE role_changes (
  id            BIGSERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_role     TEXT,                        -- NULL on account creation
  to_role       TEXT NOT NULL,
  changed_by    TEXT REFERENCES users(id),   -- NULL for the bootstrap admin
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_role_changes_user ON role_changes (user_id, created_at DESC);

COMMENT ON TABLE role_changes IS
  'Every role assignment, including at creation. An admin who can silently mint engineers can manufacture a quorum; this makes that visible rather than preventing it. Phase 07 chains these alongside approvals — recording approvals without recording who was granted approval authority proves less than it appears to.';

-- ============================================================================
-- 8. LINK server_events.signature_ref TO ITS TARGET
-- ============================================================================
--
-- 002 created signature_ref as a nullable TEXT pointer with no foreign key,
-- because the target table did not exist yet. It does now.
--
-- Deliberately NOT converted to a real FK: server_events rows are immutable
-- history, and an ON DELETE CASCADE from config_approvals would let deleting an
-- approval silently rewrite the narrative that references it. The pointer stays
-- soft; verification resolves it and reports a dangling reference as a finding
-- rather than the database hiding one.

COMMENT ON COLUMN server_events.signature_ref IS
  'config_approvals.id as text, or NULL. Deliberately not a foreign key: server_events is immutable history, and a cascade would let deleting an approval quietly alter the record that references it. A dangling reference is a finding, not something the database should hide.';

COMMIT;

-- ============================================================================
-- VERIFY
-- ============================================================================
-- \d users
-- \d user_keys
-- \d config_approvals
--
-- -- The constraint that carries the claim. Second insert MUST fail.
-- INSERT INTO users (id,email,username,role,status)
--   VALUES ('eng-a','a@x','a','engineer','active');
-- INSERT INTO user_keys (key_id,user_id,public_key)
--   VALUES ('eng-11111111','eng-a', repeat('a',130));
-- INSERT INTO config_profiles (gh_id,ver,cfg,cfg_canonical,cfg_hash,status)
--   VALUES ('gh1',1,'{}','{}','h1','PROPOSED');
-- INSERT INTO config_approvals (config_profile_id,key_id,user_id,decision,cfg_hash)
--   SELECT id,'eng-11111111','eng-a','approve','h1' FROM config_profiles WHERE cfg_hash='h1';
-- INSERT INTO config_approvals (config_profile_id,key_id,user_id,decision,cfg_hash)
--   SELECT id,'eng-11111111','eng-a','approve','h1' FROM config_profiles WHERE cfg_hash='h1';
-- -- ^ must raise unique_violation on (config_profile_id, key_id)
