import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Plain-language descriptions for every event type.
 *
 * Two streams land on one timeline: what this server did, and what the
 * controller reported. Merging them is the point — "config activated" followed
 * by "config applied" is the round trip, and it only reads as one story if the
 * two sit together in order.
 */
function describe(e) {
  if (e.source === 'server') {
    const d = e.detail ?? {};
    switch (e.eventType) {
      case 'CONFIG_CREATED':
        return {
          text: `Version ${d.ver} saved as a draft`,
          note: d.incomplete?.length ? `${d.incomplete.length} settings left unset` : null,
        };
      case 'CONFIG_PROPOSED':
        return { text: 'Put forward for approval' };
      case 'CONFIG_APPROVED':
        return {
          text: 'Approved',
          // A signature-less approval must stay distinguishable from a real one
          // forever — the ledger will chain these.
          note: d.stub ? 'Placeholder approval — no signatures were checked' : null,
          warn: Boolean(d.stub),
        };
      case 'CONFIG_REJECTED':
        return { text: 'Rejected', note: d.reason };
      case 'ESTOP_TRIGGERED':
        return { text: 'Emergency stop triggered', note: d.reason, warn: true };
      case 'ESTOP_CLEARED':
        return { text: 'Emergency stop cleared', note: d.reason };
      case 'KEY_REGISTERED':
        return { text: 'Signing key registered', note: d.keyId };
      case 'KEY_REVOKED':
        return { text: 'Signing key revoked', note: d.keyId, warn: true };
      case 'APPROVAL_POLICY_CHANGED':
        return {
          text: `Approval threshold set to ${d.to?.threshold_m}`,
          note: d.weakened ? 'This lowers the number of signatures required.' : null,
          warn: Boolean(d.weakened),
        };
      case 'CONFIG_ACTIVATED':
        return {
          text: `Version ${d.ver} put into service`,
          note: d.cancelsOverrides ? 'Any manual overrides were cancelled' : null,
        };
      case 'CONFIG_SUPERSEDED':
        return { text: `Replaced by version ${d.supersededByVer}` };
      case 'CONFIG_EXPIRED':
        return { text: 'Expired before it was approved' };
      case 'COMMAND_ISSUED':
        return {
          text: `${d.target} → ${d.action}${d.value != null ? ` ${d.value}%` : ''}`,
          note: `Hands back after ${Math.round((d.ttl_s ?? 0) / 60)} min · sent from ${d.via === 'mcp' ? 'chat' : 'the dashboard'}`,
        };
      case 'COMMAND_RELEASED':
        return { text: `${d.target} handed back to automatic control` };
      default:
        return { text: e.eventType };
    }
  }

  switch (e.eventType) {
    case 'ONLINE':
      return { text: 'Controller connected' };
    case 'OFFLINE':
      return { text: 'Controller disconnected', warn: true };
    case 'REBOOT':
      return { text: 'Controller restarted', note: e.bootReason, warn: true };
    case 'HEALTH':
      return {
        text: 'Status report',
        // cfg.src = nvs is direct evidence of edge autonomy: the controller
        // running from its own stored settings rather than waiting on us.
        note:
          e.cfgSrc === 'nvs'
            ? `Running version ${e.cfgVer} from its own memory`
            : e.cfgSrc === 'none'
              ? 'No settings stored yet'
              : e.cfgVer != null
                ? `Running version ${e.cfgVer}`
                : null,
      };
    case 'CONFIG_APPLIED':
      // Guard against a null version. A malformed or duplicate ack during a
      // reconnect burst produced an empty payload, which rendered as "Applied
      // version null" in the feed. The root cause is logged as an open item;
      // this stops the feed asserting something that is not a version.
      return e.cfgVer == null
        ? { text: 'Applied a configuration', note: 'version not reported in this acknowledgement' }
        : { text: `Applied version ${e.cfgVer}` };
    case 'ACK':
      return { text: 'Acknowledged', note: e.cfgHash ? `for ${e.cfgHash.slice(0, 12)}…` : null };
    case 'ESTOP_TRIGGERED':
      return { text: 'Emergency stop triggered', note: e.detail?.reason, warn: true };
    case 'ESTOP_CLEARED':
      return { text: 'Emergency stop cleared', note: e.detail?.reason };
    default:
      return { text: e.eventType };
  }
}

function when(t) {
  const d = new Date(t);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}


/**
 * THE LEDGER PANEL.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT A GREEN CHECKMARK
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A panel reading "Chain OK" would assert something this system deliberately
 * does not claim. tools/tamper-demo.mjs scenario 6 demonstrates a COMPLETE
 * REWRITE FROM GENESIS that verification also reports as ok — an administrator
 * deletes a range of events, rebuilds every subsequent link with the same
 * builder the legitimate writer uses, and nothing is detectable, because the
 * chain head is not anchored outside this system.
 *
 * So the result is stated IN WORDS, with its scope beside it at the same weight.
 * The caveat is not a tooltip and not small print: a reader who takes one glance
 * must come away with the bounded claim, not a reassuring symbol.
 *
 * NO FULL-SATURATION GREEN. That is reserved for reading quality, where it means
 * "this number is current and trustworthy". A verification result is a different
 * kind of fact and must not borrow that vocabulary. A failure uses red, because
 * a broken chain IS an alarm.
 *
 * `realTimeFrom` is displayed always, never only on success. It is the honest
 * boundary: links below it prove content integrity but assert their ordering
 * retrospectively.
 */
function LedgerPanel() {
  const [state, setState] = useState({ loading: true, data: null, error: null });

  useEffect(() => {
    let alive = true;
    api
      .verifyLedger()
      .then((d) => alive && setState({ loading: false, data: d, error: null }))
      .catch((e) => alive && setState({ loading: false, data: null, error: e.message }));
    return () => {
      alive = false;
    };
  }, []);

  if (state.loading) {
    return (
      <div className="card">
        <div className="card-head">
          <span className="label">Audit chain</span>
        </div>
        <p className="muted" style={{ padding: '0 14px 14px' }}>Verifying…</p>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="card">
        <div className="card-head">
          <span className="label">Audit chain</span>
        </div>
        <p className="muted" style={{ padding: '0 14px 14px' }}>
          Could not verify the chain: {state.error}
        </p>
      </div>
    );
  }

  const d = state.data;
  const f = d.firstFailure;

  return (
    <div className="card">
      <div className="card-head">
        <span className="label">Audit chain</span>
        <span className="unit num">
          {d.length} {d.length === 1 ? 'link' : 'links'}
          {d.head ? ` · head ${d.head.seq}` : ''}
        </span>
      </div>

      <div style={{ padding: '0 14px 14px' }}>
        {/* THE RESULT — in words, never a symbol. */}
        {d.ok ? (
          <p style={{ margin: '0 0 10px' }}>
            <strong>No alteration detected.</strong> Every link matches the records it
            covers, and every recorded event has a link.
          </p>
        ) : (
          <p style={{ margin: '0 0 10px', color: 'var(--red)' }}>
            <strong>Alteration detected.</strong>{' '}
            {f?.detail ?? 'The chain does not verify.'}
            {f?.diff && Object.keys(f.diff).length > 0 && (
              <>
                {' '}Changed {Object.keys(f.diff).join(', ')}.
              </>
            )}
          </p>
        )}

        {/* THE BOUNDARY — shown on success and failure alike. */}
        <p className="muted" style={{ margin: '0 0 10px' }}>
          {d.claim.realTimeFrom}
        </p>

        {/* THE SCOPE OF THE CLAIM — same weight as the result, not a tooltip. */}
        <div
          style={{
            borderTop: '1px solid var(--line)',
            paddingTop: 10,
            fontSize: '0.85rem',
            color: 'var(--muted)',
          }}
        >
          <p style={{ margin: '0 0 6px' }}>
            <strong style={{ color: 'var(--text)' }}>What this proves.</strong>{' '}
            {d.claim.proves}
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: 'var(--text)' }}>What it does not.</strong>{' '}
            {d.claim.doesNotProve}
          </p>
        </div>

        {d.unchainedEvents.length > 0 && (
          <p style={{ marginTop: 10, color: 'var(--amber)' }}>
            {d.unchainedEvents.length} recorded{' '}
            {d.unchainedEvents.length === 1 ? 'event has' : 'events have'} no link. An
            emergency stop is recorded and published before it is chained, so a gap here
            is expected after an audit-layer failure and is reconciled, not lost.
          </p>
        )}
      </div>
    </div>
  );
}

export default function ActivityPage({ events, loaded }) {
  const list = events?.events ?? [];

  return (
    <>
      <div className="h">
        <h1>Activity</h1>
        <span className="sub">What this server did and what the controller reported, in order</span>
      </div>

      <LedgerPanel />

      {!loaded && <p className="muted">Loading…</p>}

      {loaded && list.length === 0 && (
        <div className="emptystate">
          <h2>Nothing has happened yet</h2>
          <p>
            Saving a configuration or sending a command will appear here, alongside anything the
            controller reports once it connects.
          </p>
        </div>
      )}

      {list.length > 0 && (
        <div className="card">
          <div className="card-head">
            <span className="label">Recent activity</span>
            <span className="unit num">
              {events.serverCount} server · {events.edgeCount} controller
            </span>
          </div>
          <div className="feed">
            {list.map((e) => {
              const d = describe(e);
              return (
                <div className={`fev ${d.warn ? 'warn' : ''}`} key={`${e.source}-${e.id}`}>
                  <span className={`fsrc fsrc-${e.source}`}>
                    {e.source === 'server' ? 'Server' : 'Controller'}
                  </span>
                  <div className="fbody">
                    <div className="ftext">{d.text}</div>
                    {d.note && <div className="fnote">{d.note}</div>}
                    {/* actorId stays null until access control exists. Showing
                        the gap is more honest than showing nothing. */}
                    {e.source === 'server' && (
                      <div className="factor">{e.actorId ? `${e.actorId} (${e.actorRole})` : 'No sign-in yet'}</div>
                    )}
                  </div>
                  <span className="ftime num">{when(e.time)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Camera placeholder.
 *
 * The vision node is a separate controller on its own WiFi connection, sharing
 * only the 5 V rail. It sits deliberately outside the control and authorisation
 * path, so nothing here talks to it — this reserves the layout and says why.
 */
export function CameraPage() {
  return (
    <>
      <div className="h">
        <h1>Camera</h1>
        <span className="sub">Reserved for the vision phase</span>
      </div>

      <div className="camgrid">
        <div className="camslot main">
          <div className="camslot-in">
            <b>Live view</b>
            <span>Not connected</span>
          </div>
        </div>
        <div className="stack">
          <div className="camslot">
            <div className="camslot-in">
              <b>Last image</b>
              <span>None captured</span>
            </div>
          </div>
          <div className="camslot">
            <div className="camslot-in">
              <b>Capture now</b>
              <span>Unavailable</span>
            </div>
          </div>
        </div>
      </div>

      <p className="muted" style={{ marginTop: 12, maxWidth: 620, lineHeight: 1.6 }}>
        The camera runs on its own controller with a separate network connection, sharing only
        power with the greenhouse controller. It is kept outside the control path on purpose: it
        can observe the enclosure, but nothing it sees can move an actuator.
      </p>
    </>
  );
}

