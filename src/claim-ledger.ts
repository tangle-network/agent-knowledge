/**
 * The algebra of a research claim ledger: claim identity, and how two ledgers
 * that accumulated evidence for the same goal combine into one.
 *
 * This lives apart from `research-driving-driver.ts` because it is no longer
 * that driver's private business. A ledger is a durable record now, and a
 * durable record addressed by id is a record two writers can reach: two rounds
 * of one run resuming from disk, or two workers researching one goal in
 * parallel. `putClaimLedger` writes the whole record, so the second writer's
 * write erases the first writer's claims — the ledger persists and the
 * knowledge still does not compound. Combining is therefore part of what the
 * record MEANS, and it belongs next to the record rather than inside one
 * consumer of it.
 *
 * Every combination here is monotone: support only grows, contradiction edges
 * only accumulate, `contested` only latches on, `firstSeenRound` only moves
 * earlier. That is what makes it safe to apply twice — a retried write cannot
 * produce a different ledger than a single write did.
 */

import { sha256 } from './ids'
import type { DeepQuestion, ResearchClaimLedger, TrackedClaim } from './types'

/**
 * Claim identity = sha256 of the normalized claim text, so the same assertion
 * discovered independently by two workers is ONE claim with two supporting
 * sources rather than two claims with one each — which is the difference
 * between corroborated and unsupported.
 */
export function claimId(text: string): string {
  return `c_${sha256(normalizeClaimText(text)).slice(0, 16)}`
}

/** Case-, punctuation- and whitespace-insensitive form used for claim identity. */
export function normalizeClaimText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A ledger with nothing in it yet. */
export function emptyClaimLedger(id: string, goal?: string): ResearchClaimLedger {
  return {
    id,
    ...(goal === undefined ? {} : { goal }),
    updatedAt: new Date(0).toISOString(),
    rounds: 0,
    claims: [],
    questions: [],
  }
}

/**
 * Raised when two ledgers that accumulated evidence for DIFFERENT goals are
 * combined. Merging them would pool two questions' evidence into one
 * corroboration count, which reports a claim as independently confirmed when
 * nobody confirmed it — strictly worse than losing the ledger, so this refuses.
 */
export class ClaimLedgerGoalConflictError extends Error {
  constructor(
    readonly ledgerId: string,
    readonly existingGoal: string,
    readonly incomingGoal: string,
  ) {
    super(
      `claim ledger '${ledgerId}' accumulated evidence for goal '${existingGoal}' ` +
        `and cannot be merged with evidence for '${incomingGoal}'`,
    )
    this.name = 'ClaimLedgerGoalConflictError'
  }
}

/**
 * Combine two records of the same claim.
 *
 * Union on every support collection, because a claim asserted by hosts {a} in
 * one writer and {b} in another is asserted by two independent hosts and the
 * whole completion oracle turns on that count. `contested` is OR — one writer
 * seeing a contradiction is enough for the claim to be contested, and no later
 * writer that simply did not see it may clear the flag.
 */
export function mergeTrackedClaims(base: TrackedClaim, incoming: TrackedClaim): TrackedClaim {
  if (base.id !== incoming.id) {
    throw new Error(`cannot merge claim '${base.id}' with a different claim '${incoming.id}'`)
  }
  return {
    id: base.id,
    // The earlier-seen text wins, so the claim's wording is stable across
    // merges rather than flipping with whichever writer wrote last.
    text: incoming.firstSeenRound < base.firstSeenRound ? incoming.text : base.text,
    supportingHosts: union(base.supportingHosts, incoming.supportingHosts),
    supportingUris: union(base.supportingUris, incoming.supportingUris),
    contradicts: union(base.contradicts, incoming.contradicts),
    contested: base.contested || incoming.contested,
    firstSeenRound: Math.min(base.firstSeenRound, incoming.firstSeenRound),
  }
}

/**
 * Combine two ledgers for the same run.
 *
 * `addressed` on a question is OR for the same reason `contested` is: a writer
 * that answered a question has answered it, and a writer that never saw the
 * answer must not reopen it. Everything else is a union or an extreme, so this
 * is associative and idempotent — merge order cannot change the result and a
 * replayed merge is a no-op.
 */
export function mergeClaimLedgers(
  base: ResearchClaimLedger,
  incoming: ResearchClaimLedger,
): ResearchClaimLedger {
  if (base.id !== incoming.id) {
    throw new Error(
      `cannot merge claim ledger '${base.id}' with a different ledger '${incoming.id}'`,
    )
  }
  if (base.goal !== undefined && incoming.goal !== undefined && base.goal !== incoming.goal) {
    throw new ClaimLedgerGoalConflictError(base.id, base.goal, incoming.goal)
  }
  const goal = base.goal ?? incoming.goal

  const claims = new Map<string, TrackedClaim>(base.claims.map((claim) => [claim.id, claim]))
  for (const claim of incoming.claims) {
    const existing = claims.get(claim.id)
    claims.set(claim.id, existing ? mergeTrackedClaims(existing, claim) : claim)
  }

  const questions = new Map<string, DeepQuestion>(
    base.questions.map((question) => [question.id, question]),
  )
  for (const question of incoming.questions) {
    const existing = questions.get(question.id)
    questions.set(
      question.id,
      existing
        ? {
            ...existing,
            claimIds: union(existing.claimIds, question.claimIds),
            addressed: existing.addressed || question.addressed,
            raisedRound: Math.min(existing.raisedRound, question.raisedRound),
          }
        : question,
    )
  }

  return {
    id: base.id,
    ...(goal === undefined ? {} : { goal }),
    updatedAt:
      incoming.updatedAt.localeCompare(base.updatedAt) > 0 ? incoming.updatedAt : base.updatedAt,
    rounds: Math.max(base.rounds, incoming.rounds),
    // Sorted by id so the bytes on disk depend on the ledger's content and not
    // on the order two writers happened to arrive in.
    claims: [...claims.values()].sort((a, b) => a.id.localeCompare(b.id)),
    questions: [...questions.values()].sort((a, b) => a.id.localeCompare(b.id)),
  }
}

/**
 * Set union, SORTED.
 *
 * Sorted because these collections are sets and merging must be commutative:
 * arrival order is not part of what the ledger says, so two writers arriving in
 * either order have to produce identical bytes. Preserving first-seen order
 * instead made `merge(a, b)` and `merge(b, a)` differ, which the order-
 * independence test caught — and a non-commutative merge under a filesystem
 * lock means the record depends on scheduling.
 */
function union(base: readonly string[], incoming: readonly string[]): string[] {
  return [...new Set([...base, ...incoming])].sort()
}
