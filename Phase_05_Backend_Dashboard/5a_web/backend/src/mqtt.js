/**
 * SDIGF backend — MQTT publisher.
 *
 * THE ONLY THING IN THIS PROJECT THAT PUBLISHES TO down/config AND down/cmd.
 * The 04d bridge is read-only by design and must stay that way; that separation
 * is what lets the thesis claim no code path exists from the logging tier to an
 * actuator. This module is the counterpart: it publishes and never writes to the
 * logging database.
 *
 * ─── THE RETAINED-MESSAGE LESSON ───────────────────────────────────────────
 *
 * Phase 04 found EMQX's retainer defaulting to `storage_type = ram`, which
 * silently destroyed every retained message on broker restart. It is now `disc`,
 * but the architectural conclusion outlives the fix:
 *
 *   THE RETAINED MESSAGE IS A CACHE, NEVER A SOURCE OF TRUTH.
 *
 * The database holds the authoritative config. The broker holds a copy for fast
 * delivery to a reconnecting ESP32. So this module REPUBLISHES the active config
 * on startup and on every reconnect, reconstructing broker state from the
 * database rather than assuming the broker kept it.
 *
 * ─── WHY PUBLISH IS VERIFIED BY READ-BACK ──────────────────────────────────
 *
 * EMQX's `deny_action` can make a denied publish return success with no error.
 * That failure presents as "config approved and applied, but the device never
 * received it" and gets misdiagnosed as a firmware fault — it has bitten this
 * project before. deny_action is now `disconnect`, which makes it loud, but
 * relying on that is relying on a setting rather than on evidence.
 *
 * So the backend subscribes to its OWN down/config and confirms the retained
 * message came back with the expected cfg_hash. Publishing is not "done" until
 * the broker hands the message back.
 */

import mqtt from 'mqtt';
import { config, topics } from './config.js';

/** Contract v4 envelope version. */
const ENVELOPE_V = 1;

/** How long to wait for a published config to come back on read-back. */
const READBACK_TIMEOUT_MS = 5000;

export class PublishError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'PublishError';
    this.cause = cause;
  }
}

/**
 * Wraps an mqtt client with the project's publishing rules.
 *
 * Events emitted (via `on`):
 *   connect / reconnect / offline / error
 *   ack       — an up/ack payload arrived
 *   actuators — an up/actuators payload arrived
 *   health    — an up/health payload arrived
 *   status    — a status payload arrived (online/offline last will)
 */
export class MqttPublisher {
  constructor({ onRepublishNeeded = null, logger = console } = {}) {
    this.client = null;
    this.log = logger;
    this.connected = false;
    this.handlers = new Map();

    /**
     * Called on connect AND on every reconnect, so the caller can push the
     * active config back onto the broker. Passed in rather than importing the
     * config service directly, to keep this module free of database concerns.
     */
    this.onRepublishNeeded = onRepublishNeeded;

    /** Pending read-back confirmations, keyed by cfg_hash. */
    this.pendingReadbacks = new Map();

    /** Last seen retained/live payloads, for the status endpoint. */
    this.lastSeen = {
      actuators: null,
      health: null,
      status: null,
      ack: null,
      configEcho: null,
      estopEcho: null,
    };
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(fn);
    return this;
  }

  emit(event, payload) {
    for (const fn of this.handlers.get(event) ?? []) {
      try {
        fn(payload);
      } catch (err) {
        this.log.error?.(`[mqtt] handler for "${event}" threw:`, err);
      }
    }
  }

  /**
   * Connect, subscribe, and republish.
   *
   * Resolves only after subscriptions are established AND the republish hook has
   * run — not merely when the broker acknowledges the connection. The difference
   * matters: publishConfig confirms delivery by reading its own message back, so
   * a caller that publishes before the down/config subscription exists would wait
   * for a read-back that can never arrive and time out against a broker that did
   * nothing wrong.
   */
  async connect() {
    const url = `mqtt://${config.mqtt.host}:${config.mqtt.port}`;

    // Resolved at the END of the connect handler, after subscribe + republish.
    let readyResolve;
    let readyReject;
    const ready = new Promise((res, rej) => {
      readyResolve = res;
      readyReject = rej;
    });

    this.client = mqtt.connect(url, {
      clientId: config.mqtt.clientId,
      username: config.mqtt.user,
      password: config.mqtt.password,
      // Persistent session: the broker keeps our subscriptions across a short
      // disconnect, so we do not miss an ack that lands mid-reconnect.
      clean: false,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
    });

    this.client.on('message', (topic, payload) => this.#handleMessage(topic, payload));

    this.client.on('connect', async (packet) => {
      this.connected = true;
      // sessionPresent false means the broker discarded our session and our
      // subscriptions are gone. Logging it explicitly matters: the 04d bridge
      // had silent reconnects that read as failures until this was surfaced.
      this.log.info?.(
        `[mqtt] connected to ${url} as ${config.mqtt.user} {"sessionPresent":${packet.sessionPresent}}`
      );

      await this.#subscribe();

      // Reconstruct broker state from the database. Runs on first connect and
      // every reconnect, because a broker that restarted may have lost the
      // retained config even with disc storage (and certainly would have on ram).
      if (this.onRepublishNeeded) {
        try {
          await this.onRepublishNeeded();
        } catch (err) {
          // A failed republish must not prevent the service coming up. The
          // dashboard is still useful, and the next reconnect retries.
          this.log.error?.('[mqtt] republish after connect failed:', err);
        }
      }

      readyResolve();
      this.emit('connect', packet);
    });

    this.client.on('reconnect', () => {
      this.log.warn?.('[mqtt] reconnecting');
      this.emit('reconnect');
    });

    this.client.on('offline', () => {
      this.connected = false;
      this.log.warn?.('[mqtt] offline');
      this.emit('offline');
    });

    this.client.on('error', (err) => {
      this.log.error?.('[mqtt] error:', err.message);
      this.emit('error', err);
    });

    const timer = setTimeout(
      () => readyReject(new PublishError(`MQTT connect timed out after 15s to ${url}`)),
      15000
    );
    this.client.once('error', (err) =>
      readyReject(new PublishError(`MQTT connect failed: ${err.message}`, err))
    );

    try {
      await ready;
    } finally {
      clearTimeout(timer);
    }
  }

  async #subscribe() {
    // up/* and status: to render the dashboard and correlate acks.
    // down/config: to read back our OWN publishes and confirm delivery.
    //
    // Subscribing to down/config is deliberate and is covered by the broker ACL
    // written for sdigf-backend. It is not a control path — reading a retained
    // message we published ourselves cannot actuate anything.
    const subs = [
      [topics.actuators, 1],
      [topics.health, 0],
      [topics.ack, 1],
      [topics.status, 1],
      [topics.config, 1],
      [topics.estop, 1],
    ];

    for (const [topic, qos] of subs) {
      await new Promise((resolve) => {
        this.client.subscribe(topic, { qos }, (err, granted) => {
          if (err) {
            this.log.error?.(`[mqtt] subscribe failed ${topic}:`, err.message);
          } else {
            const g = granted?.[0];
            // Granted QoS 128 means the broker REFUSED the subscription — an
            // ACL denial. It arrives as success unless you check.
            if (g && g.qos === 128) {
              this.log.error?.(
                `[mqtt] subscription DENIED for ${topic} — check the broker ACL for ${config.mqtt.user}`
              );
            } else {
              this.log.info?.(`[mqtt] subscribed ${topic} qos=${g?.qos ?? qos}`);
            }
          }
          resolve();
        });
      });
    }
  }

  #handleMessage(topic, payload) {
    let parsed;
    try {
      parsed = JSON.parse(payload.toString('utf8'));
    } catch {
      this.log.warn?.(`[mqtt] non-JSON payload on ${topic}, ignored`);
      return;
    }

    if (topic === topics.estop) {
      this.lastSeen.estopEcho = parsed;
      this.emit('estop', parsed);
      return;
    }

    if (topic === topics.config) {
      // Our own retained config coming back. This is the delivery confirmation.
      this.lastSeen.configEcho = parsed;
      const pending = this.pendingReadbacks.get(parsed.cfg_hash);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingReadbacks.delete(parsed.cfg_hash);
        pending.resolve(parsed);
      }
      return;
    }

    if (topic === topics.actuators) {
      this.lastSeen.actuators = parsed;
      this.emit('actuators', parsed);
      return;
    }
    if (topic === topics.health) {
      this.lastSeen.health = parsed;
      this.emit('health', parsed);
      return;
    }
    if (topic === topics.status) {
      this.lastSeen.status = parsed;
      this.emit('status', parsed);
      return;
    }
    if (topic === topics.ack) {
      this.lastSeen.ack = parsed;
      this.emit('ack', parsed);
      return;
    }
  }

  /**
   * Publish an APPROVED config to down/config, retained, and confirm by read-back.
   *
   * The envelope carries `gh` and `ver` as CONVENIENCE COPIES. The authoritative
   * values live inside cfg_canonical, which is what the signatures cover. The
   * edge must compare envelope against signed content and reject on mismatch —
   * without that comparison the envelope copies reintroduce the replay hole they
   * were moved inside the signature to close.
   *
   * @param {object} profile - a profile from the config service
   * @param {object} [opts]
   * @param {Array} [opts.sigs] - signatures; empty in 05a, populated in 05b
   * @param {number} [opts.keysVer] - trusted key list version; null until Phase 03
   * @param {boolean} [opts.verify=true] - confirm by read-back
   */
  async publishConfig(profile, { sigs = [], keysVer = null, verify = true } = {}) {
    if (!this.client) throw new PublishError('MQTT client not connected');

    const envelope = {
      v: ENVELOPE_V,
      ts: Math.floor(Date.now() / 1000),
      gh: profile.ghId,
      ver: profile.ver,
      alg: 'es256',
      keys_ver: keysVer,
      cfg_hash: profile.cfgHash,
      cfg_canonical: profile.cfgCanonical,
      sigs,
    };

    const payload = JSON.stringify(envelope);
    const bytes = Buffer.byteLength(payload, 'utf8');

    // Contract §3.6: max expected is ~1600 B at four signatures, and firmware
    // must call setBufferSize(2048). PubSubClient's 256-byte default drops
    // oversized messages with no error, no callback, no disconnect.
    if (bytes > 2048) {
      throw new PublishError(
        `down/config payload is ${bytes} B, above the 2048 B ESP32 receive buffer — the device would drop it silently`
      );
    }
    if (bytes > 1600) {
      this.log.warn?.(`[mqtt] down/config is ${bytes} B, above the 1600 B expected maximum`);
    }

    const readback = verify ? this.#awaitReadback(profile.cfgHash) : null;

    await new Promise((resolve, reject) => {
      this.client.publish(topics.config, payload, { qos: 1, retain: true }, (err) => {
        if (err) reject(new PublishError(`publish to ${topics.config} failed: ${err.message}`, err));
        else resolve();
      });
    });

    this.log.info?.(`[mqtt] published config ver=${profile.ver} hash=${profile.cfgHash.slice(0, 12)}… ${bytes}B`);

    if (readback) {
      await readback;
      this.log.info?.(`[mqtt] read-back confirmed for ver=${profile.ver}`);
    }

    return { bytes, ts: envelope.ts };
  }

  /**
   * Wait for our own retained config to come back from the broker.
   *
   * A publish callback firing without error only means the broker accepted the
   * packet. Under some ACL configurations a denied publish is acknowledged and
   * discarded. Seeing the message return on our own subscription is evidence.
   */
  #awaitReadback(cfgHash) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReadbacks.delete(cfgHash);
        reject(
          new PublishError(
            `config published but did not come back within ${READBACK_TIMEOUT_MS}ms. ` +
              `CHECK THE BROKER FIRST: a denied publish can return success silently. ` +
              `Verify the ACL grants ${config.mqtt.user} publish on ${topics.config}.`
          )
        );
      }, READBACK_TIMEOUT_MS);

      this.pendingReadbacks.set(cfgHash, { resolve, reject, timer });
    });
  }

  /**
   * Publish a manual command to down/cmd. NOT retained.
   *
   * Contract §3.7: "A retained command would re-fire on every reconnect, meaning
   * a pump switched on manually last week would restart itself after a power cut.
   * Commands are events with an expiry; state belongs on the config topic."
   *
   * @param {object} cmd - { id, target, action, value?, ttl_s, by? }
   */
  async publishCommand(cmd) {
    if (!this.client) throw new PublishError('MQTT client not connected');

    const envelope = {
      v: ENVELOPE_V,
      ts: Math.floor(Date.now() / 1000),
      id: cmd.id,
      target: cmd.target,
      action: cmd.action,
      ttl_s: cmd.ttl_s,
    };
    if (cmd.value !== undefined && cmd.value !== null) envelope.value = cmd.value;
    // `by` is populated in 05b. Present in the schema from day one.
    if (cmd.by) envelope.by = cmd.by;

    const payload = JSON.stringify(envelope);

    await new Promise((resolve, reject) => {
      this.client.publish(topics.cmd, payload, { qos: 1, retain: false }, (err) => {
        if (err) reject(new PublishError(`publish to ${topics.cmd} failed: ${err.message}`, err));
        else resolve();
      });
    });

    this.log.info?.(`[mqtt] published cmd ${cmd.id} ${cmd.target}=${cmd.action} ttl=${cmd.ttl_s}s`);
    return { ts: envelope.ts };
  }

  /**
   * Publish an emergency stop, RETAINED.
   *
   * Retained because this is STATE, not an event — a controller rebooting into
   * a halted greenhouse must come back halted, without the server having to
   * detect the reconnection. Contract v4 §3.9.
   *
   * No read-back verification here, deliberately. A stop must be published as
   * fast as possible; waiting for the broker to hand the message back would add
   * latency to the one operation where latency is least acceptable. The device
   * acks, and the dashboard shows requested-but-unconfirmed until it does.
   */
  async publishEstop({ seq, state, reason, by, source = 'remote' }) {
    if (!this.client) throw new PublishError('MQTT client not connected');

    const envelope = {
      v: ENVELOPE_V,
      ts: Math.floor(Date.now() / 1000),
      gh: config.ghId,
      seq,
      state,
      // Where the stop ORIGINATED. `by` answers which identified person; these
      // are two different questions and overloading one to carry the other
      // would make a consumer reading by.role for authorisation see a value
      // that is not a role.
      source,
      by: by ? { user: by.id, role: by.role } : null,
      reason: reason ?? null,
    };

    await new Promise((resolve, reject) => {
      this.client.publish(topics.estop, JSON.stringify(envelope), { qos: 1, retain: true }, (err) =>
        err ? reject(new PublishError(`publish to ${topics.estop} failed: ${err.message}`, err)) : resolve()
      );
    });

    this.log.warn?.(`[mqtt] EMERGENCY STOP ${state} seq=${seq} by=${by?.id ?? 'unknown'}`);
    return { ts: envelope.ts };
  }

  /**
   * Clear the retained config. Used when there is no ACTIVE profile, so a
   * reconnecting device is not handed a config the server no longer considers
   * current. An empty retained payload deletes the retained message.
   */
  async clearRetainedConfig() {
    if (!this.client) throw new PublishError('MQTT client not connected');
    await new Promise((resolve, reject) => {
      this.client.publish(topics.config, '', { qos: 1, retain: true }, (err) =>
        err ? reject(new PublishError(err.message, err)) : resolve()
      );
    });
    this.log.info?.('[mqtt] cleared retained config');
  }

  /** Snapshot for the status endpoint. */
  getState() {
    return {
      connected: this.connected,
      broker: `${config.mqtt.host}:${config.mqtt.port}`,
      clientId: config.mqtt.clientId,
      lastSeen: this.lastSeen,
    };
  }

  async close() {
    for (const [, p] of this.pendingReadbacks) clearTimeout(p.timer);
    this.pendingReadbacks.clear();
    if (this.client) {
      await new Promise((resolve) => this.client.end(false, {}, resolve));
      this.client = null;
    }
    this.connected = false;
  }
}
