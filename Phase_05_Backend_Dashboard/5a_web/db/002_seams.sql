-- SDIGF Phase 05a — db/002_seams.sql
--
-- Adds the two forward-compatibility seams identified while reading the 05b and 05c
-- briefs. Both are additive and nullable: 05a never populates them meaningfully, but
-- their absence would force an ALTER on tables carrying live rows later.
--
-- Run AFTER config_profiles.sql, against the same database (sdigf_backend).
--
-- Rationale for each column is in the COMMENT, so the reason survives even if this
-- file is not the thing someone reads.

BEGIN;

-- ============================================================================
-- 1. commands.via — attribution of the issuing channel
-- ============================================================================
--
-- 05c requires every command logged with actor, via=MCP, and TTL. Without this
-- column there is no way to distinguish a command issued from the dashboard from
-- one issued through the AI chat interface — which is precisely the distinction
-- 05c's audit story depends on, and which Phase 07 chains.
--
-- Defaults to 'dashboard' because that is the only issuing channel that exists in
-- 05a. 05c passes 'mcp' explicitly.

ALTER TABLE commands
  ADD COLUMN via TEXT NOT NULL DEFAULT 'dashboard'
    CHECK (via IN ('dashboard', 'mcp'));

CREATE INDEX idx_commands_via ON commands (via, issued_at DESC);

COMMENT ON COLUMN commands.via IS
  'Issuing channel: dashboard (05a) or mcp (05c AI chat). Required by 05c so AI-issued commands are distinguishable in the audit trail and chainable by Phase 07. Defaults to dashboard since that is the only channel in 05a.';

-- ============================================================================
-- 2. server_events.signature_ref — pointer, not payload
-- ============================================================================
--
-- Signature BYTES deliberately do NOT live here. 05b will store per-signature
-- approval rows in its own table; this column holds a reference to that record so
-- Phase 07 can join the narrative (server_events) to the cryptographic evidence
-- (the approvals table) without either table duplicating the other.
--
-- Kept as TEXT rather than a foreign key because the target table does not exist
-- yet — 05b defines it. A real FK constraint can be added then without touching
-- the column itself or the rows already in it.
--
-- Note P-256 signatures are non-deterministic: the same config signed twice yields
-- different bytes. Nothing may ever identify or deduplicate on signature equality;
-- identity comes from key_id. That is why this is a reference and not a value.

ALTER TABLE server_events
  ADD COLUMN signature_ref TEXT;

CREATE INDEX idx_server_events_signature_ref ON server_events (signature_ref)
  WHERE signature_ref IS NOT NULL;

COMMENT ON COLUMN server_events.signature_ref IS
  'Reference to the approval record holding the actual signature bytes, defined in 05b. NULL in 05a (no auth, no signing). Deliberately a pointer rather than the signature itself so Phase 07 joins narrative to evidence without duplication. Never identify on signature equality — P-256 signatures are non-deterministic; identity is key_id.';

COMMIT;
