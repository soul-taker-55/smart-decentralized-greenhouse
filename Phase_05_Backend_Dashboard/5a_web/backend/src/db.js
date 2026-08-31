/**
 * SDIGF backend — database access.
 *
 * TWO POOLS, DELIBERATELY SEPARATE:
 *
 *   `pool`          → sdigf_backend  — the backend's own tables. Read AND write.
 *   `telemetryPool` → sdigf_db       — the bridge's logging database. READ ONLY.
 *
 * The split matters architecturally, not just tidily. Phase 04's claim is that
 * "no code path exists from the logging tier to an actuator" — a structural
 * guarantee. The backend reads telemetry to render a dashboard, but must never
 * write to the logging database, or that separation becomes a policy that
 * depends on nobody making a mistake rather than a fact about the code.
 *
 * Every query against telemetryPool goes through `queryTelemetry`, which is the
 * one place to look when auditing that claim.
 */

import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

/**
 * Postgres returns BIGINT as a string by default, because a bigint can exceed
 * Number.MAX_SAFE_INTEGER. Our ids will not, and silently getting "1" where the
 * code expects 1 causes comparison bugs that pass tests and fail in the browser.
 * Parsing them as numbers is safe here and removes a whole class of surprise.
 *
 * ⚠ THE PHASE 07 LEDGER DEPENDS ON THIS LINE. DO NOT REMOVE IT.
 *
 * seq, event_id and ref_id are part of the HASHED CONTENT of every ledger link.
 * Without this parser they arrive as STRINGS, canonicalize() quotes them, and
 * every hash the writer produces changes — while NOTHING RAISES AN ERROR. The
 * writer keeps emitting well-formed links that no longer match anything already
 * stored, and the damage only surfaces later as wholesale verification failure
 * that is indistinguishable from tampering.
 *
 * Pinned by test/ledger-link.test.js ("INT8 PIN"), which asserts that a string
 * id and a numeric id hash differently.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

/** Read-write pool for the backend's own database. */
export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

/** Read-only pool for the bridge's logging database. */
export const telemetryPool = new Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.telemetryDatabase,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

/**
 * SQL verbs this service may issue against the logging database.
 *
 * A runtime guard, not a substitute for real database permissions. Granting the
 * backend a SELECT-only Postgres role on sdigf_db would be the durable fix and
 * is worth doing before production; this catches the mistake during development,
 * where it would otherwise surface as silent corruption of the thesis dataset.
 */
const READ_ONLY_PREFIX = /^\s*(SELECT|WITH)\b/i;

/**
 * Query the bridge's logging database. Read-only by construction.
 *
 * @param {string} text
 * @param {unknown[]} [params]
 */
export async function queryTelemetry(text, params = []) {
  if (!READ_ONLY_PREFIX.test(text)) {
    throw new Error(
      'queryTelemetry accepts SELECT/WITH only — the backend must never write to the logging database'
    );
  }
  return telemetryPool.query(text, params);
}

/** Query the backend's own database. */
export async function query(text, params = []) {
  return pool.query(text, params);
}

/**
 * Run a function inside a transaction, committing on success and rolling back on
 * any throw.
 *
 * Config activation needs this and cannot work without it: promoting a profile to
 * ACTIVE requires demoting the current ACTIVE first, and the partial unique index
 * `WHERE status='ACTIVE'` will reject the second one otherwise. Both statements
 * have to land together or neither does.
 *
 * @template T
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // A rollback failure means the connection is already broken; the original
      // error is the one worth surfacing.
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Verify both databases are reachable and shaped as expected.
 *
 * Called at startup. Checks the tables actually exist rather than only that a
 * connection opens, because a backend pointed at the wrong database connects
 * perfectly happily and then fails on every request.
 */
export async function checkConnections() {
  const result = { backend: false, telemetry: false, errors: [] };

  try {
    const r = await query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('config_profiles', 'server_events', 'commands')`
    );
    if (r.rows.length !== 3) {
      const found = r.rows.map((x) => x.table_name);
      result.errors.push(
        `Backend database "${config.db.database}" is missing tables. Expected config_profiles, server_events, commands — found: ${found.join(', ') || 'none'}. Run the migrations in 5a_web/db/.`
      );
    } else {
      result.backend = true;
    }
  } catch (err) {
    result.errors.push(`Cannot reach backend database "${config.db.database}": ${err.message}`);
  }

  try {
    const r = await queryTelemetry(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('telemetry', 'actuator_state', 'edge_events')`
    );
    if (r.rows.length !== 3) {
      result.errors.push(
        `Telemetry database "${config.db.telemetryDatabase}" is missing expected bridge tables.`
      );
    } else {
      result.telemetry = true;
    }
  } catch (err) {
    // Not fatal. The dashboard degrades gracefully with no telemetry, which is
    // the current expected state anyway with the mock stopped.
    result.errors.push(
      `Cannot reach telemetry database "${config.db.telemetryDatabase}": ${err.message} (dashboard will show empty state)`
    );
  }

  return result;
}

/** Close both pools. */
export async function closePools() {
  await Promise.allSettled([pool.end(), telemetryPool.end()]);
}
