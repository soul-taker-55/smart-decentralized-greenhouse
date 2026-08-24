// up/health, status and up/ack → the `edge_events` table.
//
// These three topics are grouped because they answer the same class of
// question: not "what was the temperature" but "what was the device doing, and
// what was it running". The Phase 04 done-condition needs both.

import { config } from '../config.js';
import { enqueue, stats } from '../db.js';
import { log } from '../log.js';

const VALID_CFG_SRC = new Set(['mqtt', 'nvs']);

const insertEvent = (label, fields) =>
  enqueue(label, async (client) => {
    await client.query(
      `INSERT INTO edge_events
         (time, greenhouse_id, event_type, seq, boot_reason, cfg_src, cfg_ver, cfg_hash, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        fields.time,
        config.greenhouseId,
        fields.eventType,
        fields.seq ?? null,
        fields.bootReason ?? null,
        fields.cfgSrc ?? null,
        fields.cfgVer ?? null,
        fields.cfgHash ?? null,
        fields.payload ?? null,
      ]
    );
  });

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

// Uptime seen on the previous health message. A drop means the device restarted
// between the two — the only signal available, since the ESP32 cannot announce
// a reboot it has not yet booted from.
let lastUptimeS = null;

export const handleHealth = (payload, receivedAt) => {
  if (payload.v !== config.schemaVersion) {
    stats.rejectedInvalid += 1;
    log.error('health', `schema version ${payload.v}, expected ${config.schemaVersion}`);
    return;
  }

  const upS = Number.isInteger(payload.up_s) ? payload.up_s : null;
  const cfg = payload.cfg ?? {};
  const cfgSrc = VALID_CFG_SRC.has(cfg.src) ? cfg.src : null;

  // A reboot is inferred, not reported. If uptime went backwards the device
  // restarted, and that restart is worth its own row: `boot_reason` on the
  // health message that follows a brownout is the signature the hardware
  // documentation warns about, and it would otherwise be buried inside a
  // routine HEALTH row among hundreds.
  if (lastUptimeS !== null && upS !== null && upS < lastUptimeS) {
    log.info('health', 'reboot detected', {
      previousUptimeS: lastUptimeS,
      currentUptimeS: upS,
      bootReason: payload.boot_reason,
    });
    insertEvent('event REBOOT', {
      time: receivedAt,
      eventType: 'REBOOT',
      seq: Number.isInteger(payload.seq) ? payload.seq : null,
      bootReason: payload.boot_reason ?? null,
      cfgSrc,
      cfgVer: Number.isInteger(cfg.ver) ? cfg.ver : null,
      cfgHash: cfg.hash ?? null,
      payload: { previous_up_s: lastUptimeS, up_s: upS },
    });
  }
  if (upS !== null) lastUptimeS = upS;

  // The full health payload is kept as JSONB. Heap, RSSI and reconnect counts
  // do not each deserve a column — they are diagnostic context, read when
  // something has already gone wrong, not queried in aggregate.
  insertEvent('event HEALTH', {
    time: receivedAt,
    eventType: 'HEALTH',
    seq: Number.isInteger(payload.seq) ? payload.seq : null,
    bootReason: payload.boot_reason ?? null,
    cfgSrc,
    cfgVer: Number.isInteger(cfg.ver) ? cfg.ver : null,
    cfgHash: cfg.hash ?? null,
    payload,
  });
};

// ---------------------------------------------------------------------------
// Status (retained, last will)
// ---------------------------------------------------------------------------

export const handleStatus = (payload, receivedAt) => {
  const state = payload?.state;
  if (state !== 'online' && state !== 'offline') {
    stats.rejectedInvalid += 1;
    log.error('status', `unrecognised state '${state}'`);
    return;
  }

  // The offline message is a last will: its bytes were fixed when the device
  // connected, possibly hours earlier, so it carries no timestamp and cannot.
  // Receipt time is the only honest answer for when the device went away, and
  // the contract says so explicitly. The online message does carry `ts`, but it
  // is ignored here for the same reason every other timestamp is — one time
  // axis, one meaning.
  log.info('status', `device ${state}`);

  insertEvent(`event ${state.toUpperCase()}`, {
    time: receivedAt,
    eventType: state === 'online' ? 'ONLINE' : 'OFFLINE',
    payload,
  });

  // A restart invalidates the uptime baseline. Without this, the first health
  // message after a reconnect would be compared against a stale figure and
  // could either miss a reboot or invent one.
  if (state === 'offline') lastUptimeS = null;
};

// ---------------------------------------------------------------------------
// Ack
// ---------------------------------------------------------------------------

export const handleAck = (payload, receivedAt) => {
  if (payload.v !== config.schemaVersion) {
    stats.rejectedInvalid += 1;
    log.error('ack', `schema version ${payload.v}, expected ${config.schemaVersion}`);
    return;
  }

  const result = payload.result;
  const applied = payload.applied ?? {};
  const ref = payload.ref ?? {};

  insertEvent('event ACK', {
    time: receivedAt,
    eventType: 'ACK',
    seq: Number.isInteger(payload.seq) ? payload.seq : null,
    cfgVer: Number.isInteger(ref.ver) ? ref.ver : null,
    cfgHash: ref.hash ?? null,
    payload,
  });

  // An accepted ack gets a second row. This is the moment the evidence chain
  // closes: a config that was proposed, approved and published is now provably
  // the config the hardware is running. A query for "what was actually applied,
  // and when" should not have to filter ACK rows on a nested JSON field to find
  // it.
  if (result === 'accepted') {
    log.info('ack', 'config applied', { ver: applied.ver, hash: applied.hash });
    insertEvent('event CONFIG_APPLIED', {
      time: receivedAt,
      eventType: 'CONFIG_APPLIED',
      seq: Number.isInteger(payload.seq) ? payload.seq : null,
      cfgVer: Number.isInteger(applied.ver) ? applied.ver : null,
      cfgHash: applied.hash ?? null,
      payload: { ref, applied },
    });
  } else {
    // A rejection is not an error in the bridge — it is the safety envelope
    // doing its job, and it is one of the more interesting things the log will
    // contain.
    log.warn('ack', 'config rejected by edge', {
      reason: payload.reason,
      refVer: ref.ver,
      stillRunning: applied.ver,
    });
  }
};
