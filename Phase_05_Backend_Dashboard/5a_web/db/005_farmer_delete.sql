-- SDIGF Phase 05b — db/005_farmer_delete.sql
--
-- Adds 'deleted' as a users.status value, for farmer soft-delete.
--
-- CONFIRMED BEFORE WRITING THIS: server_events.actor_id and commands.issued_by
-- carry no foreign key to users.id (both plain TEXT). A hard DELETE would not
-- fail — it would succeed and leave those columns holding an id that resolves
-- to nothing, silently degrading attribution on every past action the account
-- took. Soft-delete keeps the row, and therefore keeps attribution resolvable,
-- while the account is fully gone from active use.
--
-- FARMERS ONLY, enforced in the service layer (identity-service.deleteFarmer),
-- not in this constraint — status is shared across all three roles and the
-- role-specific restriction belongs where the role is checked.

BEGIN;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('invited', 'active', 'suspended', 'deleted'));

COMMENT ON COLUMN users.status IS
  'invited/active/suspended apply to any role. deleted is FARMER-ONLY (enforced in identity-service.deleteFarmer, not here) — soft delete, since actor_id/issued_by have no FK and a hard delete would silently orphan attribution on past commands and events.';

COMMIT;
