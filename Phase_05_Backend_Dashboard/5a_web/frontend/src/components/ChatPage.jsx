import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * The read-only assistant.
 *
 * It explains and suggests. It cannot act — there is no tool behind it that
 * writes anything, so nothing typed here can reach an actuator or a
 * configuration. That is a structural property of the backend, not a
 * property of this page; the page just says so.
 *
 * ── What this page renders at full weight, deliberately ──────────────────
 * Each reply carries the server's own freshness line for that turn (was the
 * edge stale? is the source the mock?) and the guard's verdict (how many
 * attempts it took, whether the fallback was returned). Both are shown at
 * the same visual weight as the answer, above and below it, never as muted
 * small print. A chat is the least constrained surface in this system; the
 * page's job is to keep the bounds visible.
 *
 * The conversation lives in this component's state only. The server stores
 * nothing about it; refreshing the page clears it.
 */

const UNAVAILABLE_WHO = {
  kek_missing: 'server administrator',
  not_configured: 'dashboard administrator',
  kek_rotated: 'dashboard administrator',
  tampered: 'dashboard administrator',
};

export default function ChatPage({ user }) {
  const [status, setStatus] = useState(null);
  const [messages, setMessages] = useState([]); // { role, content, meta? }
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const logRef = useRef(null);

  useEffect(() => {
    api.chatStatus().then(({ data }) => data && setStatus(data));
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, busy]);

  const usable = status?.usable === true;

  async function send() {
    const text = draft.trim();
    if (!text || busy || !usable) return;
    setError(null);
    setDraft('');
    const history = messages.map(({ role, content }) => ({ role, content }));
    setMessages((m) => [...m, { role: 'user', content: text }]);
    setBusy(true);
    const { data, error: err } = await api.chat(text, history);
    setBusy(false);
    if (err) {
      setError(data?.message ?? err);
      return;
    }
    setMessages((m) => [
      ...m,
      {
        role: 'assistant',
        content: data.reply,
        meta: {
          freshness: data.freshness,
          toolsUsed: data.toolsUsed ?? [],
          attempts: data.attempts,
          guarded: data.guarded,
          provider: data.provider,
          model: data.model,
        },
      },
    ]);
  }

  function onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <>
      <div className="h">
        <h1>Assistant</h1>
        <span className="sub">Explains and suggests. Cannot act.</span>
      </div>

      <div className="card chat">
        <div className="card-head">
          <span className="label">Read-only assistant</span>
          <span className={`unit ${usable ? 'ok' : 'warn'}`}>
            {status ? (usable ? `${status.provider} · ${status.model}` : 'unavailable') : '…'}
          </span>
        </div>

        <div className="card-note">
          Asks the same API the dashboard uses, with your session — it can read what you can read
          and nothing more. It has no tool that writes: no commands, no proposals, no configuration
          changes, and it will not recommend growing values. Suggestions are tailored to what a{' '}
          <b>{user?.role}</b> can actually do.
        </div>

        {status && !usable && (
          <div className="rolenote warn">
            {status.message} This is a <b>{UNAVAILABLE_WHO[status.status] ?? 'administrator'}</b>{' '}
            action.
          </div>
        )}

        <div className="chat-log" ref={logRef}>
          {messages.length === 0 && (
            <div className="chat-empty">
              Ask what the readings are, what the active configuration sets, what happened recently,
              or what the ledger verification means. Every answer starts with how fresh the data is.
            </div>
          )}

          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div className="chat-msg user" key={i}>
                <div className="chat-who">{user?.username}</div>
                <div className="chat-body">{m.content}</div>
              </div>
            ) : (
              <div className={`chat-msg assistant ${m.meta?.guarded ? 'guarded' : ''}`} key={i}>
                <div className="chat-who">assistant</div>
                {m.meta?.freshness && (
                  <div className={`chat-fresh ${/STALE|NEVER SEEN|UNKNOWN|NOT connected/.test(m.meta.freshness) ? 'warn' : ''}`}>
                    {m.meta.freshness}
                  </div>
                )}
                <div className="chat-body">{m.content}</div>
                <div className={`chat-meta ${m.meta?.guarded || m.meta?.attempts > 1 ? 'warn' : ''}`}>
                  {m.meta?.guarded
                    ? `guard: ${m.meta.attempts} attempts rejected — fallback shown, not the model's text`
                    : m.meta?.attempts > 1
                      ? `guard: accepted on attempt ${m.meta.attempts}`
                      : 'guard: accepted'}
                  {' · '}
                  {m.meta?.toolsUsed?.length ? `tools: ${m.meta.toolsUsed.join(', ')}` : 'no tools called'}
                </div>
              </div>
            )
          )}

          {busy && (
            <div className="chat-msg assistant pending">
              <div className="chat-who">assistant</div>
              <div className="chat-body muted">reading status, then answering…</div>
            </div>
          )}
        </div>

        {error && <div className="cmd-result bad" style={{ margin: '0 14px 12px' }}>{error}</div>}

        <div className="chat-input">
          <textarea
            rows={2}
            value={draft}
            placeholder={usable ? 'Ask about the greenhouse… (Enter to send, Shift+Enter for a new line)' : 'Assistant unavailable'}
            disabled={!usable || busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
          />
          <button className="btn" onClick={send} disabled={!usable || busy || !draft.trim()}>
            {busy ? 'Thinking…' : 'Send'}
          </button>
        </div>
        <div className="cmd-cap" style={{ padding: '0 14px 12px' }}>
          Nothing typed here is stored on the server. Refreshing the page clears the conversation.
        </div>
      </div>
    </>
  );
}
