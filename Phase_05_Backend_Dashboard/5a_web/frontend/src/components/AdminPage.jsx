import { useEffect, useState } from 'react';
import { api } from '../api.js';

const ROLE_NOTE = {
  admin:
    'Manages accounts, keys and the approval threshold. Cannot propose or approve configurations, and cannot issue manual commands.',
  engineer:
    'Proposes and approves configurations, and issues manual commands. Holds a signing key generated in their own browser.',
  farmer:
    'Views everything and issues manual commands. Cannot propose or approve configurations.',
};

/**
 * Invite an account.
 *
 * The link is shown ONCE, here, and is not recoverable afterwards — only its
 * hash is stored, so an administrator who loses it reissues rather than looks
 * it up. Saying so beside the link is better than a copy button that quietly
 * stops working after a refresh.
 */
function InviteForm({ onInvited }) {
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [role, setRole] = useState('engineer');
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState(null);
  const [error, setError] = useState(null);

  // Mirrors the server's check, for immediate feedback. The SERVER's copy is
  // the one that matters — this is convenience, not validation.
  //
  // Format only. Nothing is sent to the address and nothing confirms the
  // recipient owns it, so it is a label rather than proof of identity.
  const emailOk = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email.trim());
  const usernameOk = /^[a-zA-Z0-9._-]{2,32}$/.test(username.trim());
  const showEmailError = email.length > 0 && !emailOk;
  const showUsernameError = username.length > 0 && !usernameOk;

  async function submit() {
    setBusy(true);
    setError(null);
    const { data, error: err } = await api.inviteUser(email, username, role);
    setBusy(false);
    if (err) return setError(data?.message ?? err);
    setIssued({ ...data, link: `${window.location.origin}/invite/${data.inviteToken}` });
    setEmail('');
    setUsername('');
    onInvited?.();
  }

  return (
    <div className="card">
      <div className="card-head">
        <span className="label">Invite someone</span>
      </div>
      <div className="card-note">
        There is no sign-up page. Every account begins with an invite from an administrator.
      </div>

      <div className="cmd-grid">
        <label className={showUsernameError ? 'field has-error' : ''}>
          <span>Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
          {showUsernameError && (
            <em className="fielderr">2–32 characters: letters, digits, dot, underscore, hyphen</em>
          )}
        </label>
        <label className={showEmailError ? 'field has-error' : ''}>
          <span>Email</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)} />
          {showEmailError && <em className="fielderr">Not a valid email address</em>}
        </label>
        <label>
          <span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="engineer">Engineer</option>
            <option value="farmer">Farmer</option>
            <option value="admin">Administrator</option>
          </select>
        </label>
      </div>

      <div className="rolenote">{ROLE_NOTE[role]}</div>

      <div className="cmd-foot">
        <button className="btn" onClick={submit} disabled={busy || !emailOk || !usernameOk}>
          {busy ? 'Creating…' : 'Create invite'}
        </button>
        <span className="cmd-cap">
          The link expires in 24 hours and works once. Addresses are checked for format
          only — nothing is sent and ownership is not verified.
        </span>
      </div>

      {error && <div className="cmd-result bad">{error}</div>}

      {issued && (
        <div className="invitelink">
          <b>Send this link to {issued.user.username}</b>
          <code>{issued.link}</code>
          <div className="cmd-foot" style={{ padding: '10px 0 0' }}>
            <button
              className="btn sm"
              onClick={() => navigator.clipboard?.writeText(issued.link)}
            >
              Copy link
            </button>
            <span className="cmd-cap">
              Shown once. The server keeps only a hash of it — if it is lost, issue a new one.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The approval threshold.
 *
 * An administrator sets M but cannot approve anything themselves. Lowering it
 * to 1 turns a multi-signature system into a single-signature one, so the
 * consequence is stated on the control rather than left to be inferred from a
 * number.
 */
function ThresholdControl({ policy, engineerCount, onChanged }) {
  const [value, setValue] = useState(policy?.thresholdM ?? 2);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => setValue(policy?.thresholdM ?? 2), [policy]);

  async function save() {
    setBusy(true);
    setMsg(null);
    const { data, error } = await api.setApprovalPolicy(Number(value), null);
    setBusy(false);
    if (error) return setMsg({ ok: false, text: data?.message ?? error });
    setMsg({ ok: true, text: `Threshold is now ${data.policy.threshold_m}.` });
    onChanged?.();
  }

  // The proposer's own signature never counts, so M approvers means M+1
  // engineers must exist before anything can ever be approved.
  const needed = Number(value) + 1;
  const short = engineerCount < needed;

  return (
    <div className="card">
      <div className="card-head">
        <span className="label">Approval threshold</span>
        <span className="unit num">currently {policy?.thresholdM ?? '—'}</span>
      </div>
      <div className="card-note">
        How many engineers must sign a configuration before it can be put into service. The
        person who proposed it never counts toward their own total.
      </div>

      <div className="cmd-grid">
        <label>
          <span>Signatures required</span>
          <input type="number" min="1" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
      </div>

      {Number(value) === 1 && (
        <div className="rolenote warn">
          At 1, a single engineer other than the proposer can approve a change on their own. Two
          people are still involved, but no third opinion is required.
        </div>
      )}

      {short && (
        <div className="rolenote warn">
          You have {engineerCount} engineer{engineerCount === 1 ? '' : 's'}. With a threshold of{' '}
          {value}, at least {needed} are needed before any configuration can be approved — the
          proposer plus {value} other{Number(value) === 1 ? '' : 's'}.
        </div>
      )}

      <div className="cmd-foot">
        <button className="btn" onClick={save} disabled={busy || Number(value) === policy?.thresholdM}>
          {busy ? 'Saving…' : 'Change threshold'}
        </button>
        <span className="cmd-cap">Recorded in the activity log.</span>
      </div>

      {msg && <div className={`cmd-result ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</div>}
    </div>
  );
}

export default function AdminPage({ currentUserId }) {
  const [users, setUsers] = useState([]);
  const [keys, setKeys] = useState([]);
  const [policy, setPolicy] = useState(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [u, k, p] = await Promise.all([api.users(), api.listKeys(), api.approvalPolicy()]);
    setUsers(u.data?.users ?? []);
    setKeys(k.data?.keys ?? []);
    setPolicy(p.data?.policy ?? null);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function revoke(keyId) {
    setBusy(true);
    await api.revokeKey(keyId, 'Revoked by administrator');
    setBusy(false);
    refresh();
  }

  const keyFor = (userId) => keys.find((k) => k.user_id === userId && k.status === 'active');
  const engineerCount = users.filter((u) => u.role === 'engineer' && u.status === 'active').length;
  const activeAdmins = users.filter((u) => u.role === 'admin' && u.status === 'active').length;

  const [confirmingAction, setConfirmingAction] = useState(null); // { userId, kind }
  const [actionReason, setActionReason] = useState('');
  const [actionError, setActionError] = useState(null);

  async function runAction(userId, kind) {
    setBusy(true);
    setActionError(null);
    const call = {
      deactivate: () => api.deactivateUser(userId, actionReason),
      reactivate: () => api.reactivateUser(userId, actionReason),
      delete: () => api.deleteFarmer(userId, actionReason),
    }[kind];
    const { data, error } = await call();
    setBusy(false);
    if (error) {
      setActionError(data?.message ?? error);
      return;
    }
    setConfirmingAction(null);
    setActionReason('');
    refresh();
  }

  return (
    <>
      <div className="h">
        <h1>Users &amp; keys</h1>
        <span className="sub">Accounts, signing keys, and the approval threshold</span>
      </div>

      <div className="cfg-cols">
        <div>
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head">
              <span className="label">Accounts</span>
              <span className="unit num">{users.length}</span>
            </div>
            <div className="ulist">
              {users.map((u) => {
                const key = keyFor(u.id);
                const isSelf = u.id === currentUserId;
                const isLastActiveAdmin = u.role === 'admin' && u.status === 'active' && activeAdmins <= 1;

                return (
                  <div className="urow" key={u.id}>
                    <div className="urow-main">
                      <b>{u.username}</b>
                      <span className="uid num">{u.id}</span>
                      <div className="uemail">{u.email}</div>
                    </div>

                    <div className="urow-tags">
                      <span className={`urole r-${u.role}`}>{u.role}</span>
                      {u.status !== 'active' && <span className="ustatus">{u.status}</span>}
                    </div>

                    {u.status !== 'deleted' && (
                      <div className="urow-lifecycle">
                        {confirmingAction?.userId === u.id ? (
                          <div className="ulifeconfirm">
                            <input
                              placeholder="Reason (required)"
                              value={actionReason}
                              autoFocus
                              onChange={(e) => setActionReason(e.target.value)}
                            />
                            <button
                              className="btn sm danger"
                              disabled={busy || !actionReason}
                              onClick={() => runAction(u.id, confirmingAction.kind)}
                            >
                              Confirm
                            </button>
                            <button
                              className="btn ghost sm"
                              onClick={() => {
                                setConfirmingAction(null);
                                setActionReason('');
                                setActionError(null);
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : u.status === 'suspended' ? (
                          <button
                            className="btn ghost sm"
                            onClick={() => setConfirmingAction({ userId: u.id, kind: 'reactivate' })}
                          >
                            Reactivate
                          </button>
                        ) : (
                          <div className="ulifebtns">
                            {isSelf ? (
                              <span className="muted" style={{ fontSize: 10 }}>
                                this is you
                              </span>
                            ) : isLastActiveAdmin ? (
                              <span className="muted" style={{ fontSize: 10 }}>
                                last administrator
                              </span>
                            ) : (
                              <>
                                <button
                                  className="btn ghost sm"
                                  onClick={() => setConfirmingAction({ userId: u.id, kind: 'deactivate' })}
                                >
                                  Deactivate
                                </button>
                                {/* Delete offered for farmers only — matches the
                                    server's own refusal for any other role, since
                                    an engineer's key and an admin's authority are
                                    things past records depend on. */}
                                {u.role === 'farmer' && (
                                  <button
                                    className="btn ghost sm danger-text"
                                    onClick={() => setConfirmingAction({ userId: u.id, kind: 'delete' })}
                                  >
                                    Delete
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    <div className="urow-key">
                      {u.role !== 'engineer' ? (
                        // Only engineers approve, so only engineers hold keys. A
                        // keypair for anyone else is an unused credential that
                        // still has to be protected.
                        <span className="muted" style={{ fontSize: 10 }}>
                          no key — does not approve
                        </span>
                      ) : key ? (
                        <>
                          <code>{key.key_id}</code>
                          <button
                            className="btn ghost sm"
                            disabled={busy}
                            onClick={() => revoke(key.key_id)}
                          >
                            Revoke
                          </button>
                        </>
                      ) : (
                        <span className="nokey">no signing key yet</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {actionError && <div className="cmd-result bad" style={{ margin: '0 14px 12px' }}>{actionError}</div>}
          </div>

          <InviteForm onInvited={refresh} />
        </div>

        <div className="stack">
          <ThresholdControl policy={policy} engineerCount={engineerCount} onChanged={refresh} />

          <div className="card">
            <div className="card-head">
              <span className="label">Revoked keys</span>
              <span className="unit num">{keys.filter((k) => k.status === 'revoked').length}</span>
            </div>
            <div className="card-note">
              Kept, never deleted. Configurations approved with a key must stay verifiable after
              it is retired — removing it would destroy the evidence, not tidy it.
            </div>
            <div className="plist">
              {keys
                .filter((k) => k.status === 'revoked')
                .map((k) => (
                  <div className="prow" key={k.key_id}>
                    <div className="prow-top">
                      <b className="num">{k.key_id}</b>
                      <span className="pstatus s-REJECTED">revoked</span>
                    </div>
                    <div className="prow-name">{k.username}</div>
                  </div>
                ))}
              {keys.filter((k) => k.status === 'revoked').length === 0 && (
                <p className="muted" style={{ padding: '0 2px 6px' }}>
                  None.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
