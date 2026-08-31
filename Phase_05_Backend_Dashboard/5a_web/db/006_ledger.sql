-- SDIGF Phase 07 — db/006_ledger.sql
--
-- The hash-chained ledger over server_events.
--
-- Runs against sdigf_backend, after 005.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- NAMING — READ THIS FIRST
-- ═══════════════════════════════════════════════════════════════════════════
--
-- "006" here is the SIXTH FILE IN THIS DIRECTORY. See migration-note.txt: this
-- directory's numbering is local to Phase 05/07 and is offset from the numbering
-- used against Phase 04's sdigf_db. The two sequences are unrelated.
--
-- There is also a table called `ledger` in Phase_04_Logging/db/old/
-- sdigf-db-schema.sql. That is a SUPERSEDED PRE-CONTRACT DRAFT in a DIFFERENT
-- DATABASE (sdigf_db), and the current v2 telemetry schema does not create it.
-- It has nothing to do with this table. Named here so a reader who greps for
-- "ledger" does not conclude there are two live implementations.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THIS TABLE ADDS, STATED NARROWLY
-- ═══════════════════════════════════════════════════════════════════════════
--
-- It adds NOTHING to the trust model. It is not a second trust mechanism, not a
-- blockchain, not consensus, not distributed trust. One operator, one database,
-- one root credential.
--
-- What it does:
--
--   THE CHAIN-INTEGRITY CHECK TURNS "ERASABLE" INTO "DETECTABLY ERASABLE."
--
-- An administrator can still delete or rewrite session-attributed history. What
-- they cannot do is leave the chain consistent afterwards without rebuilding
-- every subsequent link. The record does not become unfalsifiable; it becomes
-- falsifiable only in ways that announce themselves.
--
-- And the boundary, stated here rather than buried: seq = 1 anchors NOTHING
-- outside this system. An administrator with database access can delete a range
-- of events and rebuild every subsequent link from genesis, and verification
-- will report OK. External anchoring is named future work, not built.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE FOUR OMISSIONS, AND WHY EACH IS DELIBERATE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every one of these looks like an oversight. Each was established by testing.
-- The next reader's instinct will be to "fix" them. Do not.
--
--   1. NO FOREIGN KEY ON prev_hash → entry_hash.
--      A constraint that refuses to STORE a broken chain leaves verification
--      nothing to detect. It converts a detectable anomaly into an insert error
--      at the wrong moment, and the anomaly never reaches the verifier.
--
--   2. NO FOREIGN KEY ON event_id → server_events(id) EITHER.
--      Same mistake as #1, one column over. A REFERENCES constraint there makes
--      deleting a server_events row impossible, so the EVENT_MISSING check
--      becomes unreachable dead code — the database refuses the very tamper the
--      check exists to detect. An administrator can drop a constraint anyway, so
--      it buys nothing and costs the detection.
--      The UNIQUE is KEPT: it prevents two links claiming one event, which is a
--      writer bug rather than an attack.
--
--   3. NO ON DELETE CASCADE from server_events.
--      A dangling link IS THE EVIDENCE. Cascading would let deletion tidy up
--      after itself — precisely what an attacker wants and an auditor does not.
--
--   4. seq IS NOT BIGSERIAL. It is inserted explicitly by the writer.
--      seq is part of the HASHED CONTENT. A sequence does not reset when rows
--      are deleted, so the assigned column value can silently diverge from the
--      hashed value. Every later verification then fails with a seq mismatch
--      INDISTINGUISHABLE FROM TAMPERING.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT IS HASHED
-- ═══════════════════════════════════════════════════════════════════════════
--
--   { seq, prev, event_id, time, gh, event_type, ref_table, ref_id,
--     actor_id, actor_role, detail, signature }
--
-- Note the field names are the FROZEN WIRE NAMES and differ from the column
-- names they are drawn from: `gh` ← server_events.gh_id, `prev` ← prev_hash,
-- and inside the resolved signature object `approval_id` ← config_approvals.id.
-- These are unchangeable after link 1 is written. Renaming one rewrites every
-- hash in the table.
--
-- `signature` is null when signature_ref is null; otherwise it is the resolved
-- config_approvals row reduced to the fields constituting the cryptographic
-- claim: { approval_id, key_id, user_id, decision, cfg_hash, signature }.
-- created_at is deliberately excluded — the link already carries the event's own
-- `time`, and a second timestamp adds nothing verifiable while adding one more
-- thing that must round-trip identically forever.
--
-- server_events.recorded_at is ALSO excluded, for the same reason. State the
-- consequence plainly rather than leaving it implicit: recorded_at can be edited
-- without breaking the chain.
--
-- `time` is a STRING FIXED AT WRITE TIME, produced by exactly one expression,
-- used identically by the writer and the verifier:
--
--   to_char(time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
--
-- Session-independent, driver-independent, fixed six-digit precision. Verified
-- against Postgres 16: the same input yields the same string under a hostile
-- session TimeZone, and .US zero-pads rather than truncating. A format that
-- drifts between writer and verifier produces universal mismatch that reads as
-- tampering — the exact failure mode canonicalization discipline exists to
-- prevent. The frozen vectors for it live in the test suite alongside canon.js's.

BEGIN;

CREATE TABLE ledger (
  -- Explicit, never BIGSERIAL. See omission #4 above.
  seq         BIGINT PRIMARY KEY,

  -- UNIQUE, but deliberately NOT a REFERENCES. See omission #2 above.
  event_id    BIGINT NOT NULL UNIQUE,

  -- NULL only at seq = 1. No FK. See omission #1 above.
  prev_hash   TEXT,

  entry_hash  TEXT NOT NULL UNIQUE,

  -- STORED, NOT RECOMPUTED. Same decision as putting cfg_canonical on the wire,
  -- and the same reason: an auditor sees the exact bytes that were hashed rather
  -- than trusting that a reimplementation reproduces them. It also makes a
  -- mismatch DIFFABLE — you can see WHICH FIELD changed, not merely that
  -- something did.
  canonical   TEXT NOT NULL,

  -- "This entry's position in the chain is asserted after the fact."
  -- TWO sources, one honest meaning:
  --   (a) the one-off historical backfill of events predating the ledger;
  --   (b) the reconciler chaining an event whose best-effort append failed.
  -- Without this flag verification returns uniform green across links that prove
  -- genuinely DIFFERENT things. Retrospectively chained entries prove ordering
  -- only from the real-time boundary forward.
  backfilled  BOOLEAN NOT NULL DEFAULT false,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Supports the realTimeFrom computation: MIN(seq) WHERE backfilled = false.
-- Computed independently of the chain walk, on purpose — the walk returns at its
-- first failure, and a boundary that only appears on success is a boundary that
-- is missing exactly when verification matters.
CREATE INDEX idx_ledger_backfilled_seq ON ledger (backfilled, seq);

-- Supports check 5: every server_events row in range must have a link.
CREATE INDEX idx_ledger_event_id ON ledger (event_id);

COMMENT ON TABLE ledger IS
  'Hash chain over server_events, with signature_ref resolved and the referenced approval hashed into each link — so tampering with EITHER table breaks the chain. Turns administratively erasable history into DETECTABLY erasable history. Not a blockchain: one operator, one database, one root credential, and genesis anchors nothing external.';

COMMENT ON COLUMN ledger.seq IS
  'Assigned EXPLICITLY by the writer, never BIGSERIAL. seq is part of the hashed content, and a sequence does not reset when rows are deleted — the column value could silently diverge from the hashed value, making every later verification fail indistinguishably from tampering.';

COMMENT ON COLUMN ledger.event_id IS
  'server_events.id. UNIQUE but deliberately NOT a foreign key: a REFERENCES constraint would make deleting an event impossible, turning the EVENT_MISSING check into unreachable dead code. An admin can drop a constraint anyway, so it buys nothing and costs the detection.';

COMMENT ON COLUMN ledger.prev_hash IS
  'Previous link''s entry_hash; NULL only at seq = 1. Deliberately NOT a foreign key — a constraint that refuses to store a broken chain leaves verification nothing to detect.';

COMMENT ON COLUMN ledger.canonical IS
  'The exact string that was hashed. Stored, not recomputed, so an auditor sees the bytes rather than trusting a reimplementation — and so a mismatch is diffable down to the field that changed.';

COMMENT ON COLUMN ledger.backfilled IS
  'This entry''s position in the chain is asserted after the fact — either the one-off historical backfill, or the reconciler picking up a failed best-effort append. Ordering is proven only from the earliest non-backfilled seq forward.';

COMMIT;

-- ============================================================================
-- VERIFY
-- ============================================================================
-- \d ledger
--
-- -- The omissions are the point. All three of these MUST return zero rows:
--
-- -- no FK on event_id or prev_hash
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid = 'ledger'::regclass AND contype = 'f';
--
-- -- seq must have no default (i.e. no sequence behind it)
-- SELECT column_name, column_default FROM information_schema.columns
--  WHERE table_name = 'ledger' AND column_name = 'seq' AND column_default IS NOT NULL;
--
-- -- The frozen timestamp vectors. Both must match EXACTLY.
-- SELECT to_char(timestamptz '2026-08-25 14:03:07.123456+03' AT TIME ZONE 'UTC',
--                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = '2026-08-25T11:03:07.123456Z'
--    AND to_char(timestamptz '2026-01-02 03:04:05+00' AT TIME ZONE 'UTC',
--                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = '2026-01-02T03:04:05.000000Z'
--        AS time_format_frozen;   -- must be true
