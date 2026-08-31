/**
 * SDIGF — emergency stop.
 *
 * Contract v4 §3.9. Everything off, immediately, until an engineer clears it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS STATE, NOT A COMMAND
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Published to its own RETAINED topic rather than to down/cmd. A controller
 * that reboots into a halted greenhouse must come back halted, which is the
 * same argument that puts config on a retained topic. down/cmd is not retained
 * because a command is an event — retaining one would re-fire a pump switch-on
 * after every power cut.
 *
 * Events are not retained. State is. Emergency stop is state.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SERVER NEVER ASSERTS THAT A GREENHOUSE IS STOPPED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It asserts only that it asked. Whether the device is actually halted comes
 * from the device's own `estop` field in up/health and up/actuators.
 *
 * The distinction is not pedantry: publish a stop while the controller is
 * offline and the retained message sits on the broker unread. The greenhouse is
 * still running. A dashboard that showed "stopped" at that moment would be
 * telling an operator the opposite of the truth at the exact moment it matters
 * most.
 */

import { query, transaction } from '../db.js';
import { config } from '../config.js';

export class EstopError extends Error {
  constructor(message, code = 'estop_error') {
    super(message);
    this.name = 'EstopError';
    this.code = code;
  }
}

/**
 * The stop the server has published, and its sequence number.
 *
 * Reconstructed from server_events rather than kept in a dedicated table: the
 * audit trail is already the authoritative record of who asked for what, and a
 * second store would be a second thing that can disagree with it.
 */
export async function getServerEstop(ghId = config.ghId) {
  const r = await query(
    `SELECT detail, actor_id, actor_role, time
     FROM server_events
     WHERE gh_id = $1 AND event_type IN ('ESTOP_TRIGGERED', 'ESTOP_CLEARED')
     ORDER BY time DESC LIMIT 1`,
    [ghId]
  );

  if (r.rows.length === 0) {
    return {
      seq: 0, state: 'clear', source: null, by: null, byRole: null,
      reason: null, at: null, deviceSince: null, retrospective: false,
      everUsed: false,
    };
  }

  const row = r.rows[0];
  return {
    seq: row.detail?.seq ?? 0,
    state: row.detail?.state ?? 'clear',
    // 'remote' for everything recorded before this amendment — those were all
    // server-originated, so the default is correct rather than a guess.
    source: row.detail?.source ?? 'remote',
    by: row.actor_id,
    byRole: row.actor_role,
    reason: row.detail?.reason ?? null,
    at: row.time,
    // Present only on retrospective records. The device's own report of when
    // the stop began, which the server did not witness and cannot verify.
    deviceSince: row.detail?.device_since ?? null,
    retrospective: row.detail?.retrospective === true,
    everUsed: true,
  };
}

/**
 * Trigger or clear.
 *
 * `seq` is monotonic and is the entire replay defence. A retained message is
 * redelivered on every reconnect; without a counter the device cannot tell an
 * operator clearing the stop from the broker replaying an old clear — and the
 * second would silently unhalt a greenhouse someone deliberately stopped.
 *
 * The database row is written BEFORE the publish, so a publish failure leaves a
 * record of the attempt rather than an unaccountable actuator change. For a
 * stop specifically this ordering also means the audit trail cannot be missing
 * an emergency that happened.
 *
 * @param {'stopped'|'clear'} state
 */
export async function setEstop({ state, reason, actor, publisher }) {
  if (!['stopped', 'clear'].includes(state)) {
    throw new EstopError('state must be stopped or clear', 'bad_state');
  }
  if (!actor?.id) throw new EstopError('not authenticated', 'no_actor');

  // Authority is deliberately asymmetric. Anyone who can see a problem may
  // stop the greenhouse; deciding the problem is over is an engineering
  // judgement. Enforced at the route by capability, and again here so a direct
  // service call cannot bypass it.
  if (state === 'clear' && actor.role !== 'engineer') {
    throw new EstopError(
      'only an engineer can clear an emergency stop — deciding the problem is over is an engineering judgement',
      'forbidden'
    );
  }

  const current = await getServerEstop();

  if (current.state === state) {
    throw new EstopError(
      state === 'stopped'
        ? 'the greenhouse is already stopped'
        : 'there is no active emergency stop',
      'no_change'
    );
  }

  if (state === 'clear' && !reason) {
    // A stop may be triggered without explanation — urgency is a good reason.
    // Clearing one is a considered act and should say why.
    throw new EstopError('a reason is required when clearing an emergency stop', 'reason_required');
  }

  const seq = current.seq + 1;

  const record = await transaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO server_events (gh_id, event_type, ref_table, ref_id, actor_id, actor_role, detail)
       VALUES ($1, $2, 'none', 0, $3, $4, $5)
       RETURNING *`,
      [
        config.ghId,
        state === 'stopped' ? 'ESTOP_TRIGGERED' : 'ESTOP_CLEARED',
        actor.id,
        actor.role,
        JSON.stringify({
          seq,
          state,
          source: 'remote',
          reason: reason ?? null,
          sessionAttributed: true,
        }),
      ]
    );

    // Clearing resumes automation under the stored configuration. It does NOT
    // restore whatever manual overrides were running before the stop — those
    // were cancelled when everything went off, and silently reinstating them
    // would be the opposite of what an operator expects from "clear".
    if (state === 'clear') {
      await client.query(
        `UPDATE commands SET ack_result = 'rejected',
                             ack_reason = '{"code":"ESTOP","message":"cancelled by emergency stop"}'::jsonb,
                             acked_at = now()
         WHERE gh_id = $1 AND acked_at IS NULL`,
        [config.ghId]
      );
    }

    return inserted.rows[0];
  });

  let published = false;
  let publishError = null;
  try {
    await publisher.publishEstop({ seq, state, reason: reason ?? null, by: actor, source: 'remote' });
    published = true;
  } catch (err) {
    publishError = err.message;
  }

  return {
    seq,
    state,
    reason: reason ?? null,
    by: actor.id,
    at: record.time,
    published,
    publishError,
    // The server asked. Whether the device complied is reported by the device.
    deviceConfirmed: false,
  };
}

/**
 * Record an emergency stop or clear that ORIGINATED AT THE EDGE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS NOT AN AUTHENTICATED ACTION AND MUST NEVER BECOME ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It takes no `actor` parameter because there is nothing to pass. The encoder
 * has no identity; there is no login at the LCD. A locally-originated action is
 * attributed as PHYSICAL PRESENCE — the person had to be standing in the room —
 * which is the third attribution tier and a stated design position, not a gap.
 *
 * Named `observeLocalEstop` rather than something like `setLocalEstop` so its
 * nature is obvious at a glance and nobody later "fixes" it by adding an actor
 * check. The server is OBSERVING a fact the device reports, not performing an
 * action.
 *
 * setEstop() keeps its strict `if (!actor?.id) throw` guard. Remote and local
 * do not share a code path, deliberately.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IDEMPOTENCY IS KEYED ON device_since, NEVER ON OBSERVATION TIME
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A flaky network means repeated reconnects re-reporting the same stop. The
 * observation time changes on every reconnect, so keying on it would produce
 * one record per reconnect rather than one record per stop. The device's
 * reported start time is the only stable identifier available.
 *
 * @param {'stopped'|'clear'} state   what the device reports
 * @param {number} deviceSince        device epoch seconds the state began
 * @param {boolean} retrospective     true when learned on reconnect, not live
 */
export async function observeLocalEstop({ state, deviceSince, retrospective = false, publisher, logger = console }) {
  if (!['stopped', 'clear'].includes(state)) {
    throw new EstopError('state must be stopped or clear', 'bad_state');
  }

  const current = await getServerEstop();
  if (current.state === state) {
    return { recorded: false, reason: 'server record already matches the device' };
  }

  // Idempotency. Keyed on the device's reported start time.
  if (deviceSince != null) {
    const dup = await query(
      `SELECT id FROM server_events
       WHERE gh_id = $1
         AND event_type IN ('ESTOP_TRIGGERED', 'ESTOP_CLEARED')
         AND detail->>'source' = 'local'
         AND detail->>'device_since' = $2
       LIMIT 1`,
      [config.ghId, String(deviceSince)]
    );
    if (dup.rows.length > 0) {
      return { recorded: false, reason: 'already recorded for this device_since' };
    }
  }

  const seq = current.seq + 1;
  const observedAt = Math.floor(Date.now() / 1000);

  const record = await transaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO server_events (gh_id, event_type, ref_table, ref_id, actor_id, actor_role, detail)
       VALUES ($1, $2, 'none', 0, NULL, 'local', $3)
       RETURNING *`,
      [
        config.ghId,
        state === 'stopped' ? 'ESTOP_TRIGGERED' : 'ESTOP_CLEARED',
        JSON.stringify({
          seq,
          state,
          source: 'local',
          // BOTH timestamps, never collapsed. The record must be able to say
          // "device reports stopped at 14:03; server learned at 14:41."
          device_since: deviceSince ?? null,
          observed_at: observedAt,
          retrospective,
          // No actor, and saying so explicitly rather than leaving the null to
          // be read as missing data.
          sessionAttributed: false,
          physicalPresence: true,
        }),
      ]
    );

    if (state === 'clear') {
      await client.query(
        `UPDATE commands SET ack_result = 'rejected',
                             ack_reason = '{"code":"ESTOP","message":"cancelled by emergency stop"}'::jsonb,
                             acked_at = now()
         WHERE gh_id = $1 AND acked_at IS NULL`,
        [config.ghId]
      );
    }

    return inserted.rows[0];
  });

  // Catch-up publish: the server adopting a seq, not issuing a fresh order. The
  // device must not reset `since` on receiving it — see contract v4 §3.9.
  let published = false;
  let publishError = null;
  try {
    await publisher.publishEstop({ seq, state, reason: null, by: null, source: 'local' });
    published = true;
  } catch (err) {
    publishError = err.message;
  }

  logger.warn?.(
    `SDIGF_LOCAL_ESTOP ${state} seq=${seq} device_since=${deviceSince} ` +
      `retrospective=${retrospective} — originated at the enclosure, no identified actor`
  );

  return {
    recorded: true,
    seq,
    state,
    source: 'local',
    deviceSince: deviceSince ?? null,
    observedAt,
    retrospective,
    at: record.time,
    published,
    publishError,
  };
}

/** Recent stop history, for the activity feed and the thesis. */
export async function listEstopEvents({ limit = 20 } = {}) {
  const r = await query(
    `SELECT id, time, event_type, actor_id, actor_role, detail
     FROM server_events
     WHERE gh_id = $1 AND event_type IN ('ESTOP_TRIGGERED', 'ESTOP_CLEARED')
     ORDER BY time DESC LIMIT $2`,
    [config.ghId, limit]
  );
  return r.rows.map((row) => ({
    id: row.id,
    time: row.time,
    type: row.event_type,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    seq: row.detail?.seq,
    reason: row.detail?.reason,
    source: row.detail?.source ?? 'remote',
    deviceSince: row.detail?.device_since ?? null,
    observedAt: row.detail?.observed_at ?? null,
    retrospective: row.detail?.retrospective === true,
  }));
}
