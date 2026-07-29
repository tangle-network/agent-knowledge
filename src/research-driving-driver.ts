/**
 * Research-DRIVING driver for `runVerifiedResearchLoop`.
 *
 * The shipped drivers all FILTER the worker's sources:
 *   - `createVerifyingResearchDriver` judges on-topic relevance,
 *   - `createAdaptiveResearchDriver` dedups then triages then escalates,
 *   - `createClaimGroundingVerifier` rejects misattributed citations.
 *
 * This driver does the OPPOSITE job: instead of narrowing the worker's output,
 * it DRIVES the research DEEPER each round. Its value is not "fewer sources" —
 * it is "more answered, better-corroborated sub-questions". Concretely, each
 * round it:
 *
 *   1. EXTRACTS the key claims from the worker's new sources (one LLM pass per
 *      source, in `verifySource`; falls back to a deterministic sentence-pull
 *      when the model is unavailable so a round never silently extracts nothing).
 *   2. TRACKS each claim's support — the set of INDEPENDENT sources (by canonical
 *      host) that assert it — and detects CONTRADICTIONS between a new claim and
 *      one already on the ledger.
 *   3. GENERATES the next round's DEEP sub-questions from the accumulated claims,
 *      in four kinds — comparative ("how does X's tradeoff differ from Y's?"),
 *      mechanism ("under what precise condition does X fail?"), gap ("what
 *      specific result is missing?"), and contradiction ("does any source
 *      challenge claim Z?").
 *   4. FLAGS weakly-supported claims (only ONE independent source) and
 *      contradicted claims as INVALIDATION targets and demands the worker find
 *      corroborating / refuting evidence for them.
 *   5. FOLDS the deep sub-questions + invalidation challenges into the worker's
 *      next prompt via the loop's `foldGaps` → `steer` channel — that is the
 *      mechanism that drives DEPTH and VALIDATION rather than breadth.
 *
 * COMPLETION (`isComplete` / the `done` judgment the caller gates on) does NOT
 * look at source COUNT. It is done only when every deep sub-question it raised
 * has been addressed AND every key claim is either supported by >= 2 independent
 * sources OR explicitly marked CONTESTED (a contradiction the loop surfaced and
 * could not resolve). A KB with twenty sources all asserting one unchallenged
 * claim is NOT done; a KB whose handful of claims are each corroborated or
 * contested IS.
 *
 * It reuses `runVerifiedResearchLoop` (it is a plain `ResearchDriver`), the web
 * worker, `claim-ledger.ts` (claim identity, independent-source identity, and
 * the merge rule), and the `RouterClient` chat surface; it reinvents none of
 * them.
 */

import {
  claimId,
  claimSourceHost as hostOf,
  mergeClaimLedgers,
  normalizeClaimText,
} from './claim-ledger'
import { sha256 } from './ids'
import { assertClaimLedgerId, type KbStore } from './kb-store'
import type { DeepQuestion, DeepQuestionKind, ResearchClaimLedger, TrackedClaim } from './types'
import type {
  KnowledgeGap,
  ResearchDriver,
  ResearchSourceProposal,
  SourceVerdict,
  SourceVerificationContext,
} from './verified-research-loop'
import {
  createTangleRouterClient,
  type RouterClient,
  type TangleRouterOptions,
} from './web-research-worker'

// The claim ledger's record types live in `types.ts` with the package's other
// persisted records — they are what a research run must survive a crash with,
// not driver-internal scratch. Re-exported here so existing importers keep
// working.
export type { DeepQuestion, DeepQuestionKind, ResearchClaimLedger, TrackedClaim }

/** The driver's accumulated research state — the completion oracle reads this. */
export interface ResearchDrivingState {
  /** Every claim extracted from the worker's sources, by id. */
  claims: TrackedClaim[]
  /** Every deep sub-question raised, by id. */
  questions: DeepQuestion[]
  /** Claims with exactly one independent source AND not contested. */
  weaklySupported: TrackedClaim[]
  /** Claims supported by >= 2 independent sources. */
  corroborated: TrackedClaim[]
  /** Claims marked contested (a surfaced, unresolved contradiction). */
  contested: TrackedClaim[]
  /** Deep questions still unaddressed. */
  openQuestions: DeepQuestion[]
  /** How many rounds the driver has folded steer for. */
  rounds: number
}

export interface ResearchDrivingDriverOptions {
  /** Router client for claim extraction + deep-question generation. */
  router?: RouterClient
  router_options?: TangleRouterOptions
  /**
   * A claim is CORROBORATED at this many INDEPENDENT supporting sources (distinct
   * canonical hosts). Default 2 — the task's ">= 2 independent sources" bar.
   */
  minIndependentSources?: number
  /** Max deep sub-questions to fold into one round's steer. Default 6. */
  maxQuestionsPerRound?: number
  /** Max claims to extract from a single source. Default 3. */
  maxClaimsPerSource?: number
  /**
   * When the extractor LLM is unavailable, fall back to a deterministic claim
   * pull (the source's leading sentences) so the driver still drives. Default
   * true. Set false to require the model (claims will be empty without it).
   */
  deterministicFallback?: boolean
  /** Observe each round's generated steer (for instrumentation / the script). */
  onSteer?: (steer: ResearchDrivingSteer) => void
}

/**
 * Options for the durable driver: the same driver plus a store to keep its
 * belief state in.
 */
export interface PersistentResearchDrivingDriverOptions extends ResearchDrivingDriverOptions {
  /** Where the claim ledger is read from and written to. */
  store: KbStore
  /**
   * Names this run's ledger. Stable across resumes (that is what makes a resume
   * a resume) and distinct per run against one knowledge base. Must be a single
   * safe path segment — see `assertClaimLedgerId`.
   */
  ledgerId: string
}

/** What the driver folded into one round's worker prompt, surfaced for audit. */
export interface ResearchDrivingSteer {
  round: number
  deepQuestions: DeepQuestion[]
  /** Claims it demanded corroborating/refuting evidence for this round. */
  invalidationTargets: TrackedClaim[]
  /** The readiness gaps it interleaved (passed through from the loop). */
  gaps: KnowledgeGap[]
  /** The full steer text handed to the worker. */
  text: string
}

/**
 * The research-driving driver. It is a `ResearchDriver` (drops straight into
 * `runVerifiedResearchLoop`) PLUS a completion oracle and live state, mirroring
 * how `createAdaptiveResearchDriver` exposes `stats()`.
 */
export interface ResearchDrivingDriver extends ResearchDriver {
  /** Live snapshot of the claim ledger + deep questions. */
  researchState(): ResearchDrivingState
  /**
   * The completion oracle — gate `done` on THIS, not on source count. True when
   * every deep sub-question is addressed AND every claim is corroborated
   * (>= `minIndependentSources` independent sources) or explicitly contested.
   * False while any claim is weakly-supported or any deep question is open.
   * Returns false before any claim has been seen (nothing researched yet).
   */
  isComplete(): boolean
  /**
   * The last round's generated steer, or undefined before the first fold. Useful
   * to assert the driver produced deeper questions / invalidation challenges.
   */
  lastSteer(): ResearchDrivingSteer | undefined
  /**
   * Write the current belief state to the store. `verifySource` already persists
   * after every claim it records; this exists for the state `foldGaps` produces —
   * the deep questions — which is raised by a synchronous hook and would
   * otherwise be lost if the process died before the next source arrived.
   *
   * `runVerifiedResearchLoop` calls this at the end of every round. A driver
   * built without a store has nothing to write and resolves immediately.
   */
  checkpoint(): Promise<void>
  /** The ledger record as it would be written right now. */
  toLedger(): ResearchClaimLedger
}

/** A claim the extractor returns for one source. */
interface ExtractedClaim {
  text: string
  /** A claim id ALREADY on the ledger that this one CONTRADICTS, if the model says so. */
  contradictsExistingId?: string
}

/**
 * The in-memory driver. Its belief state lives for exactly as long as the
 * process does — use `createPersistentResearchDrivingDriver` when the run must
 * survive a crash or resume.
 */
export function createResearchDrivingDriver(
  options: ResearchDrivingDriverOptions = {},
): ResearchDrivingDriver {
  return buildDriver(options)
}

/**
 * The durable driver: same behaviour, plus its claim ledger is read from the
 * store at construction and written back after every claim and every round.
 *
 * Construction is asynchronous because loading is I/O, and loading has to happen
 * before the caller can read `researchState()` or `isComplete()` — a driver that
 * loaded lazily would answer "nothing researched, not complete" for a run that
 * had already corroborated everything.
 */
export async function createPersistentResearchDrivingDriver(
  options: PersistentResearchDrivingDriverOptions,
): Promise<ResearchDrivingDriver> {
  const ledgerId = assertClaimLedgerId(options.ledgerId)
  const existing = await options.store.getClaimLedger(ledgerId)
  return buildDriver(options, { store: options.store, ledgerId }, existing ?? undefined)
}

interface DriverPersistence {
  store: KbStore
  ledgerId: string
}

function buildDriver(
  options: ResearchDrivingDriverOptions,
  persistence?: DriverPersistence,
  restored?: ResearchClaimLedger,
): ResearchDrivingDriver {
  const minIndependentSources = Math.max(2, options.minIndependentSources ?? 2)
  const maxQuestionsPerRound = Math.max(1, options.maxQuestionsPerRound ?? 6)
  const maxClaimsPerSource = Math.max(1, options.maxClaimsPerSource ?? 3)
  const deterministicFallback = options.deterministicFallback ?? true

  // The claim ledger, keyed by claim id (sha256 of the normalized claim text).
  const claims = new Map<string, TrackedClaim>(
    (restored?.claims ?? []).map((claim) => [claim.id, claim]),
  )
  // Every deep question raised, by id — so we can mark them addressed later.
  const questions = new Map<string, DeepQuestion>(
    (restored?.questions ?? []).map((question) => [question.id, question]),
  )
  let rounds = restored?.rounds ?? 0
  let goal = restored?.goal
  let lastSteer: ResearchDrivingSteer | undefined

  function toLedger(): ResearchClaimLedger {
    return {
      id: persistence?.ledgerId ?? 'in-memory',
      ...(goal === undefined ? {} : { goal }),
      updatedAt: new Date().toISOString(),
      rounds,
      claims: [...claims.values()].map((claim) => ({
        ...claim,
        supportingHosts: [...claim.supportingHosts],
        supportingUris: [...claim.supportingUris],
        contradicts: [...claim.contradicts],
      })),
      questions: [...questions.values()].map((question) => ({
        ...question,
        claimIds: [...question.claimIds],
      })),
    }
  }

  /**
   * Write this driver's belief state into the stored ledger and adopt the
   * result.
   *
   * It merges rather than overwrites, and then rehydrates from the merged
   * record, which is the whole of what makes knowledge compound across
   * workers. Two drivers on one ledger id — a resumed run beside a still-live
   * one, or two workers researching one goal in parallel — would otherwise each
   * write a whole record built from what it read before the other wrote, and
   * the later write would erase the earlier writer's claims. Rehydrating means
   * a claim another worker corroborated counts toward THIS driver's completion
   * oracle from the next round onward.
   */
  async function persist(): Promise<void> {
    if (!persistence) return
    const mine = toLedger()
    const merged = await persistence.store.mergeClaimLedger(persistence.ledgerId, (current) =>
      current === null ? mine : mergeClaimLedgers(current, mine),
    )
    claims.clear()
    for (const claim of merged.claims) claims.set(claim.id, claim)
    questions.clear()
    for (const question of merged.questions) questions.set(question.id, question)
    rounds = Math.max(rounds, merged.rounds)
    goal = merged.goal ?? goal
  }

  /**
   * A ledger accumulates evidence FOR a goal. Reusing one id across two goals
   * merges two runs' beliefs into one corroboration count, which is worse than
   * losing them, so it fails rather than merging.
   */
  function bindGoal(nextGoal: string): void {
    if (goal === undefined) {
      goal = nextGoal
      return
    }
    if (goal !== nextGoal) {
      throw new Error(
        `claim ledger '${persistence?.ledgerId ?? 'in-memory'}' accumulated evidence for goal ` +
          `'${goal}' and cannot be reused for '${nextGoal}'`,
      )
    }
  }

  function resolveRouter(): RouterClient {
    return options.router ?? createTangleRouterClient(options.router_options)
  }

  /** Record a claim from a source, growing its independent-source support. */
  function recordClaim(extracted: ExtractedClaim, sourceUri: string, round: number): TrackedClaim {
    const id = claimId(extracted.text)
    const host = hostOf(sourceUri)
    const existing = claims.get(id)
    if (existing) {
      if (host) addUnique(existing.supportingHosts, host)
      addUnique(existing.supportingUris, sourceUri)
      linkContradiction(existing, extracted.contradictsExistingId)
      return existing
    }
    const tracked: TrackedClaim = {
      id,
      text: extracted.text.trim(),
      supportingHosts: host ? [host] : [],
      supportingUris: [sourceUri],
      contradicts: [],
      contested: false,
      firstSeenRound: round,
    }
    linkContradiction(tracked, extracted.contradictsExistingId)
    claims.set(id, tracked)
    return tracked
  }

  /** Wire a bidirectional contradiction edge and mark BOTH claims contested. */
  function linkContradiction(claim: TrackedClaim, otherId: string | undefined): void {
    if (!otherId || otherId === claim.id) return
    const other = claims.get(otherId)
    if (!other) return
    addUnique(claim.contradicts, otherId)
    addUnique(other.contradicts, claim.id)
    claim.contested = true
    other.contested = true
  }

  /** A claim's independent-source count = distinct canonical hosts. */
  function independentSupport(claim: TrackedClaim): number {
    return claim.supportingHosts.length
  }

  function isCorroborated(claim: TrackedClaim): boolean {
    return independentSupport(claim) >= minIndependentSources
  }

  /** Weakly-supported = NOT corroborated AND NOT contested → an invalidation target. */
  function isWeak(claim: TrackedClaim): boolean {
    return !isCorroborated(claim) && !claim.contested
  }

  function snapshot(): ResearchDrivingState {
    const all = [...claims.values()]
    const allQuestions = [...questions.values()]
    return {
      claims: all,
      questions: allQuestions,
      weaklySupported: all.filter(isWeak),
      corroborated: all.filter(isCorroborated),
      contested: all.filter((claim) => claim.contested),
      openQuestions: allQuestions.filter((question) => !question.addressed),
      rounds,
    }
  }

  /**
   * Mark deep questions addressed when later evidence speaks to them. A question
   * is addressed once a NEW claim's text shares enough content words with the
   * question — i.e. the worker brought back evidence on the thing we asked about.
   * Cheap and deterministic; the LLM is reserved for GENERATING questions, not
   * grading them, so the oracle stays a non-model check.
   */
  function markAddressed(newClaimTexts: string[]): void {
    for (const question of questions.values()) {
      if (question.addressed) continue
      // Contradiction questions resolve when one of their claims becomes
      // corroborated or contested (the disagreement was surfaced/settled).
      if (question.kind === 'contradiction') {
        const settled = question.claimIds.some((id) => {
          const claim = claims.get(id)
          return claim ? isCorroborated(claim) || claim.contested : false
        })
        if (settled) question.addressed = true
        continue
      }
      const qWords = contentWordSet(question.text)
      if (qWords.size === 0) continue
      for (const text of newClaimTexts) {
        const overlap = overlapFraction(qWords, contentWordSet(text))
        if (overlap >= 0.5) {
          question.addressed = true
          break
        }
      }
    }
  }

  return {
    /**
     * `verifySource` — the per-source hook. This driver does NOT filter for
     * relevance/dedup (other drivers do that, and the loop already dedups exact
     * uris). Its job here is to EXTRACT the source's claims and grow the ledger.
     * It accepts every source that yields at least one extractable claim; it
     * only rejects a source with NO extractable signal at all (empty/unusable),
     * because such a source cannot drive the research and pollutes the KB.
     */
    async verifySource(
      source: ResearchSourceProposal,
      ctx: SourceVerificationContext,
    ): Promise<SourceVerdict> {
      bindGoal(ctx.goal)
      const extracted = await extractClaims(source, ctx)
      if (extracted.length === 0) {
        return {
          accept: false,
          reason: 'no extractable claim: source yields nothing to drive the research deeper',
        }
      }
      const newTexts: string[] = []
      for (const claim of extracted) {
        recordClaim(claim, source.uri, ctx.round)
        newTexts.push(claim.text)
      }
      markAddressed(newTexts)
      // Persist BEFORE accepting: the loop writes the source to the knowledge
      // base on `accept`, so a ledger write that failed after acceptance would
      // leave a source on disk whose claim nothing tracks.
      await persist()
      return { accept: true }
    },

    /**
     * `foldGaps` — the DEPTH driver. Runs after the worker's contribution is
     * applied each round. It builds the next round's steer from (1) the readiness
     * gaps the loop still reports, (2) freshly generated DEEP sub-questions, and
     * (3) INVALIDATION challenges for weakly-supported / contradicted claims.
     */
    foldGaps(gaps: KnowledgeGap[]): string {
      rounds += 1
      const round = rounds
      const ledger = [...claims.values()]

      // Invalidation targets: claims with one source (need corroboration) OR
      // contradicted claims (need a refutation/resolution). These are what the
      // worker is told to go SHORE UP, not new breadth.
      const invalidationTargets = ledger.filter(
        (claim) => isWeak(claim) || claim.contradicts.length > 0,
      )

      // Generate this round's deep sub-questions from the actual ledger claims
      // and register them so completion can track whether they get addressed.
      const deepQuestions = synthesizeDeepQuestions(ledger, round).slice(0, maxQuestionsPerRound)
      for (const question of deepQuestions) {
        if (!questions.has(question.id)) questions.set(question.id, question)
      }

      const text = buildSteerText(gaps, deepQuestions, invalidationTargets, minIndependentSources)
      lastSteer = { round, deepQuestions, invalidationTargets, gaps, text }
      options.onSteer?.(lastSteer)
      return text
    },

    researchState: snapshot,

    isComplete(): boolean {
      const all = [...claims.values()]
      if (all.length === 0) return false
      const everyClaimSettled = all.every((claim) => isCorroborated(claim) || claim.contested)
      const everyQuestionAddressed = [...questions.values()].every((question) => question.addressed)
      return everyClaimSettled && everyQuestionAddressed
    },

    lastSteer(): ResearchDrivingSteer | undefined {
      return lastSteer
    },

    checkpoint: persist,

    toLedger,
  }

  // -- claim extraction ------------------------------------------------------

  async function extractClaims(
    source: ResearchSourceProposal,
    ctx: SourceVerificationContext,
  ): Promise<ExtractedClaim[]> {
    const ledger = [...claims.values()]
    const fromLlm = await extractClaimsWithLlm(source, ctx, ledger)
    if (fromLlm.length > 0) return fromLlm.slice(0, maxClaimsPerSource)
    if (deterministicFallback) return deterministicClaims(source).slice(0, maxClaimsPerSource)
    return []
  }

  async function extractClaimsWithLlm(
    source: ResearchSourceProposal,
    ctx: SourceVerificationContext,
    ledger: TrackedClaim[],
  ): Promise<ExtractedClaim[]> {
    let router: RouterClient
    try {
      router = resolveRouter()
    } catch {
      return []
    }
    const excerpt = source.text.slice(0, 1800)
    const ledgerLines = ledger
      .slice(0, 20)
      .map((claim) => `- [${claim.id}] ${claim.text}`)
      .join('\n')
    const system =
      'You extract the KEY factual claims a researcher would cite a page for, and flag ' +
      'CONTRADICTIONS with claims already on the ledger. ' +
      "A claim is one concrete, checkable assertion using the page's own terms and numbers. " +
      'Return ONLY a JSON array; each item is {"claim": string, "contradicts": string|null} where ' +
      'contradicts is the bracketed [id] of a ledger claim this page DIRECTLY contradicts, else null. ' +
      `Return at most ${maxClaimsPerSource} claims. No prose.`
    const user = [
      `Research goal: ${ctx.goal}`,
      `Page title: ${source.title ?? '(none)'}`,
      ledgerLines ? `Claims already on the ledger:\n${ledgerLines}` : 'Ledger is empty.',
      `Page excerpt:\n${excerpt}`,
      'Key claims as JSON [{"claim": "...", "contradicts": "[id]"|null}]:',
    ].join('\n\n')

    let raw = ''
    try {
      raw = await router.chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        1200,
      )
    } catch {
      return []
    }
    return parseExtractedClaims(raw, ledger)
  }

  /**
   * Deterministic fallback: pull the leading sentences as candidate claims. Used
   * only when the model is unavailable, so the driver still drives (and the
   * offline test runs with no creds). Each sentence becomes a checkable claim.
   */
  function deterministicClaims(source: ResearchSourceProposal): ExtractedClaim[] {
    const sentences = source.text
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => contentWordSet(sentence).size >= 3)
    return sentences.slice(0, maxClaimsPerSource).map((text) => ({ text }))
  }

  // -- deep-question synthesis ----------------------------------------------

  /**
   * Build the four deep-question kinds from the actual ledger claims. This is
   * intentionally deterministic (not an LLM call): the loop's `foldGaps` contract
   * is synchronous (`foldGaps(gaps): string`), and a template grounded in the
   * real claim text gives a faithful, non-fabricated sub-question every round —
   * comparative, mechanism, gap, and contradiction. Claim EXTRACTION, which runs
   * inside the awaited `verifySource`, is where the model does the open-ended
   * work; question generation just interrogates what was extracted.
   */
  function synthesizeDeepQuestions(ledger: TrackedClaim[], round: number): DeepQuestion[] {
    if (ledger.length === 0) return []
    const out: DeepQuestion[] = []

    // CONTRADICTION questions: for every contradiction edge, ask the worker to
    // find evidence that resolves which claim holds.
    for (const claim of ledger) {
      for (const otherId of claim.contradicts) {
        const other = ledger.find((entry) => entry.id === otherId)
        if (!other || other.id < claim.id) continue // emit each pair once
        out.push(
          makeQuestion(
            'contradiction',
            `Does any independent source resolve the contradiction between "${truncate(claim.text)}" and "${truncate(other.text)}"? Find evidence that confirms or refutes one of them.`,
            [claim.id, other.id],
            round,
          ),
        )
      }
    }

    // GAP questions: for each weakly-supported claim, ask for the specific
    // corroborating result that is missing.
    for (const claim of ledger.filter((entry) => !entry.contested)) {
      if (claim.supportingHosts.length < minIndependentSources) {
        out.push(
          makeQuestion(
            'gap',
            `Only one independent source supports "${truncate(claim.text)}". What specific corroborating result, dataset, or independent measurement is missing to confirm it?`,
            [claim.id],
            round,
          ),
        )
      }
    }

    // Probe where the best-supported claims stop holding.
    for (const claim of [...ledger]
      .sort((a, b) => b.supportingHosts.length - a.supportingHosts.length)
      .slice(0, 2)) {
      out.push(
        makeQuestion(
          'mechanism',
          `Under what precise condition does "${truncate(claim.text)}" stop holding? Find a source that states the mechanism, limit, or failure mode.`,
          [claim.id],
          round,
        ),
      )
    }

    // Compare tradeoffs between the two best-supported claims.
    const ranked = [...ledger].sort((a, b) => b.supportingHosts.length - a.supportingHosts.length)
    if (ranked.length >= 2 && ranked[0] && ranked[1]) {
      out.push(
        makeQuestion(
          'comparative',
          `How does the tradeoff in "${truncate(ranked[0].text)}" differ from "${truncate(ranked[1].text)}"? Find a source that compares them directly.`,
          [ranked[0].id, ranked[1].id],
          round,
        ),
      )
    }

    // Stable order: contradiction → gap → mechanism → comparative (most urgent
    // validation work first).
    const priority: Record<DeepQuestionKind, number> = {
      contradiction: 0,
      gap: 1,
      mechanism: 2,
      comparative: 3,
    }
    return out.sort((a, b) => priority[a.kind] - priority[b.kind])
  }
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

function makeQuestion(
  kind: DeepQuestionKind,
  text: string,
  claimIds: string[],
  raisedRound: number,
): DeepQuestion {
  return {
    kind,
    text,
    id: `q_${sha256(`${kind}:${text}`).slice(0, 16)}`,
    claimIds,
    addressed: false,
    raisedRound,
  }
}

/**
 * Set-like insert into the array form. The ledger's collections are arrays so
 * they survive `JSON.stringify`; dedup is enforced here instead of by the type.
 */
function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value)
}

const stopwords = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'as',
  'by',
  'at',
  'from',
  'that',
  'this',
  'these',
  'those',
  'it',
  'its',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'has',
  'have',
  'had',
  'can',
  'will',
  'would',
  'should',
  'may',
  'might',
  'not',
  'no',
  'than',
  'then',
  'over',
  'under',
  'about',
  'into',
  'their',
  'they',
  'them',
])

function contentWordSet(text: string): Set<string> {
  return new Set(
    normalizeClaimText(text)
      .split(' ')
      .filter((word) => word.length >= 3 && !stopwords.has(word)),
  )
}

function overlapFraction(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0
  let hits = 0
  for (const word of a) if (b.has(word)) hits += 1
  return hits / a.size
}

function truncate(text: string, max = 140): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

/**
 * Parse the extractor's JSON array of `{claim, contradicts}` items, tolerant of
 * code fences / surrounding prose. `contradicts` is mapped from a `[id]` token to
 * a ledger claim id only when that id is actually on the ledger.
 */
function parseExtractedClaims(raw: string, ledger: TrackedClaim[]): ExtractedClaim[] {
  const text = raw.trim()
  if (!text) return []
  const arrayMatch = text.match(/\[[\s\S]*\]/)
  if (!arrayMatch) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(arrayMatch[0])
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const ledgerIds = new Set(ledger.map((claim) => claim.id))
  const out: ExtractedClaim[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const record = item as { claim?: unknown; contradicts?: unknown }
    if (typeof record.claim !== 'string' || !record.claim.trim()) continue
    const contradictsId = extractBracketId(record.contradicts)
    out.push({
      text: record.claim.trim(),
      contradictsExistingId:
        contradictsId && ledgerIds.has(contradictsId) ? contradictsId : undefined,
    })
  }
  return out
}

/** Pull a ledger id out of a `contradicts` field: `"[c_abc]"` or `"c_abc"`. */
function extractBracketId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.toLowerCase() === 'null') return undefined
  const bracket = trimmed.match(/\[([^\]]+)\]/)
  const id = (bracket?.[1] ?? trimmed).trim()
  return id.startsWith('c_') ? id : undefined
}

/**
 * Build the steer string handed to the worker's next prompt. Interleaves the
 * readiness gaps the loop still reports with the deep sub-questions and the
 * invalidation challenges — the part that drives DEPTH + VALIDATION.
 */
function buildSteerText(
  gaps: KnowledgeGap[],
  deepQuestions: DeepQuestion[],
  invalidationTargets: TrackedClaim[],
  minIndependentSources: number,
): string {
  const lines: string[] = []
  lines.push(
    'Do NOT just add more sources. Go DEEPER and VALIDATE. Address the following before adding breadth:',
  )

  if (deepQuestions.length > 0) {
    lines.push('', 'Deep sub-questions to answer this round:')
    for (const question of deepQuestions) {
      lines.push(`- (${question.kind}) ${question.text}`)
    }
  }

  if (invalidationTargets.length > 0) {
    lines.push(
      '',
      `Claims needing corroboration or refutation (each must reach >= ${minIndependentSources} INDEPENDENT sources, or be shown contested):`,
    )
    for (const claim of invalidationTargets) {
      const reason =
        claim.contradicts.length > 0
          ? 'CONTRADICTED by another source — find evidence that resolves it'
          : `only ${claim.supportingHosts.length} independent source — find a SECOND, independent corroborating source`
      lines.push(`- "${truncate(claim.text)}" — ${reason}`)
    }
  }

  if (gaps.length > 0) {
    lines.push('', 'Readiness gaps still open:')
    for (const gap of gaps) {
      lines.push(`- (${gap.blocking ? 'blocking' : 'soft'}) ${gap.description} [${gap.id}]`)
    }
  }

  return lines.join('\n')
}
