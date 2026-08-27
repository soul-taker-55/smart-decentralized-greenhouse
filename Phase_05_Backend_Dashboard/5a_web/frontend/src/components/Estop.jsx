import { useState } from 'react';
import { api } from '../api.js';

/**
 * Emergency stop.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A HALTED GREENHOUSE MUST NEVER LOOK LIKE A RUNNING ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * When a stop is in force this renders as a full-width band above everything,
 * on every page. Not a badge, not a status pill — a band that displaces the
 * layout, because an operator glancing at the dashboard must not be able to
 * mistake a stopped enclosure for a working one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * REQUESTED AND CONFIRMED ARE DIFFERENT THINGS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The server publishes a stop; the device reports whether it is actually
 * halted. Publish while the controller is offline and the retained message sits
 * unread — the greenhouse is still running.
 *
 * So there are three states, not two, and the middle one is the dangerous one:
 *
 *   RUNNING      no stop requested
 *   REQUESTED    published, device has not confirmed — AMBER, and it says so
 *   STOPPED      device confirms it is halted — RED
 *
 * Collapsing REQUESTED into STOPPED would tell an operator the greenhouse is
 * safe at the exact moment it is not.
 */
export function EstopBanner({ estop, user, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);

  if (!estop) return null;

  const requested = estop.requested?.state === 'stopped';
  const confirmed = estop.confirmed === true;
  if (!requested) return null;

  const canClear = user?.role === 'engineer';

  async function clear() {
    setBusy(true);
    setError(null);
    const { data, error: err } = await api.clearEstop(reason);
    setBusy(false);
    if (err) return setError(data?.message ?? err);
    setReason('');
    setConfirming(false);
    onChanged?.();
  }

  return (
    <div className={`estop-band ${confirmed ? 'stopped' : 'requested'}`}>
      <div className="estop-band-main">
        <span className="estop-word">
          {confirmed ? 'EMERGENCY STOP' : 'EMERGENCY STOP REQUESTED'}
        </span>
        <span className="estop-detail">
          {confirmed
            ? 'The controller has confirmed everything is switched off.'
            : // The honest reading of an unconfirmed stop. Nothing has been
              // proven to be off yet.
              'Published, but the controller has not confirmed it. Equipment may still be running.'}
        </span>
      </div>

      <div className="estop-band-meta">
        {estop.requested?.by && (
          <span>
            Stopped by <b>{estop.requested.by}</b>
          </span>
        )}
        {estop.requested?.reason && <span className="estop-reason">“{estop.requested.reason}”</span>}
      </div>

      <div className="estop-band-action">
        {canClear ? (
          confirming ? (
            <div className="estop-clearform">
              <input
                placeholder="What was resolved?"
                value={reason}
                autoFocus
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && reason && clear()}
              />
              <button className="btn sm" onClick={clear} disabled={busy || !reason}>
                {busy ? 'Clearing…' : 'Confirm clear'}
              </button>
              <button className="btn ghost sm" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button className="btn sm" onClick={() => setConfirming(true)}>
              Clear stop
            </button>
          )
        ) : (
          // Stated rather than just hiding the button, so a farmer who halted
          // the greenhouse knows what has to happen next rather than wondering
          // why there is no way back.
          <span className="estop-cannot">Only an engineer can clear this.</span>
        )}
      </div>

      {error && <div className="estop-error">{error}</div>}
    </div>
  );
}

/**
 * The trigger control.
 *
 * Lives on the Actuators page, where acting on hardware happens — but visually
 * separated from the ordinary controls, because it is not one of them. Every
 * other control on that page is bounded and reversible; this one is neither.
 */
export function EstopControl({ estop, user, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [arming, setArming] = useState(false);
  const [error, setError] = useState(null);

  const stopped = estop?.requested?.state === 'stopped';
  const canTrigger = user?.role === 'engineer' || user?.role === 'farmer';

  if (stopped) return null; // the banner is already unmissable

  async function trigger() {
    setBusy(true);
    setError(null);
    const { data, error: err } = await api.triggerEstop(reason || null);
    setBusy(false);
    if (err) return setError(data?.message ?? err);
    setReason('');
    setArming(false);
    onChanged?.();
  }

  return (
    <div className="card estop-card">
      <div className="card-head">
        <span className="label">Emergency stop</span>
      </div>
      <div className="card-note">
        Switches everything off immediately and keeps it off — through a reboot, a network
        outage, and a new configuration. Only an engineer can lift it.
      </div>

      {!canTrigger ? (
        <div className="cmd-foot">
          <span className="cmd-cap">
            Administrators cannot stop the greenhouse. Ask an engineer or a farmer.
          </span>
        </div>
      ) : !arming ? (
        <div className="cmd-foot">
          <button className="btn danger" onClick={() => setArming(true)}>
            Stop everything
          </button>
          <span className="cmd-cap">Takes effect at the controller, not just here.</span>
        </div>
      ) : (
        <>
          {/* A reason is optional on trigger — urgency is a good enough reason,
              and demanding an explanation before someone can hit stop is the
              wrong trade. It is required on CLEAR, where deliberation belongs. */}
          <div className="cmd-grid">
            <label>
              <span>What is wrong? (optional)</span>
              <input
                value={reason}
                autoFocus
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && trigger()}
              />
            </label>
          </div>
          <div className="cmd-foot">
            <button className="btn danger" onClick={trigger} disabled={busy}>
              {busy ? 'Stopping…' : 'Confirm — stop everything now'}
            </button>
            <button className="btn ghost sm" onClick={() => setArming(false)}>
              Cancel
            </button>
          </div>
        </>
      )}

      {error && <div className="cmd-result bad">{error}</div>}
    </div>
  );
}
