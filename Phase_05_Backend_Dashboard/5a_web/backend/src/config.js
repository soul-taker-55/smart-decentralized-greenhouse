/**
 * SDIGF backend — environment configuration.
 *
 * Every value comes from the environment (Dokploy's environment tab). Nothing is
 * committed. Variable names mirror the 04d bridge exactly, so one mental model
 * covers both services and a working bridge deployment is a usable template.
 *
 * Missing required values throw at import time rather than at first use. A
 * service that starts successfully and then fails on the first database query is
 * strictly worse than one that refuses to start.
 */

function required(name) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optional(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function optionalInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${v}"`);
  }
  return n;
}

export const config = {
  port: optionalInt('PORT', 3000),
  logLevel: optional('LOG_LEVEL', 'info'),

  /** The greenhouse this backend instance serves. Contract carries `gh`. */
  ghId: optional('GH_ID', 'gh1'),

  /** Human-readable name for the dashboard status strip. */
  ghName: optional('GH_NAME', 'Greenhouse Prototype'),
  ghPlants: optional('GH_PLANTS', 'Lettuce & Chicory'),

  db: {
    host: optional('PG_HOST', 'sdigf-db'),
    port: optionalInt('PG_PORT', 5432),
    user: optional('PG_USER', 'postgres'),
    password: required('PG_PASS'),
    database: optional('PG_DB', 'sdigf_backend'),
    /** The bridge's logging database — read-only from here, for telemetry. */
    telemetryDatabase: optional('PG_TELEMETRY_DB', 'sdigf_db'),
  },

  mqtt: {
    host: optional('MQTT_HOST', 'sdigf-emqx'),
    port: optionalInt('MQTT_PORT', 1883),
    user: optional('MQTT_USER', 'sdigf-backend'),
    password: required('MQTT_PASS'),
    clientId: optional('MQTT_CLIENT_ID', 'sdigf-backend'),
  },

  /**
   * Maximum ttl_s accepted on a manual command.
   *
   * PROVISIONAL — this is a placeholder, not a physics-derived value. A flat cap
   * does not reflect that different actuators have very different safe
   * durations: the pump has a max-runtime guard, relays have minimum-off-time,
   * and the humidifier has neither. Reconcile against Phase 02's safety envelope
   * once real per-actuator limits exist, and replace this with a per-target map.
   *
   * Deliberately NOT a database CHECK constraint — a provisional value that will
   * become per-actuator should not require a migration to change.
   */
  commandTtlMaxS: optionalInt('COMMAND_TTL_MAX_S', 3600),
};

/** Topic tree, contract v4 §1. Built once so no route string is ever hand-typed. */
export const topics = {
  telemetry: `sdigf/v1/${config.ghId}/up/telemetry`,
  actuators: `sdigf/v1/${config.ghId}/up/actuators`,
  health: `sdigf/v1/${config.ghId}/up/health`,
  ack: `sdigf/v1/${config.ghId}/up/ack`,
  status: `sdigf/v1/${config.ghId}/status`,
  config: `sdigf/v1/${config.ghId}/down/config`,
  cmd: `sdigf/v1/${config.ghId}/down/cmd`,
  keys: `sdigf/v1/${config.ghId}/down/keys`,
};
