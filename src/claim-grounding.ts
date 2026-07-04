/**
 * Claim-grounding mode for `runVerifiedResearchLoop`.
 *
 * The two-agent loop's existing verifier judges a source's on-topic RELEVANCE
 * (is this page about the goal?). On the topic sets we have measured, its
 * cleanliness win is dominated by DE-DUPLICATION — which a deterministic
 * content-hash / canonical-URL check captures at ~none of the LLM premium (see
 * `docs/results/cost-quality.md`). That makes the LLM verifier look expensive
 * for what a cheap rule already does.
 *
 * Claim-grounding targets a DIFFERENT, harder error band: a citation that is
 * relevant and unique but **misattributed** — the page is on-topic, the URL is
 * real, yet the specific CLAIM the source is cited for does NOT actually appear
 * in the page. This is the citation-fabrication failure mode of LLM research:
 * the model writes a plausible sentence and hangs a real URL off it that never
 * says any such thing. Neither de-dup nor a relevance judge catches it (both can
 * pass a misattributed-but-on-topic page); only checking the claim against the
 * fetched text does.
 *
 * The check is EXECUTABLE GROUND TRUTH, not another LLM opinion: the worker
 * attaches the specific claim it is citing the source for, and the verifier
 * tests whether that claim is PRESENT (verbatim, normalized, or as a sufficient
 * content-word overlap / close paraphrase) in the `htmlToText` output of the
 * page the worker actually fetched. A claim that is not grounded is rejected as
 * misattributed. Because the oracle is deterministic text presence — not a model
 * call — it is a deployable, non-oracle verifier: it can run in production with
 * zero inference cost, OR be composed with the LLM relevance verifier so the
 * loop rejects BOTH off-topic AND misattributed sources.
 *
 * This module is content-free and any-topic: it adds (1) a way for a proposal to
 * carry the claim it is cited for, (2) the `groundClaimInText` oracle, and (3) a
 * `ResearchDriver` that gates on grounding. It composes the existing
 * `ResearchDriver` / `ResearchSourceProposal` contracts and the shipped
 * `htmlToText`; it reinvents none of them.
 */

import type {
  ResearchSourceProposal,
  SourceVerdict,
  SourceVerificationContext,
} from './two-agent-research-loop'
import {
  createTangleRouterClient,
  type RouterClient,
  type TangleRouterOptions,
} from './web-research-worker'

/**
 * Metadata key under which a proposal carries the specific claim it is cited
 * for. The worker sets `metadata[citedClaimKey] = '<the claim>'`; the
 * claim-grounding driver reads it and checks it against the fetched page text.
 */
export const citedClaimKey = 'citedClaim'

/** Read the cited claim a proposal carries, if any. */
export function citedClaimOf(source: ResearchSourceProposal): string | undefined {
  const claim = source.metadata?.[citedClaimKey]
  return typeof claim === 'string' && claim.trim() ? claim.trim() : undefined
}

/** Attach a cited claim to a proposal (immutably returns a new proposal). */
export function withCitedClaim(
  source: ResearchSourceProposal,
  claim: string,
): ResearchSourceProposal {
  return { ...source, metadata: { ...source.metadata, [citedClaimKey]: claim } }
}

export interface GroundingResult {
  /** True when the claim is sufficiently present in the page text. */
  grounded: boolean
  /** How the claim matched (or why it didn't). For audit/notes. */
  mode: 'verbatim' | 'normalized' | 'overlap' | 'absent' | 'empty-claim' | 'empty-text'
  /**
   * Fraction of the claim's content words found in the page text. 1 for a
   * verbatim/normalized hit; the measured overlap otherwise.
   */
  overlap: number
  /** Content words present in the claim but NOT in the page text. */
  missingWords: string[]
}

export interface GroundClaimOptions {
  /**
   * Minimum fraction of the claim's content words that must appear in the page
   * text to count as a close paraphrase when there is no verbatim/normalized
   * hit. Default 0.7 — a high bar, because a misattribution is exactly a claim
   * whose specific words the page does not contain.
   */
  minOverlap?: number
  /**
   * Content words shorter than this are ignored (drops "the", "of", "is", …)
   * and never count toward overlap. Default 3.
   */
  minWordLength?: number
}

/**
 * Stopwords stripped before overlap scoring so the bar measures the claim's
 * SUBSTANTIVE words (the numbers, nouns, methods it asserts), not filler a
 * misattributed page would trivially share with the real one.
 */
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

/** Normalize for presence checks: lowercase, collapse whitespace + punctuation. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The claim's substantive content words (deduped, stopwords + short words removed). */
function contentWords(claim: string, minWordLength: number): string[] {
  const words = normalize(claim)
    .split(' ')
    .filter((word) => word.length >= minWordLength && !stopwords.has(word))
  return [...new Set(words)]
}

/**
 * THE ORACLE. Is `claim` grounded in `pageText` (the `htmlToText` output of the
 * page the worker fetched)? Deterministic, no model call:
 *
 *   1. verbatim — the claim string appears as-is (case-insensitive).
 *   2. normalized — the claim appears after collapsing punctuation/whitespace
 *      on both sides (so "5.4x" vs "5.4 x", smart quotes, etc. still match).
 *   3. overlap — a close paraphrase: at least `minOverlap` of the claim's
 *      substantive content words appear in the page text. A misattributed page
 *      fails here because the SPECIFIC words the claim asserts are absent.
 *
 * Returns the match mode, the measured overlap, and the missing content words —
 * enough for the driver to give a precise rejection reason and for a test/doc to
 * audit WHY a claim grounded or didn't.
 */
export function groundClaimInText(
  claim: string,
  pageText: string,
  options: GroundClaimOptions = {},
): GroundingResult {
  const minOverlap = options.minOverlap ?? 0.7
  const minWordLength = Math.max(1, options.minWordLength ?? 3)

  const claimTrimmed = claim.trim()
  if (!claimTrimmed) return { grounded: false, mode: 'empty-claim', overlap: 0, missingWords: [] }
  if (!pageText.trim()) return { grounded: false, mode: 'empty-text', overlap: 0, missingWords: [] }

  const haystackLower = pageText.toLowerCase()
  if (haystackLower.includes(claimTrimmed.toLowerCase())) {
    return { grounded: true, mode: 'verbatim', overlap: 1, missingWords: [] }
  }

  const haystackNorm = normalize(pageText)
  const claimNorm = normalize(claimTrimmed)
  if (claimNorm && haystackNorm.includes(claimNorm)) {
    return { grounded: true, mode: 'normalized', overlap: 1, missingWords: [] }
  }

  const words = contentWords(claimTrimmed, minWordLength)
  if (words.length === 0) {
    // The claim has no substantive content words (all stopwords/short). With no
    // verbatim/normalized hit there is nothing to ground — treat as absent.
    return { grounded: false, mode: 'absent', overlap: 0, missingWords: [] }
  }
  // Word-boundary presence so "rotary" does not match inside "rotaryxyz".
  const present = words.filter((word) =>
    new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(haystackNorm),
  )
  const missingWords = words.filter((word) => !present.includes(word))
  const overlap = present.length / words.length
  const grounded = overlap >= minOverlap
  return { grounded, mode: grounded ? 'overlap' : 'absent', overlap, missingWords }
}

export interface ClaimGroundingDriverOptions extends GroundClaimOptions {
  /**
   * Optional second verifier to compose AFTER grounding passes. When set, a
   * source must BOTH ground its claim AND pass this verifier (e.g. the LLM
   * relevance driver's `verifySource`). Lets the loop reject off-topic AND
   * misattributed sources in one driver. Omit for the pure, zero-inference
   * grounding gate.
   */
  relevanceVerifier?: (
    source: ResearchSourceProposal,
    ctx: SourceVerificationContext,
  ) => Promise<SourceVerdict> | SourceVerdict
  /**
   * What to do when a proposal carries NO cited claim. `'reject'` (default) is
   * fail-closed: in claim-grounding mode every source must declare what it is
   * cited for, so an un-annotated source is treated as ungrounded. `'accept'`
   * lets un-annotated sources through to the relevance verifier (if any) —
   * useful when mixing annotated and legacy proposals.
   */
  onMissingClaim?: 'reject' | 'accept'
}

/**
 * A `ResearchDriver`-shaped verifier (just the `verifySource` arm) that gates on
 * CLAIM GROUNDING: it rejects a source whose cited claim is not present in its
 * fetched page text — a misattributed / fabricated citation — and (optionally)
 * composes a relevance verifier after grounding passes.
 *
 * The returned function matches `ResearchDriver['verifySource']`, so it drops
 * straight into `runVerifiedResearchLoop` as `{ verifySource: createClaimGroundingVerifier(...) }`.
 */
export function createClaimGroundingVerifier(options: ClaimGroundingDriverOptions = {}) {
  const onMissingClaim = options.onMissingClaim ?? 'reject'
  return async function verifySource(
    source: ResearchSourceProposal,
    ctx: SourceVerificationContext,
  ): Promise<SourceVerdict> {
    const claim = citedClaimOf(source)
    if (!claim) {
      if (onMissingClaim === 'reject') {
        return {
          accept: false,
          reason: 'no cited claim: claim-grounding mode requires every source to declare its claim',
        }
      }
      // accept-on-missing: fall through to the relevance verifier (or accept).
      return options.relevanceVerifier ? options.relevanceVerifier(source, ctx) : { accept: true }
    }

    const grounding = groundClaimInText(claim, source.text, options)
    if (!grounding.grounded) {
      const detail =
        grounding.mode === 'empty-text'
          ? 'fetched page has no text'
          : `claim not found in the fetched page (overlap ${(grounding.overlap * 100).toFixed(0)}%${
              grounding.missingWords.length
                ? `, missing: ${grounding.missingWords.slice(0, 6).join(', ')}`
                : ''
            })`
      return {
        accept: false,
        reason: `misattributed citation: ${detail}`,
      }
    }

    // Claim is grounded. Compose the relevance verifier if one was provided.
    if (options.relevanceVerifier) return options.relevanceVerifier(source, ctx)
    return { accept: true }
  }
}

export interface WorkerClaimDecorationOptions {
  router?: RouterClient
  router_options?: TangleRouterOptions
  /** Max output tokens for the claim-extraction call. Default 1200 (glm floor). */
  maxTokens?: number
}

/**
 * Ask an LLM to state, for one source, the single specific factual claim a
 * researcher would cite THIS page for toward the goal. Used to DECORATE the
 * sources a relevance-only worker produced with the claim a citation would make,
 * so the claim-grounding verifier has something executable to check. The model
 * is told to ground the claim in the provided excerpt; the verifier then checks
 * it against the FULL page text independently — the model does not get to mark
 * its own homework.
 *
 * Returns the proposal annotated via `withCitedClaim`, or the original proposal
 * unchanged if the model returns nothing parseable (the verifier's
 * `onMissingClaim` policy then decides).
 */
export function createClaimDecorator(options: WorkerClaimDecorationOptions = {}) {
  const maxTokens = options.maxTokens ?? 1200
  return async function decorate(
    source: ResearchSourceProposal,
    goal: string,
  ): Promise<ResearchSourceProposal> {
    const router = options.router ?? createTangleRouterClient(options.router_options)
    const excerpt = source.text.slice(0, 1500)
    const system =
      'You extract the single most important factual claim a researcher would cite a page for. ' +
      "State ONE concrete, checkable sentence using the page's own key terms and numbers. " +
      'Do NOT invent facts not in the excerpt. Respond with ONLY the claim sentence, no prose.'
    const user = [
      `Research goal: ${goal}`,
      `Page title: ${source.title ?? '(none)'}`,
      `Page excerpt:\n${excerpt}`,
      'The single claim this page should be cited for:',
    ].join('\n\n')
    let raw = ''
    try {
      raw = await router.chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        maxTokens,
      )
    } catch {
      return source
    }
    const claim = raw.trim().split('\n')[0]?.trim()
    if (!claim) return source
    return withCitedClaim(source, claim)
  }
}
