import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { signCanonical, loadKey } from '../signing.js';

/**
 * Human labels and help text for every field in contract §4.
 *
 * The API serves the SPEC (types, bounds, nullability) so validation has one
 * source of truth. Wording lives here because it is interface copy, not schema:
 * a field is named by what the operator controls, never by how the payload is
 * built.
 */
const BLOCKS = [
  {
    key: 'sys',
    title: 'Reporting',
    blurb: 'How often the controller reports, and when a reading counts as out of date.',
    fields: {
      telemetry_interval_s: { label: 'Report every', unit: 'seconds' },
      stale_after_s: {
        label: 'Mark readings stale after',
        unit: 'seconds',
        help: 'Must be longer than the reporting interval, or every reading arrives already stale.',
      },
    },
  },
  {
    key: 'temp',
    title: 'Temperature',
    blurb: 'The band the controller works to.',
    fields: {
      max_dc: { label: 'Cool above', unit: '°C', dc: true, help: 'The actionable limit — above this, fans and shading engage.' },
      min_dc: {
        label: 'Warn below',
        unit: '°C',
        dc: true,
        help: 'Advisory only. Nothing in this enclosure adds heat on demand, so a low reading can be flagged but not acted on.',
      },
      hyst_dc: { label: 'Deadband', unit: '°C', dc: true, help: 'Stops relays chattering around the limit.' },
    },
  },
  {
    key: 'hum',
    title: 'Humidity',
    blurb: 'Measured by DHT11, which reports whole percent only.',
    fields: {
      min_pct: { label: 'Humidify below', unit: '%' },
      max_pct: { label: 'Vent above', unit: '%' },
      hyst_pct: { label: 'Deadband', unit: '%' },
    },
  },
  {
    key: 'vent',
    title: 'Ventilation',
    blurb: 'Three fans give four levels. Each stage engages this far above the cooling limit.',
    fields: {
      stage_offsets_dc: { label: 'Stage offsets', unit: '°C above limit', dcArray: true },
      min_off_s: { label: 'Minimum rest between switches', unit: 'seconds' },
    },
  },
  {
    key: 'pump',
    title: 'Watering',
    blurb: 'Soil thresholds form the on/off pair directly.',
    fields: {
      soil_start_pct: { label: 'Start watering below', unit: '% soil moisture' },
      soil_stop_pct: { label: 'Stop watering above', unit: '% soil moisture', help: 'Must be higher than the start value, or the pump never stops.' },
      max_runtime_s: { label: 'Longest single run', unit: 'seconds' },
      cooldown_s: { label: 'Rest between runs', unit: 'seconds' },
      water_min_pct: { label: 'Refuse to run below', unit: '% tank', help: 'Dry-run protection. The pump will not start below this regardless of soil.' },
    },
  },
  {
    key: 'photo',
    title: 'Lighting schedule',
    blurb: 'The grow light is committed to this schedule and cannot dim.',
    fields: {
      on_min: { label: 'Lights on at', time: true },
      off_min: { label: 'Lights off at', time: true },
      tz_offset_min: { label: 'Timezone offset from UTC', unit: 'minutes', help: 'The controller gets UTC from the network and has no timezone database.' },
    },
  },
  {
    key: 'canopy',
    title: 'Shade canopy',
    blurb: 'The enclosure is sealed — the canopy shades only, it does not move air.',
    fields: {
      enabled_for_cooling: { label: 'Use shading to cool', bool: true },
      only_above_dc: { label: 'Only shade above', unit: '°C', dc: true, help: 'Stops the canopy reacting to trivial warmth.' },
      max_pct: { label: 'Furthest it may close', unit: '%' },
      step_pct: { label: 'Move in steps of', unit: '%', help: 'Larger steps mean fewer servo moves. The servo must not be held in position.' },
      min_dwell_s: { label: 'Wait between moves', unit: 'seconds' },
      max_shade_min_day: { label: 'Daily shading budget', unit: 'minutes', help: 'Caps the total daylight traded away for cooling.' },
    },
  },
  {
    key: 'arb_a',
    title: 'When it is hot and dry at once',
    blurb: 'Fans cool but also exhaust moisture, so they fight the humidifier. This decides who wins.',
    fields: {
      priority: { label: 'Priority', enum: { temperature: 'Cooling wins', humidity: 'Humidity wins' } },
      fan_cap_stage: { label: 'Fan limit while humidity wins', unit: 'stage 0–3' },
      max_suppress_s: {
        label: 'Give the losing side a turn after',
        unit: 'seconds',
        help: 'Without this, a long hot dry spell starves one variable indefinitely.',
      },
    },
  },
  {
    key: 'arb_b',
    title: 'When shading would cost light',
    blurb: 'Shading to cool removes light the plants need during the photoperiod.',
    fields: {
      priority: { label: 'Priority', enum: { light: 'Light wins', temperature: 'Cooling wins' } },
      max_pct_in_photo: { label: 'Most shading allowed during lit hours', unit: '%' },
    },
  },
];

const LIFECYCLE = ['DRAFT', 'PROPOSED', 'PARTIALLY_APPROVED', 'APPROVED', 'ACTIVE'];
const TERMINAL = ['REJECTED', 'EXPIRED', 'SUPERSEDED'];

const STATUS_WORDS = {
  DRAFT: 'Draft',
  PROPOSED: 'Proposed',
  PARTIALLY_APPROVED: 'Partly approved',
  APPROVED: 'Approved',
  ACTIVE: 'Running',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
  SUPERSEDED: 'Replaced',
};

/** Deci-Celsius on the wire, plain °C in the interface. */
const dcToC = (v) => (v === null || v === undefined ? '' : (v / 10).toFixed(1));
const cToDc = (s) => (s === '' ? null : Math.round(parseFloat(s) * 10));

/** Minutes from midnight on the wire, HH:MM in the interface. */
const minToTime = (v) =>
  v === null || v === undefined ? '' : `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
const timeToMin = (s) => {
  if (!s) return null;
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

/** One editable field. Unset is a first-class state, not an empty box. */
function Field({ block, name, meta, value, spec, onChange, error }) {
  const nullable = spec?.nullable;
  const isUnset = value === null || value === undefined;

  const set = (v) => onChange(block, name, v);

  let control;
  if (meta.bool) {
    control = (
      <select value={String(value)} onChange={(e) => set(e.target.value === 'true')}>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  } else if (meta.enum) {
    control = (
      <select value={value ?? ''} onChange={(e) => set(e.target.value)}>
        {Object.entries(meta.enum).map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </select>
    );
  } else if (meta.time) {
    control = <input type="time" value={minToTime(value)} onChange={(e) => set(timeToMin(e.target.value))} />;
  } else if (meta.dc) {
    control = (
      <input
        type="number"
        step="0.1"
        value={dcToC(value)}
        placeholder={nullable ? 'Not set' : ''}
        onChange={(e) => set(cToDc(e.target.value))}
      />
    );
  } else if (meta.dcArray) {
    control = (
      <div className="triple">
        {[0, 1, 2].map((i) => (
          <input
            key={i}
            type="number"
            step="0.1"
            value={dcToC(value?.[i])}
            onChange={(e) => {
              const next = [...(value ?? [0, 0, 0])];
              next[i] = cToDc(e.target.value) ?? 0;
              set(next);
            }}
          />
        ))}
      </div>
    );
  } else {
    control = (
      <input
        type="number"
        value={value ?? ''}
        placeholder={nullable ? 'Not set' : ''}
        onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))}
      />
    );
  }

  return (
    <div className={`field ${error ? 'has-error' : ''}`}>
      <div className="field-head">
        <label>{meta.label}</label>
        {meta.unit && <span className="field-unit num">{meta.unit}</span>}
      </div>
      {control}
      {/* An unset value is legitimate — a partial draft is a normal thing to
          save — but it must be visibly distinct from a value of zero. */}
      {isUnset && nullable && <div className="field-unset">Waiting for a value</div>}
      {meta.help && !error && <div className="field-help">{meta.help}</div>}
      {error && <div className="field-error">{error}</div>}
    </div>
  );
}

/** Lifecycle as a stepper, with terminal states shown as off-ramps. */
function Lifecycle({ status }) {
  const terminal = TERMINAL.includes(status);
  const idx = LIFECYCLE.indexOf(status);
  return (
    <div className="lifecycle">
      {LIFECYCLE.map((s, i) => (
        <span key={s} className={`lstep ${!terminal && i <= idx ? 'done' : ''} ${s === status ? 'now' : ''}`}>
          {STATUS_WORDS[s]}
        </span>
      ))}
      {terminal && <span className="lstep terminal now">{STATUS_WORDS[status]}</span>}
    </div>
  );
}

/**
 * Approval standing.
 *
 * Shows the tally AND who produced it. A bare "1 of 2" leaves an engineer
 * unable to tell whether they have already signed, or who to ask next — which
 * is the practical question at that moment.
 */
function Standing({ standing, votes }) {
  if (!standing) return null;

  const rejected = votes?.find((v) => v.decision === 'reject');
  if (rejected) {
    return (
      <div className="standing killed">
        <b>Rejected by {rejected.username}</b>
        {rejected.reason && <p>{rejected.reason}</p>}
        <p className="muted">
          One rejection ends a proposal. Clone it into a new version to try again.
        </p>
      </div>
    );
  }

  const approvers = (votes ?? []).filter(
    (v) => v.decision === 'approve' && v.user_id !== standing.proposer
  );

  return (
    <div className="standing">
      <div className="standing-row">
        <b>
          {standing.approvals} of {standing.thresholdM} signatures
        </b>
        {standing.satisfied ? (
          <span className="pstatus s-APPROVED">threshold met</span>
        ) : (
          <span className="muted">{standing.remaining} more needed</span>
        )}
      </div>

      <div className="pips">
        {Array.from({ length: standing.thresholdM }).map((_, i) => (
          <span key={i} className={`pip ${i < standing.approvals ? 'on' : ''}`} />
        ))}
      </div>

      {approvers.length > 0 && (
        <div className="signers">
          {approvers.map((v) => (
            <span key={v.key_id} className="signer" title={v.key_id}>
              {v.username}
            </span>
          ))}
        </div>
      )}

      {/*
        Provenance. Stated as a NEUTRAL OBSERVATION, never as a warning.

        users.created_by is an ordinary column an administrator can edit, so an
        administrator who creates several engineer accounts and approves as them
        can also erase this lineage. Presenting it as a detection mechanism would
        overclaim: it helps an honest audit and does nothing against a dishonest
        administrator. The wording therefore reports a fact and draws no
        conclusion from it.
      */}
      {(() => {
        const creators = new Set(approvers.map((v) => v.created_by).filter(Boolean));
        if (approvers.length < 2 || creators.size !== 1) return null;
        const who = approvers.find((v) => v.created_by)?.created_by_username;
        return (
          <div className="provenance">
            Approvers were created by the same administrator{who ? ` (${who})` : ''}.
          </div>
        );
      })()}

      {/* The proposer is listed separately so it is obvious why their own
          signature is absent, rather than looking like an oversight. */}
      <div className="proposer-note">
        Proposed by {standing.proposer} — a proposer cannot approve their own change.
      </div>
    </div>
  );
}

/** Field-by-field diff. A text diff of the canonical JSON would be accurate and
    unreadable — canonical form sorts keys, so unrelated fields shuffle. */
function Diff({ diff }) {
  if (!diff) return null;
  if (!diff.hasActive) {
    return <p className="muted">Nothing is running yet, so there is nothing to compare against.</p>;
  }
  if (diff.changes.length === 0) {
    return <p className="muted">Identical to what is running now.</p>;
  }
  return (
    <table className="diff">
      <thead>
        <tr>
          <th>Setting</th>
          <th>Running (v{diff.activeVer})</th>
          <th>This version</th>
        </tr>
      </thead>
      <tbody>
        {diff.changes.map((c) => (
          <tr key={c.field}>
            <td className="num">{c.field}</td>
            <td className="num was">{JSON.stringify(c.from)}</td>
            <td className="num now">{JSON.stringify(c.to)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function ConfigPage() {
  const [schema, setSchema] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [active, setActive] = useState(null);
  const [draft, setDraft] = useState(null);
  const [name, setName] = useState('');
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [selected, setSelected] = useState(null);
  const [diff, setDiff] = useState(null);
  const [standing, setStanding] = useState(null);

  async function refresh() {
    const [{ data: p }, { data: a }] = await Promise.all([api.profiles(), api.activeConfig()]);
    setProfiles(p?.profiles ?? []);
    setActive(a?.active ?? null);
    if (selected != null) {
      const { data: s } = await api.standing(selected);
      setStanding(s);
    }
  }

  useEffect(() => {
    (async () => {
      const { data } = await api.configSchema();
      setSchema(data);
      // Start from whatever is running, so an edit is a change to reality
      // rather than a blank form someone has to reconstruct.
      const { data: a } = await api.activeConfig();
      setDraft(structuredClone(a?.active?.cfg ?? data?.template ?? null));
      setActive(a?.active ?? null);
      const { data: p } = await api.profiles();
      setProfiles(p?.profiles ?? []);
    })();
  }, []);

  useEffect(() => {
    if (selected == null) {
      setDiff(null);
      setStanding(null);
      return;
    }
    api.diff(selected).then(({ data }) => setDiff(data));
    api.standing(selected).then(({ data }) => setStanding(data));
  }, [selected]);

  function change(block, field, v) {
    setDraft((d) => ({ ...d, [block]: { ...d[block], [field]: v } }));
    setErrors((e) => {
      const n = { ...e };
      delete n[`${block}.${field}`];
      return n;
    });
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    setErrors({});
    const { data, error } = await api.createProfile(draft, name || null);
    setBusy(false);
    if (error) {
      // Field paths come back matching the ones the device uses in rejections,
      // so the same map works for both.
      const map = {};
      for (const f of data?.fields ?? []) map[f.field] = f.message;
      setErrors(map);
      setMsg({ ok: false, text: data?.fields?.length ? 'Some values need fixing before this can be saved.' : error });
      return;
    }
    setMsg({ ok: true, text: `Saved as version ${data.profile.ver}.` });
    setName('');
    refresh();
  }

  async function act(fn, id, okText) {
    setBusy(true);
    setMsg(null);
    const { data, error } = await fn(id);
    setBusy(false);
    if (error) return setMsg({ ok: false, text: data?.message ?? error });
    setMsg({ ok: true, text: typeof okText === 'function' ? okText(data) : okText });
    refresh();
  }

  /**
   * Sign a config, then submit the vote.
   *
   * The signature is over cfg_canonical — the exact string the SERVER stored,
   * fetched fresh rather than rebuilt here. Signing a locally reconstructed
   * copy would mean approving something that might differ by a byte from what
   * the device will receive, and the signature would fail on the hardware with
   * nothing to explain why.
   */
  async function vote(profileId, decision, reason) {
    setBusy(true);
    setMsg(null);
    try {
      const { data: fresh } = await api.profile(profileId);
      const signature = await signCanonical(fresh.profile.cfgCanonical);
      const { data, error } =
        decision === 'approve'
          ? await api.approve(profileId, signature)
          : await api.reject(profileId, signature, reason);
      setBusy(false);
      if (error) return setMsg({ ok: false, text: data?.message ?? error });
      setMsg({
        ok: true,
        text:
          decision === 'approve'
            ? `Signed and approved. ${data.approvals} of ${data.thresholdM} approvals — ${data.satisfied ? 'threshold met.' : 'awaiting more.'}`
            : 'Signed and rejected. One rejection ends a proposal.',
      });
      refresh();
    } catch (e) {
      setBusy(false);
      setMsg({ ok: false, text: e.message });
    }
  }

  if (!schema || !draft) return <p className="muted">Loading…</p>;

  return (
    <>
      <div className="h">
        <h1>Configuration</h1>
        <span className="sub">
          {active ? `Running version ${active.ver}` : 'Nothing running yet — this will be the first version'}
        </span>
      </div>

      <div className="banner">
        Growing values are supplied by you. This system stores and delivers the settings an
        agriculture engineer decides on; it does not work out what they should be. The controller
        independently refuses anything outside its own safety limits.
      </div>

      {msg && <div className={`cmd-result ${msg.ok ? 'ok' : 'bad'}`} style={{ margin: '0 0 14px' }}>{msg.text}</div>}

      <div className="cfg-cols">
        <div>
          {BLOCKS.map((b) => (
            <div className="card cfgblock" key={b.key}>
              <div className="card-head">
                <span className="label">{b.title}</span>
              </div>
              <div className="card-note">{b.blurb}</div>
              <div className="fields">
                {Object.entries(b.fields).map(([fname, meta]) => (
                  <Field
                    key={fname}
                    block={b.key}
                    name={fname}
                    meta={meta}
                    spec={schema.spec?.[b.key]?.[fname]}
                    value={draft[b.key]?.[fname]}
                    onChange={change}
                    error={errors[`${b.key}.${fname}`]}
                  />
                ))}
              </div>
            </div>
          ))}

          <div className="card">
            <div className="cmd-grid">
              <label>
                <span>Name this version (optional)</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. summer schedule" />
              </label>
            </div>
            <div className="cmd-foot">
              <button className="btn" onClick={save} disabled={busy}>
                {busy ? 'Saving…' : 'Save as new version'}
              </button>
              <span className="cmd-cap">Saved as a draft. Nothing reaches the controller until it is approved.</span>
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head">
              <span className="label">Versions</span>
              <span className="unit num">{profiles.length}</span>
            </div>
            {profiles.length === 0 && <div className="card-note">No versions saved yet.</div>}
            <div className="plist">
              {profiles.map((p) => (
                <div
                  key={p.id}
                  className={`prow ${selected === p.id ? 'sel' : ''} ${p.status === 'ACTIVE' ? 'active' : ''}`}
                  onClick={() => setSelected(selected === p.id ? null : p.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setSelected(selected === p.id ? null : p.id)}
                >
                  <div className="prow-top">
                    <b className="num">v{p.ver}</b>
                    <span className={`pstatus s-${p.status}`}>{STATUS_WORDS[p.status]}</span>
                  </div>
                  {p.name && <div className="prow-name">{p.name}</div>}
                  {p.incomplete?.length > 0 && (
                    <div className="prow-warn">{p.incomplete.length} settings still unset</div>
                  )}

                  {selected === p.id && (
                    <div className="prow-detail" onClick={(e) => e.stopPropagation()}>
                      <Lifecycle status={p.status} />
                      {['PROPOSED', 'PARTIALLY_APPROVED', 'APPROVED', 'REJECTED'].includes(p.status) && (
                        <Standing standing={standing?.standing} votes={standing?.votes} />
                      )}
                      <Diff diff={diff} />

                      <div className="prow-actions">
                        {/* Available on EVERY version regardless of status.
                            Cloning bypasses no gate — the clone still needs
                            full approval — and this is HOW ROLLBACK WORKS.
                            There is no re-activate path, because the device
                            rejects an older ver as stale and cannot tell a
                            legitimate rollback from a replay. */}
                        <button
                          className="btn ghost sm"
                          disabled={busy}
                          onClick={() =>
                            act(
                              (id) => api.cloneProfile(id, null),
                              p.id,
                              (d) => `Copied into version ${d.profile.ver} as a new draft.`
                            )
                          }
                        >
                          Clone
                        </button>
                        {p.status === 'DRAFT' && (
                          <button className="btn sm" disabled={busy} onClick={() => act(api.propose, p.id, 'Proposed.')}>
                            Propose
                          </button>
                        )}
                        {['PROPOSED', 'PARTIALLY_APPROVED'].includes(p.status) && (
                          <>
                            {/* 05a has no signatures and no threshold. The button
                                says so, because a UI that looked like a real
                                approval would be the most misleading thing here. */}
                            <button className="btn sm" disabled={busy} onClick={() => vote(p.id, 'approve')}>
                              Sign &amp; approve
                            </button>
                            <button className="btn sm ghost" disabled={busy} onClick={() => vote(p.id, 'reject', 'Rejected from dashboard')}>
                              Sign &amp; reject
                            </button>
                          </>
                        )}
                        {p.status === 'APPROVED' && (
                          <button
                            className="btn sm"
                            disabled={busy}
                            onClick={() =>
                              act(api.activate, p.id, (d) =>
                                d.published
                                  ? `Version ${d.profile.ver} is now running and has been sent to the controller.`
                                  : `Version ${d.profile.ver} is now running, but delivery failed: ${d.publishError}. Check the broker first.`
                              )
                            }
                          >
                            Put into service
                          </button>
                        )}
                      </div>

                      {['PROPOSED', 'PARTIALLY_APPROVED'].includes(p.status) && (
                        <div className="stubnote">
                          Approving signs this configuration with your key. Your own proposal
                          cannot be approved by you, and one rejection ends a proposal.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <span className="label">Delivery</span>
            </div>
            <div className="card-note">
              The broker holds a copy of the running settings so a controller gets them the moment
              it reconnects. That copy is a convenience — this server holds the real record and
              restores it automatically.
            </div>
            <div className="cmd-foot">
              <button
                className="btn sm ghost"
                disabled={busy}
                onClick={() => act(() => api.republish(), null, (d) => (d.republished ? `Re-sent version ${d.ver}.` : 'Nothing is running, so the broker copy was cleared.'))}
              >
                Re-send to controller
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
