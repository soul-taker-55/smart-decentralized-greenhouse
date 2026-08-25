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
      return { text: `Applied version ${e.cfgVer}` };
    case 'ACK':
      return { text: 'Acknowledged', note: e.cfgHash ? `for ${e.cfgHash.slice(0, 12)}…` : null };
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

export default function ActivityPage({ events, loaded }) {
  const list = events?.events ?? [];

  return (
    <>
      <div className="h">
        <h1>Activity</h1>
        <span className="sub">What this server did and what the controller reported, in order</span>
      </div>

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

