-- SDIGF Phase 06 — db/010_camera.sql
--
-- "010" is the TENTH FILE IN THIS DIRECTORY (see migration-note.txt: files here
-- run offset from the real migration count by the four migrations that live in
-- Phase_04_Logging). Runs against sdigf_backend, after 009.
--
-- WHAT THIS ADDS
-- The vision node (Phase 06) is a separate WiFi controller sharing only the 5V
-- rail with the main ESP32-WROOM. It has no place in config_profiles, commands,
-- or any table that implies control authority — a camera image is an
-- observation, never an actuation, and the schema should say so structurally,
-- not just in a comment.
--
-- TWO TABLES:
--
--   camera_images   — one row per uploaded frame. Metadata only; the JPEG
--                      bytes live on disk (a Docker volume), not in Postgres.
--                      Storing binary blobs in the row that also serves the
--                      dashboard's history queries would make every unrelated
--                      SELECT pay for image I/O it never asked for.
--
--   camera_pending  — a single-row table (by construction) holding whether a
--                      snapshot has been requested and by whom. The CAM polls
--                      GET /api/camera/pending on a ~10s interval; there is no
--                      inbound connection to the device, so a request has to be
--                      something the device asks about, not something pushed
--                      to it.
--
-- WHY canopy_position AND photoperiod_active ARE COPIED, NOT JOINED
-- The shade canopy changes illumination, and a photoperiod boundary changes it
-- again. Both are copied onto the image row AT THE MOMENT OF UPLOAD rather than
-- joined live from actuator_state at display time, because actuator_state is
-- mutable — a later position change must not retroactively alter what an
-- already-captured photo is understood to show. This mirrors the retrospective
-- e-stop pattern (004_estop_events.sql): a record of what was true when the
-- event happened, immune to what happens after.
--
-- HONEST LIMIT, worth stating in the same place the ledger and e-stop
-- documentation state theirs: as of this migration, canopy_position and
-- photoperiod_active are read from actuator_state, which the mock edge
-- simulator populates with STATIC values. Until Phase 02 firmware runs, these
-- columns are copied faithfully but do not yet describe anything real. The
-- column exists and is correct in shape; the data behind it is not yet
-- meaningful. Do not let a later reader mistake "populated" for "true."

BEGIN;

CREATE TABLE camera_images (
  id                  BIGSERIAL PRIMARY KEY,
  gh_id               TEXT NOT NULL DEFAULT 'gh1',

  captured_at         TIMESTAMPTZ NOT NULL,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Relative path under the image volume root, e.g. '2026/09/1725384000123.jpg'.
  -- Never an absolute filesystem path — the volume mount point is deployment
  -- configuration, not data, and must be free to change without a migration.
  file_path           TEXT NOT NULL,
  file_size_bytes     INTEGER NOT NULL,

  width               INTEGER,
  height              INTEGER,

  -- 'schedule' | 'manual'. Manual snapshots are what camera_pending.requested_by
  -- resolves to at the moment the device claims the pending flag; 'schedule' is
  -- the device's own timelapse interval, which this schema does not configure —
  -- that lives in the device's compiled defaults for now, matching Phase 02's
  -- three-tier config fallback until there is a reason to make it server-driven.
  trigger             TEXT NOT NULL,

  -- users.id of whoever pressed the snapshot button, NULL for scheduled frames.
  -- TEXT with no foreign key, same reasoning as commands.issued_by
  -- (005_farmer_delete.sql): a user row can be soft- or hard-deleted later, and
  -- an image already captured must not be silently orphaned into an insert
  -- failure or a resolves-to-nothing foreign key.
  requested_by        TEXT,

  -- Copied at upload time, not joined live. See migration header.
  canopy_position     INTEGER,
  photoperiod_active  BOOLEAN,

  CONSTRAINT camera_images_trigger_check
    CHECK (trigger IN ('schedule', 'manual'))
);

CREATE INDEX camera_images_captured_at_idx ON camera_images (captured_at DESC);
CREATE INDEX camera_images_gh_id_idx ON camera_images (gh_id);

COMMENT ON TABLE camera_images IS
  'Phase 06 vision node uploads. Metadata only — JPEG bytes live on a Docker volume, path in file_path. The camera has no actuation authority; this table has no relationship to config_profiles, commands, or any control-path table.';

COMMENT ON COLUMN camera_images.canopy_position IS
  'Copied from actuator_state at upload time. As of Phase 06, this reflects the mock edge simulator''s static value, not real hardware — meaningful only once Phase 02 firmware is live. See migration header.';

-- ─────────────────────────────────────────────────────────────────────────

-- Single-row table: the dashboard's snapshot button sets this, the CAM polls
-- it, claims it, and clears it. A proper queue is unwarranted for one device
-- and one greenhouse; this is not multi-greenhouse, multi-camera infrastructure.
CREATE TABLE camera_pending (
  gh_id           TEXT PRIMARY KEY DEFAULT 'gh1',
  requested       BOOLEAN NOT NULL DEFAULT false,
  requested_at    TIMESTAMPTZ,
  requested_by    TEXT
);

COMMENT ON TABLE camera_pending IS
  'One row per greenhouse. Set by POST /api/camera/request-snapshot, read and cleared by the device''s GET /api/camera/pending poll. No FK on requested_by — same reasoning as camera_images.requested_by.';

-- Seed the one row this deployment needs. Single-greenhouse, matches GH_ID's
-- default of 'gh1' throughout config.js and the topic tree.
INSERT INTO camera_pending (gh_id, requested) VALUES ('gh1', false)
  ON CONFLICT (gh_id) DO NOTHING;

COMMIT;

-- VERIFY
-- SELECT table_name FROM information_schema.tables
--  WHERE table_name IN ('camera_images', 'camera_pending');
-- -- both rows present
--
-- SELECT * FROM camera_pending;
-- -- one row, gh_id='gh1', requested=false
