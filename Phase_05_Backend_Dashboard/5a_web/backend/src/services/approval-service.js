/**
 * SDIGF — M-of-N threshold approval.
 *
 * Replaces the 05a placeholder. The endpoint, the lifecycle and the event
 * schema are unchanged; only the body of the decision is real now.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FOUR RULES, AND WHERE EACH IS ENFORCED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. THE PROPOSER'S SIGNATURE DOES NOT COUNT.
 *    Enforced in the counting query, not in the UI. A system where the proposer
 *    can self-approve is a single-signature system wearing a threshold's
 *    clothes. Hiding the button would leave the endpoint open.
 *
 * 2. ONE KEY, ONE VOTE.
 *    Enforced by UNIQUE (config_profile_id, key_id) in the database. P-256
 *    signatures are NON-DETERMINISTIC: the same key signing the same hash twice
 *    produces different bytes and both verify. Counting signatures instead of
 *    distinct keys would let one approver reach a 2-of-N threshold alone.
 *    Deduplicating in application code would hold until the first race between
 *    concurrent submissions; the constraint holds under concurrency.
 *
 * 3. ONE REJECTION KILLS THE PROPOSAL.
 *    A threshold protects against a single actor pushing a change through. It
 *    is not a vote to be outnumbered — if a qualified engineer says a config is
 *    wrong, gathering more approvals does not make it right.
 *
 * 4. SIGNATURES ARE VERIFIED AGAINST THE HASH ACTUALLY STORED.
 *    Not against the hash the client claims. See castVote.
 */

import { query, transaction } from '../db.js';
import { config } from '../config.js';
import { verifySignature, getActiveKey } from './key-service.js';
import { appendToLedger } from './ledger-service.js';

export class ApprovalError extends Error {
  constructor(message, code = 'approval_failed') {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
  }
}

/** The M in M-of-N, plus proposal TTL. A table, so changing it leaves a record. */
export async function getPolicy(ghId = config.ghId) {
  const r = await query('SELECT * FROM approval_policy WHERE gh_id = $1', [ghId]);
  if (r.rows.length === 0) throw new ApprovalError('no approval policy configured', 'no_policy');
  return {
    ghId: r.rows[0].gh_id,
    thresholdM: r.rows[0].threshold_m,
    proposalTtlHours: r.rows[0].proposal_ttl_hours,
    updatedAt: r.rows[0].updated_at,
    updatedBy: r.rows[0].updated_by,
  };
}

/**
 * Change the threshold.
 *
 * Security-relevant in its own right: lowering M from 2 to 1 converts a
 * multi-signature system into a single-signature one. Recorded as an event for
 * exactly that reason, and the ledger chains it in a later phase.
 */
export async function setPolicy({ thresholdM, proposalTtlHours, actor }) {
  if (!Number.isInteger(thresholdM) || thresholdM < 1) {
    throw new ApprovalError('threshold must be a positive integer', 'bad_policy');
  }

  // ── The threshold must be satisfiable ─────────────────────────────────────
  //
  // The proposer's own signature never counts, so approving anything needs
  // thresholdM approvers PLUS the proposer — M+1 engineers holding active keys.
  //
  // Set M higher than that and nothing breaks loudly. Proposals simply sit at
  // PARTIALLY_APPROVED forever, with every signature valid and the count never
  // reaching the bar. There is no error to read and no obvious cause, and the
  // natural diagnosis is that signing is broken rather than that the policy is
  // unsatisfiable.
  //
  // Refusing at the point of change is the only place this is cheap to catch.
  // Warning in the interface is not enough — the endpoint is reachable without
  // it, and an unsatisfiable threshold is a self-inflicted denial of service on
  // the approval path.
  const eligible = await query(
    `SELECT count(*)::int AS n
     FROM users u
     JOIN user_keys k ON k.user_id = u.id AND k.status = 'active'
     WHERE u.role = 'engineer' AND u.status = 'active'`
  );
  const engineers = eligible.rows[0].n;

  if (thresholdM + 1 > engineers) {
    throw new ApprovalError(
      `a threshold of ${thresholdM} needs ${thresholdM + 1} engineers with active signing keys ` +
        `(the proposer plus ${thresholdM} approvers), but ${engineers} ` +
        `${engineers === 1 ? 'has' : 'have'} one. Nothing could ever be approved.`,
      'unsatisfiable'
    );
  }

  return transaction(async (client) => {
    const before = await client.query(
      'SELECT threshold_m, proposal_ttl_hours FROM approval_policy WHERE gh_id = $1 FOR UPDATE',
      [config.ghId]
    );

    const updated = await client.query(
      `UPDATE approval_policy
       SET threshold_m = $1,
           proposal_ttl_hours = COALESCE($2, proposal_ttl_hours),
           updated_at = now(), updated_by = $3
       WHERE gh_id = $4 RETURNING *`,
      [thresholdM, proposalTtlHours ?? null, actor?.id ?? null, config.ghId]
    );

    // PHASE 07: chained STRICTLY. A threshold change is the single highest-value
    // record in the trail — lowering M is how a quorum requirement gets weakened —
    // so it must not be possible for the change to land unchained.
    const event = await client.query(
      `INSERT INTO server_events (gh_id, event_type, ref_table, ref_id, actor_id, actor_role, detail)
       VALUES ($1, 'APPROVAL_POLICY_CHANGED', 'none', 0, $2, $3, $4)
       RETURNING id`,
      [
        config.ghId,
        actor?.id ?? null,
        actor?.role ?? null,
        JSON.stringify({
          from: before.rows[0],
          to: { threshold_m: thresholdM, proposal_ttl_hours: proposalTtlHours },
          // Flagged explicitly so a reader of the audit trail does not have to
          // compare numbers to notice the guarantee was weakened.
          weakened: thresholdM < (before.rows[0]?.threshold_m ?? 0),
        }),
      ]
    );

    await appendToLedger(client, event.rows[0].id);

    return updated.rows[0];
  });
}

/**
 * Current approval standing for a proposal.
 *
 * The counting query is where rules 1 and 3 live. Note `count(DISTINCT key_id)`
 * rather than `count(*)`, and the exclusion of the proposer.
 */
export async function getStanding(profileId) {
  const r = await query(
    `SELECT
       p.id, p.ver, p.status, p.cfg_hash, p.created_by AS proposer,
       (SELECT threshold_m FROM approval_policy WHERE gh_id = p.gh_id) AS threshold_m,
       count(DISTINCT a.key_id) FILTER (
         WHERE a.decision = 'approve' AND a.user_id <> p.created_by
       ) AS approvals,
       count(*) FILTER (WHERE a.decision = 'reject') AS rejections
     FROM config_profiles p
     LEFT JOIN config_approvals a ON a.config_profile_id = p.id
     WHERE p.id = $1
     GROUP BY p.id, p.ver, p.status, p.cfg_hash, p.created_by, p.gh_id`,
    [profileId]
  );
  if (r.rows.length === 0) throw new ApprovalError('no such config profile', 'not_found');

  const row = r.rows[0];
  const approvals = Number(row.approvals);
  const rejections = Number(row.rejections);
  const threshold = Number(row.threshold_m);

  return {
    profileId: row.id,
    ver: row.ver,
    status: row.status,
    cfgHash: row.cfg_hash,
    proposer: row.proposer,
    thresholdM: threshold,
    approvals,
    rejections,
    remaining: Math.max(0, threshold - approvals),
    satisfied: approvals >= threshold && rejections === 0,
    killed: rejections > 0,
  };
}

/** Who has voted, for the UI and for the audit trail. */
export async function listVotes(profileId) {
  const r = await query(
    // created_by travels with each vote for the provenance view.
    //
    // NOT A CONTROL. users.created_by is an ordinary column an administrator
    // can update, so an admin who manufactures a quorum can also erase the
    // lineage this exposes. It is a convenience for an HONEST audit and an
    // artifact showing the limitation was understood — nothing more. The
    // interface must not present it as a detection guarantee.
    `SELECT a.id, a.key_id, a.user_id, a.decision, a.cfg_hash, a.reason, a.created_at,
            u.username, u.created_by, c.username AS created_by_username,
            k.status AS key_status
     FROM config_approvals a
     JOIN users u ON u.id = a.user_id
     LEFT JOIN users c ON c.id = u.created_by
     JOIN user_keys k ON k.key_id = a.key_id
     WHERE a.config_profile_id = $1
     ORDER BY a.created_at ASC`,
    [profileId]
  );
  return r.rows;
}

/**
 * Record a signed approval or rejection.
 *
 * @param {number} profileId
 * @param {'approve'|'reject'} decision
 * @param {string} signatureHex  raw r||s over the cfg_canonical bytes
 * @param {object} actor         the authenticated user
 */
export async function castVote({ profileId, decision, signatureHex, reason, actor }) {
  if (!['approve', 'reject'].includes(decision)) {
    throw new ApprovalError('decision must be approve or reject', 'bad_decision');
  }
  if (!actor?.id) throw new ApprovalError('not authenticated', 'no_actor');

  const key = await getActiveKey(actor.id);
  if (!key) {
    throw new ApprovalError(
      'you have no active signing key — register one before approving',
      'no_key'
    );
  }

  return transaction(async (client) => {
    // FOR UPDATE: two concurrent votes must not both read a pre-threshold count
    // and both decide they were the one that satisfied it.
    const p = await client.query(
      'SELECT * FROM config_profiles WHERE id = $1 FOR UPDATE',
      [profileId]
    );
    if (p.rows.length === 0) throw new ApprovalError('no such config profile', 'not_found');
    const profile = p.rows[0];

    if (!['PROPOSED', 'PARTIALLY_APPROVED'].includes(profile.status)) {
      throw new ApprovalError(
        `config ${profileId} is ${profile.status}; only a PROPOSED config can be voted on`,
        'bad_state'
      );
    }

    // RULE 1. Enforced here, at the server, not by hiding a button.
    if (profile.created_by === actor.id) {
      throw new ApprovalError(
        'you proposed this config; the proposer\'s own signature does not count toward the threshold',
        'self_approval'
      );
    }

    // RULE 4. Verify against the canonical string AS STORED, never against
    // anything the client supplied. A client that could nominate what was
    // signed could have signed a different config entirely and presented a
    // valid signature over it.
    const check = verifySignature({
      cfgCanonical: profile.cfg_canonical,
      signatureHex,
      publicKeyHex: key.public_key,
    });
    if (!check.valid) {
      throw new ApprovalError(
        `signature rejected: ${check.reason}. The browser must sign the cfg_canonical BYTES, not cfg_hash.`,
        'bad_signature'
      );
    }

    // RULE 2 is the database's job. A duplicate raises a unique violation; it is
    // translated rather than pre-checked, because a pre-check loses the race.
    let inserted;
    try {
      inserted = await client.query(
        `INSERT INTO config_approvals
           (config_profile_id, key_id, user_id, decision, cfg_hash, signature, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          profileId,
          key.key_id,
          actor.id,
          decision,
          profile.cfg_hash,
          signatureHex,
          decision === 'reject' ? reason ?? null : null,
        ]
      );
    } catch (err) {
      if (err.code === '23505') {
        throw new ApprovalError(
          'you have already voted on this config; one key, one decision',
          'already_voted'
        );
      }
      throw err;
    }

    // PHASE 07: chained STRICTLY, and this is the ONLY site in the system that
    // writes a non-null signature_ref. The approval row it references was
    // inserted a few lines above IN THIS TRANSACTION, so resolveSignature finds
    // it and the link carries the resolved signature object. That is what makes
    // an edit to config_approvals break the chain — the cross-table reach the
    // chain-scope decision was made for.
    const event = await client.query(
      `INSERT INTO server_events
         (gh_id, event_type, ref_table, ref_id, actor_id, actor_role, detail, signature_ref)
       VALUES ($1, $2, 'config_profiles', $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        config.ghId,
        decision === 'approve' ? 'CONFIG_APPROVED' : 'CONFIG_REJECTED',
        profileId,
        actor.id,
        actor.role,
        JSON.stringify({
          keyId: key.key_id,
          cfgHash: profile.cfg_hash,
          // The 05a placeholder wrote stub:true. Its absence here is what
          // distinguishes a real approval from a placeholder one, permanently.
          verified: true,
          reason: reason ?? null,
        }),
        String(inserted.rows[0].id),
      ]
    );

    await appendToLedger(client, event.rows[0].id);

    // Re-count inside the transaction, so the status transition is decided from
    // the same snapshot the vote was written into.
    const counted = await client.query(
      `SELECT
         count(DISTINCT key_id) FILTER (WHERE decision = 'approve' AND user_id <> $2) AS approvals,
         count(*) FILTER (WHERE decision = 'reject') AS rejections
       FROM config_approvals WHERE config_profile_id = $1`,
      [profileId, profile.created_by]
    );
    const approvals = Number(counted.rows[0].approvals);
    const rejections = Number(counted.rows[0].rejections);

    const policy = await client.query(
      'SELECT threshold_m FROM approval_policy WHERE gh_id = $1',
      [config.ghId]
    );
    const threshold = Number(policy.rows[0].threshold_m);

    // RULE 3. One rejection is terminal — a threshold is not a vote to be
    // outnumbered.
    let newStatus = profile.status;
    if (rejections > 0) {
      newStatus = 'REJECTED';
    } else if (approvals >= threshold) {
      newStatus = 'APPROVED';
    } else if (approvals > 0) {
      newStatus = 'PARTIALLY_APPROVED';
    }

    if (newStatus !== profile.status) {
      await client.query(
        'UPDATE config_profiles SET status = $1, updated_at = now() WHERE id = $2',
        [newStatus, profileId]
      );
    }

    return {
      vote: inserted.rows[0],
      approvals,
      rejections,
      thresholdM: threshold,
      status: newStatus,
      satisfied: newStatus === 'APPROVED',
    };
  });
}

/**
 * Signatures to attach to a down/config publication.
 *
 * Approvals only — a rejection is not a credential. Returned in the shape
 * contract §3.6 expects, so the publisher passes it through unchanged.
 *
 * Note the device is given key_id and signature and nothing else: it resolves
 * the public key from its own trusted list, delivered separately over
 * down/keys. A signature accompanied by the key that made it proves nothing.
 */
export async function signaturesFor(profileId) {
  const r = await query(
    `SELECT key_id, signature FROM config_approvals
     WHERE config_profile_id = $1 AND decision = 'approve' AND signature IS NOT NULL
     ORDER BY created_at ASC`,
    [profileId]
  );
  return r.rows.map((s) => ({ key_id: s.key_id, sig: s.signature }));
}
