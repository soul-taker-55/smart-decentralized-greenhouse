/**
 * SDIGF Phase 06 — camera image storage and the snapshot-request flag.
 *
 * SCOPE: metadata and file placement only. This service never touches an
 * actuator, never publishes to MQTT, and has no relationship to config_profiles
 * or commands. The vision node is deliberately outside the control and
 * authorisation path — see ActivityPage.jsx's CameraPage placeholder, written
 * before this service existed, for the same statement made to the person
 * looking at the dashboard.
 *
 * WHY POLLING, NOT PUSH:
 * The device has no public IP and no inbound port — it sits on its own WiFi
 * network behind whatever NAT that network runs. Nothing on the server can
 * open a connection to it. So a requested snapshot is a flag the device asks
 * about (GET /api/camera/pending) on its own ~10s interval, never something
 * pushed to it. This is the same shape as the retained-config pattern in
 * config-service.js — state the device discovers, not state delivered to it —
 * for the same underlying reason: the server cannot reach the device directly.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { query, queryTelemetry } from '../db.js';
import { config } from '../config.js';

export class CameraError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CameraError';
    this.code = code;
  }
}

/**
 * Persist an uploaded frame: write the JPEG to disk, insert the metadata row,
 * and clear the pending flag if this was the manual snapshot it was requested
 * to satisfy.
 *
 * capturedAt is DEVICE-REPORTED. The server does not and cannot verify it —
 * the same honest limit recorded for the e-stop retrospective record
 * (004_estop_events.sql, §10.11 of the thesis chapter on this backend): the
 * system can prove the file was not altered after receipt, not that the
 * device's clock was correct when it says the frame was taken.
 *
 * @param {object} p
 * @param {string} p.ghId
 * @param {Buffer} p.buffer          Raw JPEG bytes.
 * @param {string} [p.capturedAt]    ISO 8601, device-reported. Defaults to now.
 * @param {'schedule'|'manual'} p.trigger
 */
export async function saveImage({ ghId, buffer, capturedAt, trigger }) {
  if (!buffer || buffer.length === 0) {
    throw new CameraError('empty_body', 'Upload contained no image data.');
  }
  if (trigger !== 'schedule' && trigger !== 'manual') {
    throw new CameraError('bad_trigger', "trigger must be 'schedule' or 'manual'.");
  }

  const capturedAtDate = capturedAt ? new Date(capturedAt) : new Date();
  if (Number.isNaN(capturedAtDate.getTime())) {
    throw new CameraError('bad_timestamp', 'captured_at is not a valid date.');
  }

  // Resolve who this satisfies BEFORE writing anything, so a claim failure
  // doesn't leave an orphaned file with no row.
  let requestedBy = null;
  if (trigger === 'manual') {
    const pending = await query(
      `SELECT requested, requested_by FROM camera_pending WHERE gh_id = $1`,
      [ghId]
    );
    requestedBy = pending.rows[0]?.requested_by ?? null;
  }

  const yyyy = String(capturedAtDate.getUTCFullYear());
  const mm = String(capturedAtDate.getUTCMonth() + 1).padStart(2, '0');
  const relDir = path.join(yyyy, mm);
  const fileName = `${capturedAtDate.getTime()}.jpg`;
  const relPath = path.join(relDir, fileName);
  const absDir = path.join(config.camera.imageDir, relDir);
  const absPath = path.join(absDir, fileName);

  await fs.mkdir(absDir, { recursive: true });
  await fs.writeFile(absPath, buffer);

  // Actuator state is COPIED here, not joined live at display time. See
  // 010_camera.sql's migration header for why: a later canopy move must not
  // retroactively change what an already-captured photo is understood to show.
  //
  // TWO THINGS ABOUT THIS QUERY THAT ARE NOT OBVIOUS:
  //
  //   1. It goes through queryTelemetry, not query. actuator_state lives in
  //      sdigf_db (the bridge's logging database), NOT sdigf_backend. That
  //      pool is read-only by construction — see db.js. Reading it here is
  //      allowed; writing to it from this service never is.
  //
  //   2. actuator_state is ONE ROW PER ACTUATOR, not one row per snapshot.
  //      Canopy position is position_pct on the row where actuator='canopy';
  //      the grow light is a separate row carrying is_on. There is no single
  //      row holding both, hence two subqueries rather than one lookup.
  //
  // HONEST LIMIT: as of Phase 06 these rows come from the Phase 04 mock edge
  // simulator, which publishes STATIC actuator states. The values land in the
  // image row faithfully; they do not yet describe real hardware. That becomes
  // true when Phase 02 firmware runs, with no schema or code change here.
  //
  // Failure to read telemetry must never fail an upload — the image is the
  // thing worth keeping, the metadata is context. Hence the catch.
  let canopyPosition = null;
  let photoperiodActive = null;
  try {
    const r = await queryTelemetry(
      `SELECT
         (SELECT position_pct FROM actuator_state
           WHERE greenhouse_id = $1 AND actuator = 'canopy'
           ORDER BY time DESC LIMIT 1) AS canopy_position,
         (SELECT is_on FROM actuator_state
           WHERE greenhouse_id = $1 AND actuator = 'grow_light'
           ORDER BY time DESC LIMIT 1) AS photoperiod_active`,
      [ghId]
    );
    canopyPosition = r.rows[0]?.canopy_position ?? null;
    photoperiodActive = r.rows[0]?.photoperiod_active ?? null;
  } catch {
    // Telemetry database unreachable or tables absent. Both columns stay NULL,
    // which is honest: we do not know what the canopy was doing.
  }

  const inserted = await query(
    `INSERT INTO camera_images
       (gh_id, captured_at, file_path, file_size_bytes, trigger, requested_by,
        canopy_position, photoperiod_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, captured_at, received_at, file_size_bytes`,
    [ghId, capturedAtDate.toISOString(), relPath, buffer.length, trigger,
     requestedBy, canopyPosition, photoperiodActive]
  );

  if (trigger === 'manual') {
    await query(
      `UPDATE camera_pending SET requested = false, requested_at = NULL, requested_by = NULL
        WHERE gh_id = $1`,
      [ghId]
    );
  }

  return inserted.rows[0];
}

/** Most recent image's metadata, or null if none has ever been uploaded. */
export async function getLatest(ghId) {
  const r = await query(
    `SELECT id, captured_at, received_at, file_path, file_size_bytes,
            trigger, requested_by, canopy_position, photoperiod_active
       FROM camera_images
      WHERE gh_id = $1
      ORDER BY captured_at DESC
      LIMIT 1`,
    [ghId]
  );
  return r.rows[0] ?? null;
}

/** Absolute filesystem path for a stored image, for the streaming route. */
export async function getImagePath(id, ghId) {
  const r = await query(
    `SELECT file_path FROM camera_images WHERE id = $1 AND gh_id = $2`,
    [id, ghId]
  );
  if (r.rows.length === 0) {
    throw new CameraError('not_found', `No image with id ${id}.`);
  }
  return path.join(config.camera.imageDir, r.rows[0].file_path);
}

/**
 * Set the pending flag. Called by the dashboard's snapshot button.
 * Any authenticated role may call this — it is an observation request, not an
 * actuation, so it needs a session, not the elevated capabilities that gate
 * commands or config changes.
 */
export async function requestSnapshot(ghId, requestedByUserId) {
  await query(
    `UPDATE camera_pending
        SET requested = true, requested_at = now(), requested_by = $2
      WHERE gh_id = $1`,
    [ghId, requestedByUserId]
  );
  return { requested: true };
}

/**
 * Read the pending flag. Called by the DEVICE on its poll interval.
 * Read-only — clearing happens as a side effect of saveImage() succeeding,
 * not here, so a device that reads "pending" but then fails to capture or
 * upload leaves the flag standing rather than silently losing the request.
 */
export async function getPending(ghId) {
  const r = await query(
    `SELECT requested, requested_at FROM camera_pending WHERE gh_id = $1`,
    [ghId]
  );
  if (r.rows.length === 0) {
    // Should not happen — the migration seeds one row per greenhouse — but a
    // device polling a greenhouse that was never seeded should get a clean
    // "no" rather than a 500.
    return { requested: false, requested_at: null };
  }
  return r.rows[0];
}
