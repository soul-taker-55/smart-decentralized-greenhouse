// Postgres access and the write buffer.
//
// The buffer exists because MQTT delivery and database availability are
// independent failures. Without it, a thirty-second database restart would
// either block the MQTT client's event loop or throw away every message that
// arrived during the window. With it, writes queue in order and drain when the
// database returns.
//
// The queue is BOUNDED. When it fills, the oldest entry is discarded and a
// counter increments. That is a deliberate trade: telemetry is QoS 0 and
// already best-effort, so losing the oldest rows during a long outage is
// acceptable, whereas an unbounded queue would grow until the container is
// OOM-killed and lose everything including the ability to recover.

import pg from 'pg';
import { config } from './config.js';
import { log } from './log.js';

const { Pool } = pg;

export const pool = new Pool({
  host: config.pg.host,
  port: config.pg.port,
  user: config.pg.user,
  password: config.pg.password,
  database: config.pg.database,
  max: config.pg.max,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  // Idle client errors are normal during a database restart. Log and let the
  // pool replace the connection; do not crash.
  log.warn('db', 'idle client error', { message: err.message });
});

// ---------------------------------------------------------------------------
// Write queue
// ---------------------------------------------------------------------------

const queue = [];
let draining = false;
let backoffMs = 1000;

export const stats = {
  queued: 0,
  written: 0,
  dropped: 0,
  skippedDuplicate: 0,
  rejectedInvalid: 0,
};

const MAX_BACKOFF_MS = 30_000;

/**
 * Queue a unit of work. `run` receives a pooled client and must perform all of
 * its statements on that client, so a multi-statement write stays on one
 * connection.
 */
export const enqueue = (label, run) => {
  if (queue.length >= config.maxQueueDepth) {
    queue.shift();
    stats.dropped += 1;
    if (stats.dropped % 100 === 1) {
      log.warn('db', 'write queue full, discarding oldest', {
        depth: queue.length,
        droppedTotal: stats.dropped,
      });
    }
  }
  queue.push({ label, run });
  stats.queued += 1;
  drain();
};

// Drains in order, one task at a time. Order matters: an ONLINE event followed
// by telemetry should land in that sequence, and parallel writes would not
// guarantee it. Throughput is not a concern at one message per thirty seconds.
const drain = async () => {
  if (draining) return;
  draining = true;

  while (queue.length > 0) {
    const task = queue[0];
    let client;
    try {
      client = await pool.connect();
      await task.run(client);
      queue.shift();
      stats.written += 1;
      backoffMs = 1000;
    } catch (err) {
      // Distinguish "the database is unreachable" from "this particular row is
      // invalid". Retrying a constraint violation forever would wedge the queue
      // behind one bad message, so those are dropped and counted instead.
      if (isDataError(err)) {
        log.error('db', `dropping invalid write: ${task.label}`, {
          code: err.code,
          message: err.message,
        });
        queue.shift();
        stats.rejectedInvalid += 1;
        continue;
      }

      log.warn('db', `write failed, retrying in ${backoffMs}ms: ${task.label}`, {
        code: err.code,
        message: err.message,
        depth: queue.length,
      });
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    } finally {
      if (client) client.release();
    }
  }

  draining = false;
};

// Postgres class 22 (data exception) and 23 (integrity constraint violation)
// mean the payload is wrong, not the connection. Retrying cannot help.
const isDataError = (err) =>
  typeof err.code === 'string' && (err.code.startsWith('22') || err.code.startsWith('23'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const queueDepth = () => queue.length;

export const shutdownDb = async () => {
  // Give the queue a bounded chance to flush rather than dropping it silently.
  const deadline = Date.now() + 5000;
  while (queue.length > 0 && Date.now() < deadline) {
    await sleep(100);
  }
  if (queue.length > 0) {
    log.warn('db', 'exiting with unflushed writes', { depth: queue.length });
  }
  await pool.end();
};
