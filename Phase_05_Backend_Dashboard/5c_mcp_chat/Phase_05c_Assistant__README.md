# The Read-Only Assistant — A Plain-Language Guide

**For a reader who is not a programmer.**

This folder documents Phase 05c of the Smart Decentralised Greenhouse: a chat
window on the dashboard where any member of staff can ask, in ordinary words,
what the greenhouse is doing and why. It answers the questions an examiner is
likely to ask, and points at the exact files where each answer can be checked.

> **Where the code actually lives.** This folder holds documentation. The code
> is part of the web server under `Phase_05_Backend_Dashboard/5a_web/`,
> because the assistant is a feature of the running application, not a
> separate program. The files are listed at the end.

---

## First, the most important thing

**The assistant cannot do anything. It can only explain.**

Every tool it has reads. None writes. It cannot switch a fan on, cannot change a
setting, cannot propose or approve a configuration, cannot stop the greenhouse.
This is not a rule the assistant follows; it is a property of what it was
given. The whole class of failure where a language model "misunderstood and did
something" is absent because there is nothing it could do.

What it *can* do: report the current readings and how fresh they are, explain
what the active configuration sets, describe what happened recently, report
what the audit chain does and does not prove, and suggest a next step — a step
the person asking is actually allowed to take.

---

## What it is called, and what it is not

The planning brief for this phase called it an "MCP server". That name was
wrong and has been corrected.

MCP is a protocol — a way for programs to talk to each other over a network.
Nothing in this phase speaks that protocol. The assistant's tools are called
inside the web server, in the same process, by the chat endpoint. The honest
name is a **tool-calling chat** or a **read-only assistant**.

The tools *are* written in the shape an MCP server would use, so that exposing
them over the protocol later is one additional route with no rewrite. That is
deliberate, documented in the record, and is a claim about the future, not
about what exists. Calling it an MCP server now would claim more than the
artifact delivers — the same kind of overclaim the project has caught and
corrected in earlier phases.

---

## Why it is allowed for every role

Three roles exist: administrator, engineer, farmer. All three can use the
assistant.

A tool whose only power is explanation has nothing to gate. If an
administrator can already see every chart and every event, a chat that
explains those charts adds no authority they lack. Restricting it would mean
some staff can understand what the system is doing and others cannot, which is
a strange property for a safety-relevant system.

What *does* change by role is the suggestion at the end. The assistant is told
who it is talking to, and:

- a **farmer** hears "you could issue a temporary command, or raise it with an
  engineer" — because a farmer can do the first and not change configuration;
- an **engineer** hears "you could review the active configuration, or issue a
  temporary command" — because an engineer can do both;
- an **administrator** hears an explanation with no operational suggestion —
  because administrators hold no operational authority by design.

Same facts, three different next steps. This was observed live on
3 September 2026, one question asked by each role, screenshots in the record.

---

## How it stays honest — the five rules

A chat is the least constrained surface in the whole system. Eight phases of
careful bounding could be undone by one confident sentence. So five rules were
written down before anything was built, and each has a *mechanism*, not just an
instruction:

| Rule | What would go wrong | How it is enforced |
|---|---|---|
| Never overclaim the audit chain | "the history is trustworthy" | The chain's own "proves / does not prove" text is handed to the model verbatim; a check after generation rejects words like *secure*, *tamper-proof*, *blockchain* in a ledger context |
| Never present stale data as current | Reporting a reading from twelve minutes before the device went offline as if it were now | Server status is fetched first, every turn, and injected before the model sees anything; a reply that reports readings while the edge is stale must say so, or it is rejected |
| Never imply the greenhouse self-regulates | "the system is maintaining humidity" | The brief states no firmware exists; the mock is named in the status line; a check rejects that phrasing when the mock is the source |
| Never recommend growing values | "raise humidity to 70 %" | A check rejects advisory or imperative phrasing followed by a number with a unit; the brief also forbids judging readings against what the crop needs |
| Quality flags must survive into prose | A failed sensor reported as a number | The model is never given the number. A reading flagged stale, failed or initialising is handed over as words — "STALE, last good value 15 min ago" — so there is no number to misreport |

When a check rejects a reply, the model is told exactly what it said wrong and
asked again, up to two more times. If it still fails, a fixed sentence is shown
instead — visibly marked, never the model's text.

The page shows all of this. Above every answer: the freshness line for that
turn. Below every answer: whether the checks accepted it on the first try, on a
retry, or gave up. Same size as the answer. Never small print.

---

## How the provider's key is kept

The assistant needs an API key for a language-model provider (OpenAI or
Anthropic). That key is worth money and must not leak.

It is stored **encrypted**, and the encryption is split between two people:

- The **server administrator** — who controls the deployment — generates an
  encryption key and puts it only in the deployment environment.
- The **dashboard administrator** — who manages users — pastes the provider's
  API key into the admin panel once. The server encrypts it with the
  server administrator's key and stores only the encrypted result.

Neither person alone can read the API key afterwards. The database holds
scrambled bytes; the environment holds the key to unscramble them; only the
running server, holding both, can use it — and it never shows it to anyone.
The admin panel displays "Configured · ends in …r04A · changed when by whom" and
nothing more. There is no button to reveal it, on purpose.

If someone alters the encrypted bytes in the database, the server notices —
the encryption is *authenticated* — and writes a loud, searchable line to its
log rather than quietly trying a corrupted key. This was demonstrated live by
flipping one bit and watching the log; the output is in the record.

**The honest limitation:** in this proof of concept, the database and the
environment sit on one machine, so compromising both is one break-in. The
split is real in *design*; it becomes real in *effect* when the database and
the application run on separate machines with separate administrators, which
is the production shape. The same framing applies to the audit chain: the
mechanism is demonstrated here; the guarantee materialises when distributed.

---

## What the assistant knows about the greenhouse

It is given a short written brief every time it answers: what the greenhouse
is, that no firmware exists yet and readings come from a simulator, what the
sensors and actuators are, how emergency stop works, what the configuration
blocks mean, what each role may do, and what the audit chain proves. That
brief is in `backend/src/mcp/brief.js` and was checked sentence by sentence
against the code, not against the thesis. Where the two disagreed — the
farmer's permissions — the code was right and the thesis is being corrected.

---

## What an examiner can check

| Claim | Where |
|---|---|
| No tool writes | `backend/src/mcp/tools.js` — eight tools, every one a GET |
| The assistant has no privileges of its own | `backend/src/services/chat-service.js` — every call forwards the user's own session cookie to the server's own API; there is no service token and no database access |
| Flagged readings carry no number | `tools.js`, `fmtReading()` |
| The five rules are checked, not hoped for | `backend/src/mcp/guard.js`; 29 tests in `backend/test/guard.test.js`, including the phrasings that must *not* be rejected |
| The key is never stored in plaintext | `db/007_provider_settings.sql` — there is no plaintext column; `backend/src/provider-crypto.js`; 18 tests |
| A tampered key is detected loudly | `PHASE_05c_RECORD.md`, live check 5 |
| Role-tailored suggestions were observed | `PHASE_05c_RECORD.md`, live check 6 |
| The name "MCP server" was wrong | This file, and the record's correction log |

---

## Files

```
Phase_05_Backend_Dashboard/5a_web/
  db/007_provider_settings.sql        encrypted key storage; new event type
  db/008_provider_openai.sql          second provider accepted
  db/009_provider_updated_by_text.sql correction (see record)
  backend/src/provider-crypto.js      AES-256-GCM seal/open, pure, tested
  backend/src/services/provider-service.js  store, status, decrypt-for-use
  backend/src/mcp/tools.js            the eight read-only tools
  backend/src/mcp/brief.js            what the model is told
  backend/src/mcp/guard.js            the five rules as checks
  backend/src/services/chat-service.js  the turn: status → tools → guard
  backend/src/routes.js               /api/provider, /api/chat, /api/chat/status
  backend/test/provider-crypto.test.js, guard.test.js
  frontend/src/components/AdminPage.jsx   the write-only key panel
  frontend/src/components/ChatPage.jsx    the Assistant page
  docker-compose.yml                  carries PROVIDER_KEK into the container
```
