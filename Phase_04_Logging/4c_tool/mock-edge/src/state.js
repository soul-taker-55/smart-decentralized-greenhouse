// SDIGF mock edge — applied state.
//
// Stands in for the ESP32's NVS: the configuration the device is actually
// running, and any manual overrides currently in force.
//
// ═══════════════════════════════════════════════════════════════════════════
// TWO PROPERTIES THIS FILE EXISTS TO GUARANTEE
// ═══════════════════════════════════════════════════════════════════════════
//
// 1. THE DEVICE NEVER ENDS UP RUNNING NOTHING.
//    A rejected config leaves the previous one in force. Contract §3.4 makes
//    this explicit in the ack schema: on rejection, `applied` reports the
//    PREVIOUS config, not the rejected one. A device that fell back to "no
//    config" on a bad update would be one malformed message away from an
//    unmanaged enclosure.
//
// 2. OVERRIDE EXPIRY IS LOCAL, ALWAYS.
//    The countdown runs here. It does not wait for a release command, does not
//    re-fetch from the server, and is unaffected by MQTT dropping mid-override.
//    An unreachable server must never mean a stuck actuator — that is the
//    edge-autonomy principle applied to manual control, and it is why every
//    command in this system is inherently temporary rather than temporarily
//    trusted.
//
// ═══════════════════════════════════════════════════════════════════════════
// PORTING NOTE FOR PHASE 02
// ═══════════════════════════════════════════════════════════════════════════
//
// On real hardware, `applied` persists to NVS and `overrides` does NOT.
// Contract §3.7 rule 5: overrides do not survive reboot. After a power cut the
// edge resumes autonomous control on last-known-good config, because an
// operator override silently persisting across a restart is how a pump ends up
// running unattended for a week. This mock holds both in memory, which
// reproduces that behaviour for free — a restart loses both, and the config is
// then re-received from the broker's retained message.

export class EdgeState {
  constructor() {
    /**
     * The config currently in force.
     *
     * ver 0 with src 'none' is the first-boot state, and it is a real state
     * rather than a placeholder: the device has never received a config and
     * says so. The dashboard renders it as "no configuration", and the bridge
     * accepts cfg_src 'none' because migration 003 widened the CHECK
     * constraint for exactly this case.
     */
    this.applied = {
      ver: 0,
      hash: null,
      src: 'none',
      cfg: null,
    };

    /**
     * Active manual overrides, keyed by actuator.
     *   { target: { action, value, ttl_s, expiresAt, id, via } }
     */
    this.overrides = new Map();

    /** Set when an override expires, so the next actuator publish is immediate. */
    this.dirty = false;
  }

  // ── Config ────────────────────────────────────────────────────────────────

  /**
   * Adopt a validated config.
   *
   * `src` is 'mqtt' when it arrived over the wire. Real firmware also uses
   * 'nvs' after a reboot, when it resumes from stored config without the server
   * being involved at all — which is the single clearest piece of evidence for
   * edge autonomy in the whole event log.
   */
  applyConfig({ ver, hash, cfg, src = 'mqtt' }) {
    this.applied = { ver, hash, cfg, src };

    // Contract §3.7 rule 7: a newly APPROVED config cancels all active
    // overrides immediately. An approved recipe outranks an ad-hoc override —
    // otherwise an override placed before an approval would quietly survive it,
    // and the config the operator was told is running would not be.
    const cancelled = [...this.overrides.keys()];
    this.overrides.clear();
    if (cancelled.length > 0) this.dirty = true;
    return cancelled;
  }

  /** What `applied` reports in an ack. Never the rejected config. */
  appliedRef() {
    return { ver: this.applied.ver, hash: this.applied.hash };
  }

  // ── Overrides ─────────────────────────────────────────────────────────────

  setOverride({ target, action, value, ttl_s, id, via }) {
    // `release` ends an override early rather than starting one — contract
    // §3.7 rule 3. Handing an actuator back to autonomous control is not itself
    // an override, so it must not create one.
    if (action === 'release') {
      const existed = this.overrides.delete(target);
      this.dirty = true;
      return { released: true, existed };
    }

    this.overrides.set(target, {
      action,
      value: value ?? null,
      ttl_s,
      expiresAt: Date.now() + ttl_s * 1000,
      id,
      via: via ?? null,
    });
    this.dirty = true;
    return { released: false, existed: false };
  }

  /**
   * Expire anything past its deadline.
   *
   * Called on a local timer. Nothing external triggers this, and nothing
   * external can prevent it — which is the entire guarantee.
   *
   * @returns {string[]} actuators that just reverted to autonomous control
   */
  expireOverrides(now = Date.now()) {
    const expired = [];
    for (const [target, o] of this.overrides) {
      if (o.expiresAt <= now) {
        this.overrides.delete(target);
        expired.push(target);
      }
    }
    if (expired.length > 0) this.dirty = true;
    return expired;
  }

  /**
   * Remaining override seconds for an actuator, or null.
   *
   * Published as `ovr_s` in up/actuators. The DASHBOARD DISPLAYS THIS RATHER
   * THAN COMPUTING issued_at + ttl_s, because only the device knows how much
   * time is actually left. A server-side estimate would drift on clock skew and
   * would keep counting down confidently while the device was unreachable —
   * exactly when it is least entitled to.
   */
  remainingSeconds(target, now = Date.now()) {
    const o = this.overrides.get(target);
    if (!o) return null;
    return Math.max(0, Math.ceil((o.expiresAt - now) / 1000));
  }

  isOverridden(target) {
    return this.overrides.has(target);
  }

  getOverride(target) {
    return this.overrides.get(target) ?? null;
  }

  takeDirty() {
    const was = this.dirty;
    this.dirty = false;
    return was;
  }
}
