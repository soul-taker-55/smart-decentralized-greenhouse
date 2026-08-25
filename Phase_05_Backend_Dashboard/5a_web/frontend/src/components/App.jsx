import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { api } from './api.js';
import StatusStrip from './components/StatusStrip.jsx';
import SensorPanel from './components/SensorPanel.jsx';
import ActuatorPanel from './components/ActuatorPanel.jsx';

/**
 * Poll an endpoint on an interval.
 *
 * Polling rather than websockets: telemetry arrives every 30 seconds by
 * contract, so a socket would add a reconnection state machine to gain nothing
 * an operator could perceive.
 */
function usePoll(fn, ms) {
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
  }, [ms]);

  return state;
}

/**
 * Sidebar.
 *
 * Built as a sidebar from the outset because 05b makes it ROLE-SCOPED — an
 * admin, an engineer and a farmer see different entries. Shipping flat top
 * navigation now would mean rebuilding it then.
 */
function Sidebar() {
  const link = ({ isActive }) => (isActive ? 'active' : '');
  return (
    <nav className="nav">
      <NavLink to="/" end className={link}>
        Live
      </NavLink>
      <NavLink to="/actuators" className={link}>
        Actuators
      </NavLink>
      <NavLink to="/config" className={link}>
        Configuration
      </NavLink>
      <NavLink to="/events" className={link}>
        Activity
      </NavLink>
      <NavLink to="/camera" className={link}>
        Camera
      </NavLink>
      <div className="nav-note">
        No sign-in yet. Everyone sees everything until access control arrives in the next
        phase.
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

      {!loaded && <p style={{ color: 'var(--ink-faint)', fontSize: 13 }}>Loading readings…</p>}

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
        <p style={{ color: 'var(--ink-faint)', fontSize: 12, marginTop: 14 }}>
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
function ActuatorsPage({ status }) {
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

      {!loaded && <p style={{ color: 'var(--ink-faint)', fontSize: 13 }}>Loading…</p>}

      {loaded && (
        <ActuatorPanel
          key={tick}
          actuators={actuators}
          targets={targetData}
          onIssued={() => setTick((t) => t + 1)}
        />
      )}
    </>
  );
}

/** Placeholder for a page not yet built in this phase. */
function Placeholder({ title, children }) {
  return (
    <>
      <div className="h">
        <h1>{title}</h1>
      </div>
      <div className="emptystate">{children}</div>
    </>
  );
}

export default function App() {
  const { data: status } = usePoll(api.status, 10000);

  return (
    <div className="app">
      <StatusStrip status={status} />
      <div className="body">
        <Sidebar />
        <main className="main">
          <Routes>
            <Route path="/" element={<LivePage status={status} />} />
            <Route path="/actuators" element={<ActuatorsPage status={status} />} />
            <Route
              path="/config"
              element={
                <Placeholder title="Configuration">
                  <h2>Coming in the next step</h2>
                  <p>Editing, proposals, differences against the active profile, and approval.</p>
                </Placeholder>
              }
            />
            <Route
              path="/events"
              element={
                <Placeholder title="Activity">
                  <h2>Coming in the next step</h2>
                  <p>Server actions and device events on one timeline.</p>
                </Placeholder>
              }
            />
            <Route
              path="/camera"
              element={
                <Placeholder title="Camera">
                  <h2>Reserved for the vision phase</h2>
                  <p>
                    The camera runs on a separate controller and is deliberately outside the
                    control path. This space is held for it; nothing is wired up yet.
                  </p>
                </Placeholder>
              }
            />
          </Routes>
        </main>
      </div>
    </div>
  );
}
