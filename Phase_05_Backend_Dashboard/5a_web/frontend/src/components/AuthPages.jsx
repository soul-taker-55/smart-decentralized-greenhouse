import { useEffect, useState } from 'react';
import { api } from '../api.js';
import {
  generateKeypair,
  persistKey,
  loadKey,
  restoreFromBackup,
  backupBlob,
  backupFilename,
} from '../signing.js';

/**
 * Sign-in.
 *
 * There is no "create an account" link, because there is no self-registration
 * anywhere in this system. Accounts arrive by invitation from an administrator.
 * Saying so is better than leaving someone hunting for a sign-up form that will
 * never exist.
 */
export function LoginPage({ onSignedIn }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const { data, error: err } = await api.login(identifier, password, remember);
    setBusy(false);
    // The server returns one message for unknown account, wrong password and
    // suspended account alike. Repeating it verbatim keeps this form from
    // becoming an account-enumeration oracle.
    if (err) return setError(data?.message ?? err);
    onSignedIn(data.user);
  }

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="gate-brand">
          <b>SDIGF</b>
          <span>Greenhouse Prototype · gh1</span>
        </div>

        <div className="gate-fields">
          <label>
            <span>Username or email</span>
            <input
              value={identifier}
              autoFocus
              onChange={(e) => setIdentifier(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </label>
          <label className="gate-check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <span>Stay signed in on this device</span>
          </label>
        </div>

        {error && <div className="gate-error">{error}</div>}

        <button className="btn" onClick={submit} disabled={busy || !identifier || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <div className="gate-note">
          Accounts are created by invitation only. If you need access, ask an administrator to
          send you an invite link.
        </div>
      </div>
    </div>
  );
}

/**
 * Invite redemption.
 *
 * The link itself is the credential, so this page is reachable without a
 * session. It shows who the invite is for before a password is chosen, so a
 * mis-delivered link is obvious to whoever opened it rather than being
 * discovered after they have set a password on someone else's account.
 */
export function InvitePage({ token, onRedeemed }) {
  const [invite, setInvite] = useState(undefined);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.peekInvite(token).then(({ data }) => setInvite(data?.invite ?? null));
  }, [token]);

  async function submit() {
    setBusy(true);
    setError(null);
    const { data, error: err } = await api.redeemInvite(token, password);
    setBusy(false);
    if (err) return setError(data?.message ?? err);
    onRedeemed(data.user);
  }

  if (invite === undefined) return <div className="gate"><div className="gate-card">Checking invite…</div></div>;

  if (invite === null) {
    return (
      <div className="gate">
        <div className="gate-card">
          <div className="gate-brand"><b>SDIGF</b></div>
          <div className="gate-error">
            This invite is invalid, expired, or has already been used. Invites can only be
            redeemed once. Ask an administrator to send a new one.
          </div>
        </div>
      </div>
    );
  }

  const mismatch = confirm.length > 0 && password !== confirm;

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="gate-brand">
          <b>SDIGF</b>
          <span>Set your password</span>
        </div>

        <div className="gate-summary">
          <div><span>Account</span><b>{invite.username}</b></div>
          <div><span>Email</span><b>{invite.email}</b></div>
          <div><span>Role</span><b>{invite.role}</b></div>
        </div>

        <div className="gate-fields">
          <label>
            <span>Choose a password</span>
            <input type="password" value={password} autoFocus onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label>
            <span>Confirm</span>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
        </div>

        <div className="gate-hint">At least 12 characters. Length matters more than symbols.</div>
        {mismatch && <div className="gate-error">The two passwords do not match.</div>}
        {error && <div className="gate-error">{error}</div>}

        <button className="btn" onClick={submit} disabled={busy || !password || mismatch}>
          {busy ? 'Setting…' : 'Set password and continue'}
        </button>
      </div>
    </div>
  );
}

/**
 * Signing key setup, for engineers.
 *
 * The key is generated here, in this browser. The server receives only the
 * public half and could not reconstruct the private one from it. That is what
 * makes an approval something an administrator cannot forge.
 *
 * The consequence is stated rather than buried: there is no recovery. The
 * backup step is a gate, not a suggestion — the key is not stored anywhere
 * until the operator confirms they have saved it.
 */
export function KeySetup({ user, onDone }) {
  const [existing, setExisting] = useState(undefined);
  const [generated, setGenerated] = useState(null);
  const [downloaded, setDownloaded] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('generate');

  useEffect(() => {
    (async () => {
      const [{ data: server }, local] = await Promise.all([api.myKey(), loadKey()]);
      setExisting({ server: server?.key ?? null, local: local ?? null });
    })();
  }, []);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      setGenerated(await generateKeypair());
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  }

  function download() {
    const blob = backupBlob({
      privateJwk: generated.privateJwk,
      publicKeyHex: generated.publicKeyHex,
      username: user.username,
      keyId: null,
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = backupFilename(user.username);
    a.click();
    URL.revokeObjectURL(url);
    setDownloaded(true);
  }

  async function register() {
    setBusy(true);
    setError(null);
    const { data, error: err } = await api.registerKey(generated.publicKeyHex);
    if (err) {
      setBusy(false);
      return setError(data?.message ?? err);
    }
    // Stored only now — after the backup exists and the operator has said so.
    await persistKey({
      privateJwk: generated.privateJwk,
      publicKeyHex: generated.publicKeyHex,
      keyId: data.key.key_id,
      userId: user.id,
    });
    setBusy(false);
    onDone?.(data.key);
  }

  async function restore(file) {
    setBusy(true);
    setError(null);
    try {
      const parsed = JSON.parse(await file.text());
      const jwk = parsed.privateKey ?? parsed;
      const { publicKeyHex } = await restoreFromBackup(jwk);
      const { data } = await api.myKey();
      if (!data?.key) {
        setError('Restored, but you have no registered key on the server. Register this key first.');
      } else if (data.key.public_key !== publicKeyHex) {
        setError('This backup does not match your registered key. It may belong to a different account.');
      } else {
        onDone?.(data.key);
      }
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  }

  if (existing === undefined) return <p className="muted">Checking for a signing key…</p>;

  // Registered on the server but absent from this browser — the ordinary case
  // on a new machine, and the reason the backup exists.
  if (existing.server && !existing.local) {
    return (
      <div className="card keycard">
        <div className="card-head"><span className="label">Signing key not on this device</span></div>
        <div className="card-note">
          Your key <code>{existing.server.key_id}</code> is registered, but the private half is not
          in this browser. Restore it from your backup file to approve configurations here.
        </div>
        <div className="cmd-foot">
          <label className="btn sm">
            Restore from backup
            <input
              type="file"
              accept="application/json"
              style={{ display: 'none' }}
              onChange={(e) => e.target.files[0] && restore(e.target.files[0])}
            />
          </label>
        </div>
        {error && <div className="cmd-result bad">{error}</div>}
      </div>
    );
  }

  if (existing.server && existing.local) {
    return (
      <div className="card keycard">
        <div className="card-head">
          <span className="label">Signing key</span>
          <span className="unit num">{existing.server.key_id}</span>
        </div>
        <div className="card-note">
          Ready on this device. Configurations you approve are signed here; the private key has
          never been sent to the server.
        </div>
      </div>
    );
  }

  return (
    <div className="card keycard">
      <div className="card-head"><span className="label">Set up your signing key</span></div>
      <div className="card-note">
        Approving a configuration means signing it. The key is created in this browser and the
        private half is never sent to the server — which is what makes your approval something
        nobody else can produce, including an administrator.
      </div>

      <div className="whichrow" style={{ padding: '0 14px 10px' }}>
        <button className={`rbtn ${mode === 'generate' ? 'on' : ''}`} onClick={() => setMode('generate')}>
          Create a new key
        </button>
        <button className={`rbtn ${mode === 'restore' ? 'on' : ''}`} onClick={() => setMode('restore')}>
          Restore from backup
        </button>
      </div>

      {mode === 'restore' ? (
        <div className="cmd-foot">
          <label className="btn sm">
            Choose backup file
            <input
              type="file"
              accept="application/json"
              style={{ display: 'none' }}
              onChange={(e) => e.target.files[0] && restore(e.target.files[0])}
            />
          </label>
        </div>
      ) : !generated ? (
        <div className="cmd-foot">
          <button className="btn" onClick={generate} disabled={busy}>
            {busy ? 'Generating…' : 'Create key'}
          </button>
        </div>
      ) : (
        <div className="keysteps">
          <div className="keystep">
            <b>1 · Save your backup</b>
            <p>
              This is the only copy. If you lose it and this browser, you cannot approve anything
              until an administrator revokes the old key and you create a new one. The server
              cannot send it to you — it does not have it.
            </p>
            <button className="btn sm" onClick={download}>
              {downloaded ? 'Download again' : 'Download backup file'}
            </button>
          </div>

          <div className={`keystep ${downloaded ? '' : 'dim'}`}>
            <b>2 · Confirm</b>
            <label className="gate-check">
              <input
                type="checkbox"
                disabled={!downloaded}
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span>
                I have saved the backup somewhere safe and understand it cannot be recovered.
              </span>
            </label>
          </div>

          <div className={`keystep ${acknowledged ? '' : 'dim'}`}>
            <b>3 · Register</b>
            <p>Sends the public half to the server. The private half stays in this browser.</p>
            <button className="btn" onClick={register} disabled={!acknowledged || busy}>
              {busy ? 'Registering…' : 'Register key'}
            </button>
          </div>
        </div>
      )}

      {error && <div className="cmd-result bad">{error}</div>}
    </div>
  );
}
