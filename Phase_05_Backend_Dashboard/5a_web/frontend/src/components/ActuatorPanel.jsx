import { useState } from 'react';
import { api, formatAge } from '../api.js';

/**
 * Seven binary relays plus one positional actuator.
 *
 * Display names are what an operator calls the thing, not the contract key.
 * The keys stay exact because they are what down/cmd carries.
 */
const RELAY_LABELS = {
  pump: 'Pump',
  s_fan: 'South fan',
  internal_fan: 'Internal fan',
  n_fan: 'North fan',
  humidifier: 'Humidifier',
  lights: 'Normal lights',
  grow_light: 'Grow light (mains)',
};

/**
 * Where an actuator's current state came from.
 *
 * `safety` means the firmware envelope overrode both the control loop and any
 * operator command. It is the most important of the three to see, because it
 * says the hardware refused what it was told.
 */
function SourceTag({ src }) {
  if (!src) return null;
  const label = { auto: 'Automatic', manual: 'Manual', safety: 'Safety limit' }[src] ?? src;
  return <span className={`src src-${src}`}>{label}</span>;
}

/**
 * One relay row.
 *
 * The override countdown comes from the DEVICE (`ovr_s` in up/actuators), never
 * from issued_at + ttl_s. Expiry is edge-local: the ESP32 runs the timer and
 * reverts on its own. A server-side estimate would drift on any clock skew or
 * missed message, and would keep counting confidently while the device was
 * unreachable — exactly when it is least entitled to.
 */
function RelayRow({ a }) {
  const known = a.on !== null && a.on !== undefined;
  const overrideLeft = a.overrideRemainingSeconds;

  return (
    <div className={`arow ${a.overridden ? 'overridden' : ''}`}>
      <div className="arow-name">
        <i className={`lamp ${!known ? 'unknown' : a.on ? 'on' : 'off'}`} />
        {RELAY_LABELS[a.actuator] ?? a.actuator}
      </div>

      <div className="arow-state num">{!known ? '—' : a.on ? 'ON' : 'OFF'}</div>

      <div className="arow-meta">
        <SourceTag src={a.src} />
        {known && a.forSeconds != null && (
          <span className="dur num" title="Time held in the current state">
            {formatAge(a.forSeconds)?.replace(' ago', '') ?? ''}
          </span>
        )}
      </div>

      <div className="arow-ovr">
        {a.overridden && (
          <span className="ovr num" title="Reported by the device. The countdown runs on the controller, not here.">
            MANUAL · {overrideLeft != null ? `${Math.floor(overrideLeft / 60)}:${String(overrideLeft % 60).padStart(2, '0')}` : '—'} left
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Canopy gauge.
 *
 * Position is BELIEVED, not measured — the MG996R has no feedback. This is what
 * the firmware commanded, and it may not match reality if the canopy jammed.
 * Saying so on the panel is the difference between an operator trusting the
 * number and an operator checking the enclosure.
 */
function Canopy({ canopy }) {
  const pos = canopy?.positionPct;
  const known = pos !== null && pos !== undefined;

  return (
    <div className="card canopy">
      <div className="card-head">
        <span className="label">Shade canopy</span>
        <span className="unit">% closed</span>
      </div>
      <div className="card-note">Commanded position — the servo reports no feedback</div>

      <div className="canopy-body">
        <div className="canopy-val num">{known ? pos : '—'}</div>
        <div className="canopy-track" role="img" aria-label={`Canopy ${known ? pos : 'unknown'} percent closed`}>
          <div className="canopy-fill" style={{ width: `${known ? pos : 0}%` }} />
        </div>
        <div className="canopy-ends">
          <span>Open</span>
          <span>Closed</span>
        </div>
      </div>

      <div className="canopy-foot">
        <SourceTag src={canopy?.src} />
      </div>
    </div>
  );
}

/**
 * Ventilation stage.
 *
 * Published by the device even though it is derivable from the three fan
 * booleans, so the server never reimplements the fan-to-stage mapping and the
 * two cannot drift apart. Shown as four discrete steps because that is what the
 * control policy is actually written against.
 */
function VentStage({ stage }) {
  const known = stage !== null && stage !== undefined;
  return (
    <div className="card">
      <div className="card-head">
        <span className="label">Ventilation</span>
        <span className="unit">stage 0–3</span>
      </div>
      <div className="card-note">Fans running, reported by the controller</div>
      <div className="vent-body">
        <div className="vent-val num">{known ? stage : '—'}</div>
        <div className="vent-steps">
          {[0, 1, 2, 3].map((s) => (
            <span key={s} className={`vent-step ${known && stage >= s && s > 0 ? 'lit' : ''} ${known && stage === s ? 'here' : ''}`} />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Manual override controls.
 *
 * Every command carries a mandatory expiry. The form cannot be submitted
 * without one, because the contract has no unbounded overrides — and because
 * that bound is what keeps the blast radius of any command small by design
 * rather than by trust.
 */
function CommandForm({ targets, onIssued }) {
  const [target, setTarget] = useState('humidifier');
  const [action, setAction] = useState('on');
  const [value, setValue] = useState(50);
  const [minutes, setMinutes] = useState(5);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const isCanopy = target === 'canopy';
  const maxMinutes = Math.floor((targets?.ttlMaxSeconds ?? 3600) / 60);

  // Canopy is positional; the seven relays are binary. Keeping the action list
  // honest per-target stops the server having to reject an impossible pairing.
  const actions = isCanopy ? ['set', 'release'] : ['on', 'off', 'release'];
  const effectiveAction = actions.includes(action) ? action : actions[0];

  async function submit() {
    setBusy(true);
    setResult(null);
    const body = { target, action: effectiveAction, ttl_s: minutes * 60 };
    if (effectiveAction === 'set') body.value = Number(value);

    const { data, error } = await api.issueCommand(body);
    setBusy(false);
    if (error) {
      setResult({ ok: false, message: error });
    } else {
      setResult({ ok: true, message: `Sent to ${target}. The controller will revert on its own after ${minutes} minutes.` });
      onIssued?.();
    }
  }

  return (
    <div className="card cmd">
      <div className="card-head">
        <span className="label">Take manual control</span>
      </div>
      <div className="card-note">
        Overrides one actuator only. The controller reverts to the approved settings when the
        time runs out, even if this server is unreachable.
      </div>

      <div className="cmd-grid">
        <label>
          <span>Actuator</span>
          <select
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setAction(e.target.value === 'canopy' ? 'set' : 'on');
            }}
          >
            {(targets?.relays ?? []).map((t) => (
              <option key={t} value={t}>
                {RELAY_LABELS[t] ?? t}
              </option>
            ))}
            <option value="canopy">Shade canopy</option>
          </select>
        </label>

        <label>
          <span>Action</span>
          <select value={effectiveAction} onChange={(e) => setAction(e.target.value)}>
            {actions.map((a) => (
              <option key={a} value={a}>
                {{ on: 'Turn on', off: 'Turn off', set: 'Move to', release: 'Hand back to automatic' }[a]}
              </option>
            ))}
          </select>
        </label>

        {effectiveAction === 'set' && (
          <label>
            <span>Position (% closed)</span>
            <input
              type="number"
              min="0"
              max="100"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
        )}

        <label>
          <span>Hand back after (minutes)</span>
          <input
            type="number"
            min="1"
            max={maxMinutes}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          />
        </label>
      </div>

      <div className="cmd-foot">
        <button className="btn" onClick={submit} disabled={busy || minutes < 1 || minutes > maxMinutes}>
          {busy ? 'Sending…' : 'Send command'}
        </button>
        <span className="cmd-cap num">
          Maximum {maxMinutes} minutes
          {targets?.ttlCapProvisional && ' · provisional limit'}
        </span>
      </div>

      {result && <div className={`cmd-result ${result.ok ? 'ok' : 'bad'}`}>{result.message}</div>}
    </div>
  );
}

export default function ActuatorPanel({ actuators, targets, onIssued }) {
  const relays = actuators?.relays ?? [];
  const active = actuators?.activeOverrides ?? [];

  return (
    <>
      {active.length > 0 && (
        <div className="banner">
          {active.length === 1 ? 'One actuator is' : `${active.length} actuators are`} under manual
          control and not following the approved settings. Each hands itself back when its time
          runs out.
        </div>
      )}

      <div className="grid grid-2">
        <div className="card">
          <div className="card-head">
            <span className="label">Relays</span>
            <span className="unit">7 channels</span>
          </div>
          <div className="arows">
            {relays.map((a) => (
              <RelayRow key={a.actuator} a={a} />
            ))}
          </div>
        </div>

        <div className="stack">
          <VentStage stage={actuators?.ventStage} />
          <Canopy canopy={actuators?.canopy} />
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <CommandForm targets={targets} onIssued={onIssued} />
      </div>
    </>
  );
}
