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

import { sha256, textSourceId } from './ids'
import type {
  DeepQuestion,
  ResearchClaimEvidence,
  ResearchClaimLedger,
  ResearchClaimRecord,
  ResearchSourceVersion,
} from './types'

/**
 * Claim identity = sha256 of the normalized claim text, so the same assertion
 * discovered independently by two workers is ONE claim with two supporting
 * sources rather than two claims with one each — which is the difference
 * between corroborated and unsupported.
 */
export function claimId(text: string): string {
  return `c_${sha256(normalizeClaimText(text)).slice(0, 16)}`
}

/** Stable identity for one extracted claim/source/contradiction observation. */
export function claimEvidenceId(
  claim: Pick<
    ResearchClaimEvidence,
    'claimId' | 'sourceId' | 'sourceUri' | 'sourceContentHash' | 'contradictsClaimId'
  >,
): string {
  return `e_${sha256(
    JSON.stringify([
      claim.claimId,
      claim.sourceId,
      claim.sourceUri,
      claim.sourceContentHash,
      claim.contradictsClaimId ?? null,
    ]),
  ).slice(0, 16)}`
}

/** Canonical key for one exact registry-id + original-URI + hash source version. */
export function researchSourceVersionKey(
  source: Pick<ResearchSourceVersion, 'sourceId' | 'uri' | 'contentHash'>,
): string {
  return JSON.stringify([source.sourceId, source.uri, source.contentHash])
}

/** Case-, whitespace-, and stylistic-punctuation-insensitive claim identity form. */
export function normalizeClaimText(text: string): string {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      // Direction and polarity change scientific meaning. Preserve them as word
      // tokens before removing stylistic punctuation, so `x > y` cannot merge
      // with `x < y`, and `+5%` cannot corroborate `-5%`.
      .replace(/<=|≤/gu, ' symbol_less_than_or_equal ')
      .replace(/>=|≥/gu, ' symbol_greater_than_or_equal ')
      .replace(/!=|≠/gu, ' symbol_not_equal ')
      .replace(/==|=/gu, ' symbol_equal ')
      .replace(/±/gu, ' symbol_plus_or_minus ')
      .replace(/[≈~]/gu, ' symbol_approximately ')
      .replace(/<|←|⇐/gu, ' symbol_less_or_left ')
      .replace(/>|→|⇒/gu, ' symbol_greater_or_right ')
      .replace(/[+]/gu, ' symbol_plus_or_positive ')
      .replace(/[-−]/gu, ' symbol_minus_or_negative ')
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/**
 * The canonical host a source uri counts as, which is what makes two sources
 * INDEPENDENT: corroboration is "distinct hosts", so this function is the rule
 * that decides whether a claim is confirmed or merely repeated. Exported so a
 * consumer building a `ResearchClaimRecord` cannot answer it a different way — a
 * consumer that counted raw uris would report two pages of one site as
 * independent confirmation.
 */
export function claimSourceHost(uri: string): string {
  try {
    return new URL(uri.trim()).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    // Non-URL identifier (offline corpus uris like `web/foo`): canonicalize so
    // distinct identifiers still count as distinct independent sources.
    return uri.trim().toLowerCase()
  }
}

/** Stable identity for one deep question. */
export function deepQuestionId(kind: DeepQuestion['kind'], text: string): string {
  return `q_${sha256(`${kind}:${text}`).slice(0, 16)}`
}

/**
 * Refuse a claim record whose identity or source count disagrees with its evidence.
 *
 * `supportingHosts` is used as the independent-source count, so accepting hosts
 * that cannot be derived from `supportingUris` would let a malformed record
 * manufacture corroboration. Canonical ordering also makes equal records have
 * equal bytes regardless of which process assembled them.
 */
export function assertTrackedClaimIntegrity(claim: ResearchClaimRecord): void {
  if (claim.id !== claimId(claim.text)) {
    throw new Error(`claim '${claim.id}' does not match its text-derived identity`)
  }
  if (claim.text !== claim.text.trim()) {
    throw new Error(`claim '${claim.id}' text must not have surrounding whitespace`)
  }
  if (claim.supportingUris.length === 0) {
    throw new Error(`claim '${claim.id}' must have registered supporting evidence`)
  }
  assertSortedUnique(`claim '${claim.id}' supportingUris`, claim.supportingUris)
  assertSortedUnique(`claim '${claim.id}' supportingHosts`, claim.supportingHosts)
  assertSortedUnique(`claim '${claim.id}' contradicts`, claim.contradicts)
  const expectedHosts = [
    ...new Set(claim.supportingUris.map(claimSourceHost).filter(Boolean)),
  ].sort()
  if (!sameStrings(claim.supportingHosts, expectedHosts)) {
    throw new Error(
      `claim '${claim.id}' supportingHosts must equal the hosts derived from supportingUris`,
    )
  }
  if (claim.contradicts.includes(claim.id)) {
    throw new Error(`claim '${claim.id}' cannot contradict itself`)
  }
  if (claim.contradicts.length > 0 && !claim.contested) {
    throw new Error(`claim '${claim.id}' with a contradiction must be contested`)
  }
  if (claim.contested && claim.contradicts.length === 0) {
    throw new Error(`claim '${claim.id}' cannot be contested without a contradiction`)
  }
}

/** Refuse a deep question whose stable identity or set fields are malformed. */
export function assertDeepQuestionIntegrity(question: DeepQuestion): void {
  if (question.id !== deepQuestionId(question.kind, question.text)) {
    throw new Error(`question '${question.id}' does not match its kind-and-text identity`)
  }
  if (question.text !== question.text.trim()) {
    throw new Error(`question '${question.id}' text must not have surrounding whitespace`)
  }
  assertSortedUnique(`question '${question.id}' claimIds`, question.claimIds)
}

/** Refuse an extracted observation whose identity or content is malformed. */
export function assertResearchClaimEvidenceIntegrity(evidence: ResearchClaimEvidence): void {
  if (evidence.claimId !== claimId(evidence.text)) {
    throw new Error(
      `claim evidence '${evidence.id}' does not match its text-derived claim identity`,
    )
  }
  if (evidence.id !== claimEvidenceId(evidence)) {
    throw new Error(`claim evidence '${evidence.id}' does not match its content-derived identity`)
  }
  if (evidence.text !== evidence.text.trim()) {
    throw new Error(`claim evidence '${evidence.id}' text must not have surrounding whitespace`)
  }
  if (!/^[a-f0-9]{64}$/.test(evidence.sourceContentHash)) {
    throw new Error(`claim evidence '${evidence.id}' sourceContentHash must be a SHA-256 digest`)
  }
  const expectedSourceId = textSourceId(evidence.sourceUri, evidence.sourceContentHash)
  if (evidence.sourceId !== expectedSourceId) {
    throw new Error(
      `claim evidence '${evidence.id}' sourceId does not match URI-and-content identity`,
    )
  }
  if (evidence.contradictsClaimId === evidence.claimId) {
    throw new Error(`claim evidence '${evidence.id}' cannot contradict its own claim`)
  }
}

/** Refuse a ledger that is not one canonical, internally consistent record. */
export function assertResearchClaimLedgerIntegrity(ledger: ResearchClaimLedger): void {
  if (ledger.schemaVersion !== 2) {
    throw new Error(`claim ledger '${ledger.id}' must use schema version 2`)
  }
  if (ledger.preparedRounds !== undefined && ledger.preparedRounds <= ledger.rounds) {
    throw new Error(
      `claim ledger '${ledger.id}' preparedRounds must be greater than completed rounds`,
    )
  }
  assertSortedUnique(
    `claim ledger '${ledger.id}' claimEvidence`,
    ledger.claimEvidence.map((evidence) => evidence.id),
  )
  for (const source of ledger.registeredSources) {
    if (
      source.sourceId.length === 0 ||
      source.uri.length === 0 ||
      !/^[a-f0-9]{64}$/.test(source.contentHash)
    ) {
      throw new Error(`claim ledger '${ledger.id}' contains an invalid registered source version`)
    }
    const expectedSourceId = textSourceId(source.uri, source.contentHash)
    if (source.sourceId !== expectedSourceId) {
      throw new Error(
        `registered source '${source.sourceId}' does not match URI-and-content identity '${expectedSourceId}'`,
      )
    }
  }
  assertSortedUnique(
    `claim ledger '${ledger.id}' registeredSources`,
    ledger.registeredSources.map((source) => source.sourceId),
  )
  assertSortedUnique(
    `claim ledger '${ledger.id}' claims`,
    ledger.claims.map((claim) => claim.id),
  )
  assertSortedUnique(
    `claim ledger '${ledger.id}' questions`,
    ledger.questions.map((question) => question.id),
  )
  for (const evidence of ledger.claimEvidence) assertResearchClaimEvidenceIntegrity(evidence)
  const registeredSources = new Set(ledger.registeredSources.map(researchSourceVersionKey))
  const registeredEvidence = ledger.claimEvidence.filter((evidence) =>
    registeredSources.has(
      researchSourceVersionKey({
        sourceId: evidence.sourceId,
        uri: evidence.sourceUri,
        contentHash: evidence.sourceContentHash,
      }),
    ),
  )
  const materializedClaims = new Map(ledger.claims.map((claim) => [claim.id, claim]))
  for (const claim of ledger.claims) {
    assertTrackedClaimIntegrity(claim)
    for (const sourceUri of claim.supportingUris) {
      if (
        !registeredEvidence.some(
          (evidence) => evidence.claimId === claim.id && evidence.sourceUri === sourceUri,
        )
      ) {
        throw new Error(
          `claim '${claim.id}' counts source '${sourceUri}' without exact registered evidence`,
        )
      }
    }
    for (const contradictedClaimId of claim.contradicts) {
      const contradictedClaim = materializedClaims.get(contradictedClaimId)
      if (!contradictedClaim) {
        throw new Error(
          `claim '${claim.id}' contradicts unmaterialized claim '${contradictedClaimId}'`,
        )
      }
      if (!contradictedClaim.contradicts.includes(claim.id)) {
        throw new Error(
          `claim '${claim.id}' has an asymmetric contradiction with '${contradictedClaimId}'`,
        )
      }
      const hasRegisteredObservation = registeredEvidence.some(
        (evidence) =>
          (evidence.claimId === claim.id && evidence.contradictsClaimId === contradictedClaimId) ||
          (evidence.claimId === contradictedClaimId && evidence.contradictsClaimId === claim.id),
      )
      if (!hasRegisteredObservation) {
        throw new Error(
          `claim '${claim.id}' contradicts '${contradictedClaimId}' without exact registered evidence`,
        )
      }
    }
  }
  const claimsById = materializedClaims
  const claimIds = new Set(claimsById.keys())
  for (const evidence of ledger.claimEvidence) {
    const sourceRegistered = registeredSources.has(
      researchSourceVersionKey({
        sourceId: evidence.sourceId,
        uri: evidence.sourceUri,
        contentHash: evidence.sourceContentHash,
      }),
    )
    if (!sourceRegistered) continue
    const claim = claimsById.get(evidence.claimId)
    if (!claim?.supportingUris.includes(evidence.sourceUri)) {
      throw new Error(
        `registered claim evidence '${evidence.id}' must be materialized in its claim`,
      )
    }
    if (
      evidence.contradictsClaimId !== undefined &&
      claimsById.has(evidence.contradictsClaimId) &&
      !claim.contradicts.includes(evidence.contradictsClaimId)
    ) {
      throw new Error(
        `registered claim evidence '${evidence.id}' must materialize its contradiction`,
      )
    }
  }
  for (const question of ledger.questions) {
    assertDeepQuestionIntegrity(question)
    for (const claimId of question.claimIds) {
      if (!claimIds.has(claimId)) {
        throw new Error(
          `question '${question.id}' references claim '${claimId}' outside its ledger`,
        )
      }
    }
  }
}

/** A ledger with nothing in it yet. */
export function emptyClaimLedger(id: string, goal?: string): ResearchClaimLedger {
  return {
    schemaVersion: 2,
    id,
    ...(goal === undefined ? {} : { goal }),
    updatedAt: new Date(0).toISOString(),
    rounds: 0,
    claimEvidence: [],
    registeredSources: [],
    claims: [],
    questions: [],
  }
}

/**
 * Turn only evidence backed by a confirmed source registration into support.
 *
 * This is a monotone closure: it never removes claims or evidence, and running
 * it twice is a no-op. Keeping it in the ledger algebra means a source-confirming
 * writer and an evidence-producing writer can arrive in either order.
 */
export function materializeRegisteredClaimEvidence(
  ledger: ResearchClaimLedger,
): ResearchClaimLedger {
  const registered = new Set(ledger.registeredSources.map(researchSourceVersionKey))
  const claims = new Map<string, ResearchClaimRecord>(
    ledger.claims.map((claim) => [claim.id, claim]),
  )
  for (const evidence of ledger.claimEvidence) {
    if (!registered.has(sourceVersionKeyOfEvidence(evidence))) continue
    const host = claimSourceHost(evidence.sourceUri)
    const observed: ResearchClaimRecord = {
      id: evidence.claimId,
      text: evidence.text,
      supportingHosts: host ? [host] : [],
      supportingUris: [evidence.sourceUri],
      contradicts: [],
      contested: false,
      firstSeenRound: evidence.firstSeenRound,
    }
    const existing = claims.get(observed.id)
    claims.set(observed.id, existing ? mergeTrackedClaims(existing, observed) : observed)
  }
  // A contradiction is active only when BOTH claims have registered support.
  // Keep the observation while its counterpart is pending, then close the edge
  // automatically when that counterpart is materialized by a later merge.
  for (const evidence of ledger.claimEvidence) {
    const otherId = evidence.contradictsClaimId
    if (!registered.has(sourceVersionKeyOfEvidence(evidence)) || !otherId || !claims.has(otherId)) {
      continue
    }
    const claim = claims.get(evidence.claimId)
    if (!claim) continue
    claims.set(claim.id, {
      ...claim,
      contradicts: union(claim.contradicts, [otherId]),
      contested: true,
    })
  }
  return linkClaimContradictions({
    ...ledger,
    claims: [...claims.values()].sort((left, right) => left.id.localeCompare(right.id)),
  })
}

function sourceVersionKeyOfEvidence(evidence: ResearchClaimEvidence): string {
  return researchSourceVersionKey({
    sourceId: evidence.sourceId,
    uri: evidence.sourceUri,
    contentHash: evidence.sourceContentHash,
  })
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
export function mergeTrackedClaims(
  base: ResearchClaimRecord,
  incoming: ResearchClaimRecord,
): ResearchClaimRecord {
  assertTrackedClaimIntegrity(base)
  assertTrackedClaimIntegrity(incoming)
  if (base.id !== incoming.id) {
    throw new Error(`cannot merge claim '${base.id}' with a different claim '${incoming.id}'`)
  }
  const text =
    incoming.firstSeenRound < base.firstSeenRound
      ? incoming.text
      : incoming.firstSeenRound > base.firstSeenRound
        ? base.text
        : incoming.text < base.text
          ? incoming.text
          : base.text
  return {
    id: base.id,
    // The earlier-seen text wins, so the claim's wording is stable across
    // merges rather than flipping with whichever writer wrote last. Equal
    // rounds use a lexical tie-break, preserving commutativity too.
    text,
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
  assertResearchClaimLedgerIntegrity(base)
  assertResearchClaimLedgerIntegrity(incoming)
  if (base.id !== incoming.id) {
    throw new Error(
      `cannot merge claim ledger '${base.id}' with a different ledger '${incoming.id}'`,
    )
  }
  if (base.goal !== undefined && incoming.goal !== undefined && base.goal !== incoming.goal) {
    throw new ClaimLedgerGoalConflictError(base.id, base.goal, incoming.goal)
  }
  const goal = base.goal ?? incoming.goal

  const claimEvidence = new Map<string, ResearchClaimEvidence>(
    base.claimEvidence.map((evidence) => [evidence.id, evidence]),
  )
  for (const evidence of incoming.claimEvidence) {
    const existing = claimEvidence.get(evidence.id)
    claimEvidence.set(evidence.id, existing ? mergeClaimEvidence(existing, evidence) : evidence)
  }

  const claims = new Map<string, ResearchClaimRecord>(base.claims.map((claim) => [claim.id, claim]))
  for (const claim of incoming.claims) {
    const existing = claims.get(claim.id)
    claims.set(claim.id, existing ? mergeTrackedClaims(existing, claim) : claim)
  }

  const questions = new Map<string, DeepQuestion>(
    base.questions.map((question) => [question.id, question]),
  )
  for (const question of incoming.questions) {
    const existing = questions.get(question.id)
    if (existing && (existing.kind !== question.kind || existing.text !== question.text)) {
      throw new Error(`question '${question.id}' has conflicting immutable content`)
    }
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

  const rounds = Math.max(base.rounds, incoming.rounds)
  const preparedRounds = Math.max(
    base.preparedRounds ?? base.rounds,
    incoming.preparedRounds ?? incoming.rounds,
  )
  return materializeRegisteredClaimEvidence({
    schemaVersion: 2,
    id: base.id,
    ...(goal === undefined ? {} : { goal }),
    updatedAt:
      incoming.updatedAt.localeCompare(base.updatedAt) > 0 ? incoming.updatedAt : base.updatedAt,
    rounds,
    ...(preparedRounds > rounds ? { preparedRounds } : {}),
    claimEvidence: [...claimEvidence.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    registeredSources: mergeSourceVersions(base.registeredSources, incoming.registeredSources),
    // Sorted by id so the bytes on disk depend on the ledger's content and not
    // on the order two writers happened to arrive in.
    claims: [...claims.values()].sort((a, b) => a.id.localeCompare(b.id)),
    questions: [...questions.values()].sort((a, b) => a.id.localeCompare(b.id)),
  })
}

function mergeClaimEvidence(
  base: ResearchClaimEvidence,
  incoming: ResearchClaimEvidence,
): ResearchClaimEvidence {
  assertResearchClaimEvidenceIntegrity(base)
  assertResearchClaimEvidenceIntegrity(incoming)
  if (
    base.id !== incoming.id ||
    base.claimId !== incoming.claimId ||
    base.sourceId !== incoming.sourceId ||
    base.sourceUri !== incoming.sourceUri ||
    base.sourceContentHash !== incoming.sourceContentHash ||
    base.contradictsClaimId !== incoming.contradictsClaimId
  ) {
    throw new Error(`claim evidence '${base.id}' has conflicting immutable content`)
  }
  const text =
    incoming.firstSeenRound < base.firstSeenRound
      ? incoming.text
      : incoming.firstSeenRound > base.firstSeenRound
        ? base.text
        : incoming.text < base.text
          ? incoming.text
          : base.text
  return {
    ...base,
    text,
    firstSeenRound: Math.min(base.firstSeenRound, incoming.firstSeenRound),
  }
}

function mergeSourceVersions(
  base: readonly ResearchSourceVersion[],
  incoming: readonly ResearchSourceVersion[],
): ResearchSourceVersion[] {
  const versions = new Map<string, ResearchSourceVersion>()
  for (const source of [...base, ...incoming]) {
    const existing = versions.get(source.sourceId)
    if (existing && researchSourceVersionKey(existing) !== researchSourceVersionKey(source)) {
      throw new Error(`registered source '${source.sourceId}' has conflicting immutable content`)
    }
    versions.set(source.sourceId, source)
  }
  return [...versions.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId))
}

/**
 * Make every contradiction edge symmetric and mark both ends contested.
 *
 * A contradiction is a property of a PAIR, and a writer only ever sees one side
 * of it: the worker that found the refuting source records "X contradicts Y" and
 * knows nothing about Y's record. Left one-sided, Y reads as an uncontested
 * claim, and the completion oracle would settle a question two sources disagree
 * about. `createResearchDrivingDriver` does this pairwise as it records; this is
 * the same rule stated over a whole ledger, for writers that assemble one from
 * events rather than from a live loop.
 *
 * One-sided observations stay in `claimEvidence` until both claims are backed
 * by registered source versions. The materialized claim projection contains
 * only closed pairs, so it cannot report a lone weak claim as settled merely
 * because its evidence named a claim that never arrived.
 */
export function linkClaimContradictions(ledger: ResearchClaimLedger): ResearchClaimLedger {
  const claimIds = new Set(ledger.claims.map((claim) => claim.id))
  const inbound = new Map<string, string[]>()
  for (const claim of ledger.claims) {
    for (const other of claim.contradicts) {
      if (other === claim.id || !claimIds.has(other)) continue
      const edges = inbound.get(other)
      if (edges) edges.push(claim.id)
      else inbound.set(other, [claim.id])
    }
  }
  return {
    ...ledger,
    claims: ledger.claims
      .map((claim) => {
        const contradicts = union(
          claim.contradicts.filter((other) => other !== claim.id && claimIds.has(other)),
          inbound.get(claim.id) ?? [],
        )
        return { ...claim, contradicts, contested: contradicts.length > 0 }
      })
      .sort((a, b) => a.id.localeCompare(b.id)),
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

function assertSortedUnique(label: string, values: readonly string[]): void {
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index - 1] ?? '') >= (values[index] ?? '')) {
      throw new Error(`${label} must be sorted and contain no duplicates`)
    }
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
