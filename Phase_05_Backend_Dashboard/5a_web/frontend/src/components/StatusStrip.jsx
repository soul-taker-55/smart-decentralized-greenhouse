import { formatAge } from '../api.js';

/**
 * Shield glyph. Filled only when verification is actually enforced — the visual
 * weight of the icon is itself the signal, so the state survives being glanced
 * at rather than read.
 */
function Shield({ filled }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 1.2 13.4 3v4.6c0 3.3-2.2 6.1-5.4 7.2-3.2-1.1-5.4-3.9-5.4-7.2V3L8 1.2Z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The verify badge.
 *
 * `verify` is DECLARED BY THE DEVICE and never settable by the server — a
 * server-supplied flag could be switched off by exactly the adversary being
 * defended against.
 *
 * Three states, deliberately distinct:
 *   enforced    — filled shield. The only state that earns one.
 *   unsupported — outline. CORRECT AND EXPECTED with the current mock, since
 *                 signature verification is Phase 03 firmware work. Never shown
 *                 as a fault, and never as a green check.
 *   unknown     — faint outline. No device has ever reported.
 *
 * The words spell out the state rather than relying on the icon, so an operator
 * cannot mistake "not active" for "fine".
 */
function VerifyBadge({ verify }) {
  const state = verify === 'enforced' ? 'enforced' : verify === 'unsupported' ? 'unsupported' : 'unknown';
  const label = {
    enforced: 'Enforced',
    unsupported: 'Not active',
    unknown: 'Unknown',
  }[state];
  const title = {
    enforced: 'The device verifies signatures on every config it receives.',
    unsupported:
      'The device reports that it does not verify signatures. Expected until Phase 03 firmware exists — not a fault.',
    unknown: 'No device has reported its verification status.',
  }[state];

  return (
    <span className={`verify ${state}`} title={title}>
      <Shield filled={state === 'enforced'} />
      {label}
    </span>
  );
}

/**
 * Sticky identity and health strip.
 *
 * Edge presence and data freshness are shown as TWO INDEPENDENT SIGNALS. A
 * retained status of "online" beside telemetry that stopped ten minutes ago is
 * a real state, and collapsing both into one dot would hide precisely the
 * situation an operator most needs to notice.
 */
export default function StatusStrip({ status }) {
  const gh = status?.greenhouse;
  const edge = status?.edge;
  const server = status?.server;

  const presence = !edge?.everSeen ? 'never' : edge.declaredStatus === 'online' ? 'on' : 'off';
  const presenceLabel = !edge?.everSeen
    ? 'Never connected'
    : edge.declaredStatus === 'online'
      ? 'Online'
      : 'Offline';

  const dataAge = formatAge(edge?.lastTelemetryAgeSeconds);

  return (
    <header className="strip">
      <div className="strip-id">
        <b>{gh?.name ?? 'Greenhouse'}</b>
        <span className="num">
          {gh?.id ?? '—'} · {gh?.plants ?? '—'}
        </span>
      </div>

      <div className="strip-cell">
        <span className="k">Device</span>
        <span className="v">
          <i className={`dot ${presence}`} />
          {presenceLabel}
        </span>
      </div>

      <div className="strip-cell">
        <span className="k">Last reading</span>
        <span className="v num">{dataAge ?? 'None yet'}</span>
      </div>

      <div className="strip-cell">
        <span className="k">Device running</span>
        <span className="v num">
          {edge?.runningCfgVer != null
            ? `v${edge.runningCfgVer}`
            : edge?.cfgSrc === 'none'
              ? 'No config'
              : '—'}
        </span>
      </div>

      <div className="strip-cell">
        <span className="k">Server active</span>
        <span className="v num">{server?.activeCfgVer != null ? `v${server.activeCfgVer}` : 'None'}</span>
      </div>

      <div className="strip-cell">
        <span className="k">Signatures</span>
        <VerifyBadge verify={edge?.verify} />
      </div>

      {status?.broker && !status.broker.connected && (
        <div className="strip-cell" style={{ color: 'var(--q-fail)' }}>
          <span className="k">Broker</span>
          <span className="v">Disconnected</span>
        </div>
      )}
    </header>
  );
}
