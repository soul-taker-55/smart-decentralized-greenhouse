# The Audit Chain — A Plain-Language Guide

**For a reader who is not a programmer.**

This folder documents Phase 07 of the Smart Decentralised Greenhouse. It answers
three questions an examiner has asked, in ordinary language, and points at the
exact files where each answer can be checked.

> **Where the code actually lives.** This folder holds documentation. The code
> itself is part of the web server and lives under
> `Phase_05_Backend_Dashboard/5a_web/`, because the audit chain is a feature of
> the running application rather than a separate program. Splitting it into its
> own folder would have divided one working system across two places.

---

## First, the most important thing

**This is not a blockchain, and the project does not claim it is.**

The correct name is a **hash-chained log**. The difference matters, and stating
it plainly is part of the work rather than an admission against it.

A blockchain has many independent computers that do not trust each other, all
keeping their own copy of the same record and voting on what is true. That
arrangement solves a specific problem: *how do strangers agree on a shared
history when no one is in charge?*

This greenhouse has one server, one database, and one administrator. There are no
strangers and no disagreement to settle. Building a blockchain here would add the
machinery of distributed agreement without the problem it solves — and every
claim that machinery normally supports would be false, because one person still
controls every copy.

So the project uses the one piece of the idea that genuinely applies: **linking
records together mathematically so that changing an old one is detectable.**
That is the hash chain. The rest is left out, honestly and on purpose.

---

## Question 1 — "What is the source code?"

Four files. Each does one thing.

### `5a_web/db/006_ledger.sql` — the table

Creates the storage. One row per recorded action, each holding: its position in
the chain, which action it describes, the fingerprint of the row before it, its
own fingerprint, and the exact text that fingerprint was calculated from.

Deliberately, this table has **no automatic protections** against deleting rows.
That looks like a mistake and is not. If the database physically prevented
someone from deleting a record, the check that detects deleted records could
never fire — the database would be quietly stopping the very thing the system is
trying to catch and prove. The record has to be *deletable* for the deletion to
be *detectable*.

### `5a_web/backend/src/ledger-link.js` — building one link

Takes one recorded action, writes it out as text in a completely fixed way, and
calculates its fingerprint.

"Completely fixed" is the whole job. If the same action could be written out two
slightly different ways — a space here, a date formatted differently there — the
two versions would produce different fingerprints, and honest records would look
tampered with. This file exists so that there is exactly one way to write
anything down, forever.

It handles no databases and no network. That makes it possible to test on any
computer, with nothing installed.

### `5a_web/backend/src/services/ledger-service.js` — writing and checking

Two jobs.

**Writing:** when the system records an action, this adds it to the chain in the
same breath, so an action cannot be recorded without being chained.

**Checking:** re-reads the whole chain and asks five questions. Does each link
point correctly at the one before it? Does each fingerprint still match its own
stored text? Does that text still match the live records it describes? Does the
action it refers to still exist? And is there any recorded action with no link at
all?

The fifth question is there because of the tidy attacker — someone who deletes
both the record and its link, leaving nothing dangling. The first four questions
only look at the chain, so they would see nothing missing. The fifth looks at the
records.

### `5a_web/backend/tools/tamper-demo.mjs` — the proof

A program that attacks the chain on purpose, six different ways, and prints what
the checking found. See "Running the demonstration" below.

---

## Question 2 — "How did you perform it?"

Every time the system records something an authorised person did — approving a
configuration, issuing a command, registering a signing key — it also writes a
**fingerprint** of that record.

A fingerprint here is a short string of letters and numbers produced from the
record's exact contents. Change one character anywhere in the record and the
fingerprint comes out completely different. It cannot be worked backwards, and
you cannot craft a different record that produces the same fingerprint.

The chain comes from one extra step: **each record's fingerprint is calculated
with the previous record's fingerprint included in it.**

```
   Record 1  ──▶ fingerprint A
   Record 2 + A ──▶ fingerprint B
   Record 3 + B ──▶ fingerprint C
```

Now suppose someone edits Record 2. Its fingerprint is no longer B. But Record 3
still expects B. The mismatch is visible, and so is every link after it. To hide
one edit you must rebuild everything that follows it.

**One thing goes further.** When an engineer approves a configuration, they sign
it with a private key that exists only in their own browser — the server never
receives it and has no place to store it. That signature is pulled into the
fingerprint calculation too. So the chain covers not only *what happened* but
*who cryptographically agreed to it*, and editing an approval in a different
table still breaks the chain.

You can see this yourself. Log into the dashboard and open **Activity**. The
panel at the top runs the full check when the page loads, and reports the result
in words — never a green tick, for reasons the panel itself explains.

---

## Question 3 — "Do you store any data on it?"

**No. Only evidence about the data.** The distinction is the design.

| Kind of thing | Where it lives | In the chain? |
|---|---|---|
| Configuration values — temperatures, watering thresholds | `config_profiles` table | **No** |
| Sensor readings, temperature and humidity history | separate `sdigf_db` database | **No** |
| Who did what, and when | `server_events` table | **Fingerprint only** |
| An engineer's approval signature | `config_approvals` table | **Fingerprint only** |

The chain holds fingerprints and links. The actual values stay in ordinary
database tables where the application reads and writes them normally.

**This is what makes tampering detectable.** Because the fingerprint was
calculated *from* the configuration and *from* the signature, the two must always
agree. Someone editing the database directly changes the configuration — but they
cannot change the fingerprint to match without also rebuilding every link after
it. The check re-reads the live records, recalculates, and finds the mismatch.

Keeping the values out of the chain is also the practical choice. Sensor readings
arrive continuously; a chain over them would grow without limit and would prove
nothing useful, because — see the honest limits below — no chain can make a
sensor honest.

---

## What this proves, and what it does not

The system states both. The second list is the more valuable one.

### It proves

No individual record was altered, deleted, or reordered after it was written, and
no recorded action is missing its link. Any single change of that sort is
detected and reported, naming the record and the field that changed.

Separately and more strongly: **an approval that was never given cannot be
invented.** The signature can only be produced by the private key, the key never
leaves the engineer's browser, and the server has never held it. Not even the
administrator can forge one.

### It does not prove

**The history as a whole cannot be authenticated.** An administrator with full
database access can delete a stretch of records and rebuild every link after
them, and the check will report that everything is fine. This is demonstrated
deliberately as the sixth scenario of the tamper demonstration.

The reason is simple: the chain begins inside this system, so a chain rebuilt
from the beginning is internally consistent by construction. Fixing this means
publishing the latest fingerprint somewhere the administrator cannot reach — a
newspaper, a public registry, another organisation's system. That is named as
future work and has not been built.

**A related limit worth stating.** After such a rewrite, the system reports a
number describing how much of the chain was recorded as it happened. Because the
rewriter wrote those rows, they choose that number too. It is a disclosure for an
honest operator, never a defence against a dishonest one.

**And the deepest limit.** No chain of this kind can confirm that a sensor
reading was truthful, only that what was written down has not been altered since.
If a sensor lies, or a device misreports when something occurred, the record is
faithfully preserved — and faithfully wrong. This is known as the Oracle Problem.
Most published work combining farming sensors with blockchains does not mention
it. This project states it plainly, because a chain that appears to guarantee
truthfulness would be making a promise it cannot keep.

---

## Running the demonstration

The demonstration attacks the chain six ways and prints what the checking found.
It is safe: it builds its own temporary database, damages that, and deletes it
afterwards. **The database this demo creates and destroys is fixed in the code
and cannot be changed by configuration. It never touches the project's real
data.**

### What you need

A running PostgreSQL database and its password. That is all — everything else is
included in the repository.

### The command

From `Phase_05_Backend_Dashboard/5a_web/backend`:

```bash
PG_PASS=<the database password> node tools/tamper-demo.mjs
```

Windows PowerShell:

```powershell
$env:PG_PASS="<the database password>"; node tools/tamper-demo.mjs
```

If something is missing, the program says so in a sentence and stops — for
example *"CANNOT RUN — no PostgreSQL server is listening at 127.0.0.1:5432"*,
followed by the command that fixes it. It checks before it starts, so it never
begins a demonstration it cannot finish.

Takes a few seconds. Prints a section per scenario.

### What you will see

| # | The attack | What the check reports |
|---|---|---|
| 1 | Change who performed an action | Detected, naming the field and both values |
| 2 | Delete a recorded action | Detected — the link points at nothing |
| 3 | Change an engineer's approval signature | Detected, **in a different table** from the chain |
| 4 | Delete a link from the chain | Detected — the next link no longer fits |
| 5 | Delete a link *and* its record together | Detected — a record exists with no link |
| 6 | Delete records and rebuild the whole chain | **Not detected — and that is the point** |

Scenario 3 is the one to watch. The change is made in a completely separate
table, yet the chain still breaks — because the approval signature was pulled
into the fingerprint when the link was built.

Scenario 6 is the closing demonstration and the most valuable. The check reports
everything is fine after a successful attack. The program then does one more
thing: it takes the engineer's surviving signature and verifies it against their
registered key. It still checks out. The ordering and the story were destroyed;
the proof that a particular engineer approved a particular configuration was not.

The program is careful to say exactly how far that goes. This attack deleted the
activity records; it did not delete the approval itself. An administrator who
deleted the approval too would leave nothing to verify. **The claim is that a
past approval cannot be forged — never that it cannot be erased.** Those are
different properties, and the demonstration says so on screen rather than letting
the stronger reading stand.

---

## In one paragraph

Every action taken through this system is recorded, and each record is
mathematically linked to the one before it, so that altering an old record breaks
the links that follow and the break can be found and named. Approvals go further:
they are signed with a key the server never sees, so an approval that was never
given cannot be manufactured by anyone, including whoever runs the server. What
the system does not claim is equally important — a determined administrator can
still destroy history, and no system of this kind can make a sensor tell the
truth. The project states those limits openly, because a design that hid them
would be claiming more than it can deliver.
