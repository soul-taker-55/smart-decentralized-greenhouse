import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { api } from './api.js';
import StatusStrip from './components/StatusStrip.jsx';
import SensorPanel from './components/SensorPanel.jsx';
import ActuatorPanel from './components/ActuatorPanel.jsx';
import ConfigPage from './components/ConfigPage.jsx';
import ActivityPage, { CameraPage } from './components/ActivityPage.jsx';
import { LoginPage, InvitePage, KeySetup } from './components/AuthPages.jsx';
import AdminPage from './components/AdminPage.jsx';
import { EstopBanner, EstopControl } from './components/Estop.jsx';

/**
 * Poll an endpoint on an interval.
 *
 * Polling rather than websockets: telemetry arrives every 30 seconds by
 * contract, so a socket would add a reconnection state machine to gain nothing
 * an operator could perceive.
 */
function usePoll(fn, ms, refreshKey = 0) {
  const [state, setState] = useState({ data: null, error: null, loaded: false });

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const { data, error } = await fn();
      if (alive) setState({ data, error, loaded: true });
    };
    tick();
    const t = setInterval(tick, ms);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, refreshKey]);

  return state;
}

/**
 * Sidebar.
 *
 * Built as a sidebar from the outset because 05b makes it ROLE-SCOPED — an
 * admin, an engineer and a farmer see different entries. Shipping flat top
 * navigation now would mean rebuilding it then.
 */
/**
 * Sidebar, scoped by role.
 *
 * Hiding an entry is a courtesy, not a control — every endpoint behind these
 * links is gated server-side, and an admin who navigates to /config directly
 * still gets a 403 on anything they may not do. What this avoids is offering
 * someone a button that will refuse them.
 */
function Sidebar({ user, onSignOut }) {
  const link = ({ isActive }) => (isActive ? 'active' : '');
  return (
    <nav className="nav">
      <NavLink to="/" end className={link}>Live</NavLink>
      <NavLink to="/actuators" className={link}>Actuators</NavLink>
      <NavLink to="/config" className={link}>Configuration</NavLink>
      <NavLink to="/events" className={link}>Activity</NavLink>
      <NavLink to="/camera" className={link}>Camera</NavLink>
      {user?.role === 'engineer' && (
        <NavLink to="/key" className={link}>My signing key</NavLink>
      )}
      {user?.role === 'admin' && (
        <NavLink to="/admin" className={link}>Users &amp; keys</NavLink>
      )}

      <div className="nav-user">
        <div className="nav-who">
          <b>{user?.username}</b>
          <span>{user?.role}</span>
        </div>
        <button className="btn ghost sm" onClick={onSignOut}>Sign out</button>
      </div>
    </nav>
  );
}

/**
 * The Live page.
 *
 * Renders every sensor panel whether or not data exists, so the layout does not
 * change shape depending on what has reported. A dashboard that grows and
 * shrinks makes absence hard to notice; a fixed grid with explicit empty states
 * makes it obvious.
 */
function LivePage({ status }) {
  const { data, loaded } = usePoll(api.live, 10000);

  const groups = data?.sensors?.groups ?? [];
  const hasData = data?.sensors?.hasData;
  const unavailable = data?.sensors?.unavailable;
  const neverSeen = status && !status.edge?.everSeen;

  return (
    <>
      <div className="h">
        <h1>Live readings</h1>
        <span className="sub">Inside and outside the enclosure · refreshes every 10s</span>
      </div>

      {unavailable && (
        <div className="banner">
          The readings database is unreachable, so no measurements can be shown. Configuration
          and activity still work — they live in a separate database.
        </div>
      )}

      {neverSeen && !unavailable && (
        <div className="banner">
          No device has connected yet. These panels will fill in once the greenhouse controller
          starts publishing. Until then every reading reads <b>NO DATA</b>, which is the correct
          state rather than a fault.
        </div>
      )}

      {!loaded && <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading readings…</p>}

      {loaded && groups.length === 0 && !unavailable && (
        <div className="emptystate">
          <h2>No readings recorded</h2>
          <p>Nothing has published telemetry to this greenhouse yet.</p>
          <ol>
            <li>Check the controller is powered and on the network.</li>
            <li>
              Check the broker first if a config was applied but never arrived — a denied
              publish can look like success.
            </li>
            <li>
              For a dry run without hardware, start the <code>sdigf-mock</code> stack.
            </li>
          </ol>
        </div>
      )}

      {groups.length > 0 && (
        <div className="grid">
          {groups.map((g) => (
            <SensorPanel key={g.key} group={g} />
          ))}
        </div>
      )}

      {loaded && hasData === false && groups.length > 0 && (
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 14 }}>
          Panels are shown for all eleven readings so absence is visible. None has reported yet.
        </p>
      )}
    </>
  );
}

/**
 * The Actuators page.
 *
 * Separated from Live because this is the one screen in 05a that can actually
 * change hardware state. Keeping observing and acting on different screens
 * means a manual override is always a deliberate navigation, never a stray
 * click while reading numbers.
 */
function ActuatorsPage({ status, user, estop, onEstopChanged }) {
  const [tick, setTick] = useState(0);
  const { data, loaded } = usePoll(api.live, 10000);
  const { data: targetData } = usePoll(api.commandTargets, 300000);

  const actuators = data?.actuators;
  const neverSeen = status && !status.edge?.everSeen;

  return (
    <>
      <div className="h">
        <h1>Actuators</h1>
        <span className="sub">What the controller is running right now</span>
      </div>

      {neverSeen && (
        <div className="banner">
          No controller has connected, so nothing here reflects real hardware. Commands sent now
          are recorded and published, and will be waiting on the broker when a controller
          subscribes.
        </div>
      )}

      {!loaded && <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>}

      {loaded && (
        <>
          <ActuatorPanel
            key={tick}
            actuators={actuators}
            targets={targetData}
            onIssued={() => setTick((t) => t + 1)}
          />
          <div style={{ marginTop: 12 }}>
            <EstopControl
              estop={estop}
              user={user}
              onChanged={() => {
                setTick((t) => t + 1);
                onEstopChanged?.();
              }}
            />
          </div>
        </>
      )}
    </>
  );
}

/** Activity, polled so device events appear without a manual refresh. */
function ActivityRoute() {
  const { data, loaded } = usePoll(() => api.events(150), 15000);
  return <ActivityPage events={data} loaded={loaded} />;
}

export default function App() {
  const [user, setUser] = useState(undefined);

  // Resolve the session once at load. `undefined` means not yet known, which is
  // distinct from `null` meaning signed out — rendering the login form during
  // that gap would flash it at an already-authenticated user on every refresh.
  useEffect(() => {
    api.me().then(({ data }) => setUser(data?.user ?? null));
  }, []);

  // Invite links are reachable without a session: the link IS the credential.
  const invitePath = window.location.pathname.startsWith('/invite/')
    ? window.location.pathname.slice('/invite/'.length)
    : null;

  if (invitePath) {
    return <InvitePage token={invitePath} onRedeemed={() => (window.location.href = '/')} />;
  }

  if (user === undefined) return <div className="gate"><div className="gate-card">Loading…</div></div>;
  if (user === null) return <LoginPage onSignedIn={setUser} />;

  return <Shell user={user} onSignOut={async () => { await api.logout(); setUser(null); }} />;
}

function Shell({ user, onSignOut }) {
  const { data: status } = usePoll(api.status, 10000);
  const [estopTick, setEstopTick] = useState(0);
  const { data: estop } = usePoll(api.estop, 5000, estopTick);

  return (
    <div className="app">
      <StatusStrip status={status} estop={estop} />
      {/* Above everything, on every page. A band that displaces the layout
          rather than a badge that can be scrolled past. */}
      <EstopBanner estop={estop} user={user} onChanged={() => setEstopTick((t) => t + 1)} />
      <div className="body">
        <Sidebar user={user} onSignOut={onSignOut} />
        <main className="main">
          <Routes>
            <Route path="/" element={<LivePage status={status} />} />
            <Route
              path="/actuators"
              element={
                <ActuatorsPage
                  status={status}
                  user={user}
                  estop={estop}
                  onEstopChanged={() => setEstopTick((t) => t + 1)}
                />
              }
            />
            <Route path="/config" element={<ConfigPage />} />
            <Route path="/events" element={<ActivityRoute />} />
            <Route path="/camera" element={<CameraPage />} />
            <Route path="/admin" element={<AdminPage currentUserId={user.id} />} />
            <Route
              path="/key"
              element={
                <>
                  <div className="h"><h1>My signing key</h1><span className="sub">Created here, never sent to the server</span></div>
                  <KeySetup user={user} />
                </>
              }
            />
          </Routes>
        </main>
      </div>
    </div>
  );
}
