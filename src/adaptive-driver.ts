/**
 * Adaptive verifier mode for `runVerifiedResearchLoop`.
 *
 * The cost/quality A/B (`docs/results/cost-quality.md`) found the LLM relevance
 * verifier's cleanliness win is dominated by DE-DUPLICATION — which a
 * deterministic content-hash / canonical-URL check captures at ~none of the LLM
 * premium — and that an LLM check only earns its dollar on the off-scope tail.
 * The honest production move it names is: do the cheap deterministic work first,
 * spend the LLM only where it pays. This module is that driver.
 *
 * Per candidate source the adaptive driver runs THREE stages, cheapest first,
 * and stops at the first that decides:
 *
 *   1. DEDUP ($0, no LLM). Reject a source whose CONTENT (normalized-text hash)
 *      or whose CANONICAL URL matches one already accepted this round or already
 *      in the knowledge base. This is the de-dup the relevance judge was being
 *      paid to do; doing it deterministically is free and exact.
 *
 *   2. HEURISTIC TRIAGE ($0, no LLM). For a unique survivor, a cheap host /
 *      title / length signal classifies it as clearly-keep, clearly-drop, or
 *      AMBIGUOUS. Clear cases are resolved without a model: an authoritative host
 *      (arxiv, *.edu, *.gov, official docs) with a substantial readable body is
 *      kept; an obvious spam/listicle/marketing title or a too-thin body is
 *      dropped. Only genuinely ambiguous survivors fall through.
 *
 *   3. LLM ESCALATION ($, one call). ONLY the ambiguous survivors reach the LLM
 *      `verifySource` — the shipped `createVerifyingResearchDriver` relevance
 *      judge. This is where the verifier earns its premium: the off-scope tail a
 *      cheap rule can't adjudicate.
 *
 * The result is the cost/quality frontier point the doc predicted: most of the
 * cleanliness (dedup + clear drops) at a fraction of the LLM $/calls (only the
 * ambiguous tail pays). It is a real `ResearchDriver` — same contract the
 * two-agent loop already gates on — and reuses `sha256`, the relevance verifier,
 * and the index; it reinvents none of them.
 */

import { sha256 } from './ids'
import type {
  ResearchSourceProposal,
  SourceVerdict,
  SourceVerificationContext,
} from './verified-research-loop'
import {
  createVerifyingResearchDriver,
  type RouterClient,
  type TangleRouterOptions,
  type VerifyingDriverOptions,
} from './web-research-worker'

/**
 * Canonicalize a URL for duplicate detection: lowercase host, strip a leading
 * `www.`, drop the scheme, the fragment, a trailing slash, and tracking query
 * params (`utm_*`, `ref`, `fbclid`, `gclid`, …). Two URLs that differ only by
 * those decorations canonicalize to the same key, so the dedup stage treats them
 * as the same source. Falls back to the lowercased raw string when the input is
 * not a parseable absolute URL (so non-http identifiers still dedup by equality).
 */
export function canonicalizeUrl(uri: string): string {
  const trimmed = uri.trim()
  try {
    const url = new URL(trimmed)
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    // Keep only non-tracking query params, sorted for stable ordering.
    const kept: [string, string][] = []
    for (const [key, value] of url.searchParams) {
      const lower = key.toLowerCase()
      if (lower.startsWith('utm_')) continue
      if (trackingParams.has(lower)) continue
      kept.push([key, value])
    }
    kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const query = kept.map(([k, v]) => `${k}=${v}`).join('&')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    return `${host}${path}${query ? `?${query}` : ''}`
  } catch {
    return trimmed.toLowerCase()
  }
}

/** Tracking / referrer query params dropped during URL canonicalization. */
const trackingParams = new Set([
  'ref',
  'ref_src',
  'source',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'spm',
  '_hsenc',
  '_hsmi',
])

/**
 * A stable content key for a fetched page: the sha256 of its normalized text
 * (lowercased, punctuation/whitespace collapsed). Two pages whose readable body
 * is the same modulo formatting collide here, so the dedup stage rejects a
 * mirror/syndication of an already-accepted source even when the URL differs.
 */
export function contentKey(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return sha256(normalized)
}

/** Why the deterministic dedup stage rejected a candidate (for audit/notes). */
export type DedupReason = 'duplicate-url' | 'duplicate-content'

/** The cheap-triage classification of a unique survivor. */
export type TriageClass = 'keep' | 'drop' | 'ambiguous'

/** One source's adaptive routing decision, for instrumentation and the doc. */
export interface AdaptiveDecision {
  uri: string
  /** The stage that decided this source: dedup | heuristic | llm. */
  stage: 'dedup' | 'heuristic' | 'llm'
  accepted: boolean
  /** The triage class assigned (set once past dedup). */
  triage?: TriageClass
  reason?: string
}

/** Running tally of where the adaptive driver spent its decisions. */
export interface AdaptiveStats {
  total: number
  /** Rejected by deterministic dedup (URL or content). $0. */
  dedupRejected: number
  /** Kept by the cheap heuristic without an LLM call. $0. */
  heuristicKept: number
  /** Dropped by the cheap heuristic without an LLM call. $0. */
  heuristicDropped: number
  /** Escalated to the LLM relevance verifier ($ — the only paid stage). */
  llmCalls: number
  /** Of the escalations, how many the LLM accepted. */
  llmAccepted: number
  decisions: AdaptiveDecision[]
}

export interface AdaptiveDriverOptions {
  /** Router client for the LLM escalation. Defaults to a live client from env. */
  router?: RouterClient
  router_options?: TangleRouterOptions
  /** Passed through to the escalation relevance verifier. */
  verifying?: Pick<VerifyingDriverOptions, 'acceptOnParseFailure'>
  /**
   * Hosts an authoritative source lives on. A unique survivor on one of these,
   * with a substantial body, is KEPT deterministically (no LLM). Suffix-matched
   * against the canonical host, so `arxiv.org` matches `export.arxiv.org`. The
   * defaults cover papers, official docs, and standards bodies.
   */
  authoritativeHosts?: string[]
  /**
   * Title/snippet patterns that mark obvious spam / listicle / marketing — a
   * unique survivor matching one is DROPPED deterministically (no LLM).
   */
  spamPatterns?: RegExp[]
  /**
   * Below this many readable chars a survivor is too thin to be a real reference
   * and is dropped deterministically. Default 400.
   */
  minBodyChars?: number
  /**
   * A survivor whose body is at or above this many chars AND on an authoritative
   * host is kept without an LLM call. Default 600.
   */
  substantialBodyChars?: number
  /** Receives each routing decision as it is made (for live instrumentation). */
  onDecision?: (decision: AdaptiveDecision) => void
}

/** Default authoritative host suffixes — papers, official docs, standards. */
const defaultAuthoritativeHosts = [
  'arxiv.org',
  'aclanthology.org',
  'openreview.net',
  'dl.acm.org',
  'ieeexplore.ieee.org',
  'nature.com',
  'science.org',
  'pubmed.ncbi.nlm.nih.gov',
  'ncbi.nlm.nih.gov',
  '.edu',
  '.gov',
  'docs.python.org',
  'pytorch.org',
  'tensorflow.org',
  'huggingface.co',
  'github.com',
  'developer.mozilla.org',
  'wikipedia.org',
  'w3.org',
  'ietf.org',
  'rfc-editor.org',
]

/** Default spam/listicle/marketing title patterns. */
const defaultSpamPatterns = [
  /\bbuy\b.*\b(cheap|now|deal|sale|discount)\b/i,
  /\b\d+\s+(things|ways|reasons|tips|tricks|secrets|hacks)\b.*\b(you|that|will)\b/i,
  /\bshock(ing|ed)?\b/i,
  /\bclickbait\b/i,
  /!!!|\$\$\$/,
  /\b(coupon|promo code|affiliate|sponsored)\b/i,
  /\bbest .* (of \d{4}|in \d{4})\b/i,
]

/**
 * Classify a UNIQUE survivor (already past dedup) with cheap host/title/length
 * signals only — no LLM. Returns `keep`, `drop`, or `ambiguous`. `ambiguous` is
 * the residue the LLM is reserved for: on-topic-looking pages on unknown hosts
 * with a plausible body, which a host/title rule cannot adjudicate.
 */
export function triageSource(
  source: ResearchSourceProposal,
  options: {
    authoritativeHosts: string[]
    spamPatterns: RegExp[]
    minBodyChars: number
    substantialBodyChars: number
  },
): { triage: TriageClass; reason: string } {
  const titleAndSnippet = `${source.title ?? ''} ${
    typeof source.metadata?.snippet === 'string' ? source.metadata.snippet : ''
  }`.trim()
  const bodyLen = source.text.trim().length

  // Clear DROP: obvious spam/listicle/marketing title, OR a too-thin body that
  // can't be a real reference.
  for (const pattern of options.spamPatterns) {
    if (pattern.test(titleAndSnippet)) {
      return { triage: 'drop', reason: `spam/listicle title (${pattern.source})` }
    }
  }
  if (bodyLen < options.minBodyChars) {
    return { triage: 'drop', reason: `thin body (${bodyLen} < ${options.minBodyChars} chars)` }
  }

  // Clear KEEP: an authoritative host with a substantial readable body. The host
  // is a strong prior for a real reference; the length rules out a stub page.
  const host = hostOf(source.uri)
  const authoritative =
    host.length > 0 && options.authoritativeHosts.some((suffix) => hostMatches(host, suffix))
  if (authoritative && bodyLen >= options.substantialBodyChars) {
    return { triage: 'keep', reason: `authoritative host ${host} + substantial body (${bodyLen})` }
  }

  // Everything else is AMBIGUOUS — an unknown host with a plausible body. This
  // is exactly the off-scope tail the LLM relevance judge is reserved for.
  return { triage: 'ambiguous', reason: `unknown host ${host || '(none)'}, body ${bodyLen} chars` }
}

function hostOf(uri: string): string {
  try {
    return new URL(uri.trim()).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Suffix host match: `.edu` matches `mit.edu`; `arxiv.org` matches `export.arxiv.org`. */
function hostMatches(host: string, suffix: string): boolean {
  if (suffix.startsWith('.')) return host.endsWith(suffix) || host === suffix.slice(1)
  return host === suffix || host.endsWith(`.${suffix}`)
}

export interface AdaptiveResearchDriver {
  verifySource(
    source: ResearchSourceProposal,
    ctx: SourceVerificationContext,
  ): Promise<SourceVerdict>
  /** Live tally of where decisions were spent — the cost/quality instrumentation. */
  stats(): AdaptiveStats
}

/**
 * Build the adaptive verifier. The deterministic stages (dedup + heuristic
 * triage) cost $0; only AMBIGUOUS survivors escalate to the LLM relevance
 * verifier. `stats()` exposes where every decision was spent so the A/B can read
 * the LLM $/calls the adaptive driver saved against the cleanliness it kept.
 *
 * Dedup state is kept on the driver instance: it tracks the canonical URLs and
 * content hashes it has ACCEPTED, plus those it sees in the verification
 * context's `acceptedThisRound` and the KB index. Use one driver per loop run.
 */
export function createAdaptiveResearchDriver(
  options: AdaptiveDriverOptions = {},
): AdaptiveResearchDriver {
  const authoritativeHosts = options.authoritativeHosts ?? defaultAuthoritativeHosts
  const spamPatterns = options.spamPatterns ?? defaultSpamPatterns
  const minBodyChars = Math.max(1, options.minBodyChars ?? 400)
  const substantialBodyChars = Math.max(minBodyChars, options.substantialBodyChars ?? 600)

  // The shipped LLM relevance verifier — the ONLY paid stage, reused, not rebuilt.
  const relevance = createVerifyingResearchDriver({
    router: options.router,
    router_options: options.router_options,
    acceptOnParseFailure: options.verifying?.acceptOnParseFailure,
  })

  // Dedup memory across the run: every URL/content key this driver ACCEPTED.
  const acceptedUrlKeys = new Set<string>()
  const acceptedContentKeys = new Set<string>()

  const stats: AdaptiveStats = {
    total: 0,
    dedupRejected: 0,
    heuristicKept: 0,
    heuristicDropped: 0,
    llmCalls: 0,
    llmAccepted: 0,
    decisions: [],
  }

  function record(decision: AdaptiveDecision): void {
    stats.decisions.push(decision)
    options.onDecision?.(decision)
  }

  return {
    async verifySource(source, ctx): Promise<SourceVerdict> {
      stats.total += 1
      const urlKey = canonicalizeUrl(source.uri)
      const cKey = contentKey(source.text)

      // ---- STAGE 1: DETERMINISTIC DEDUP ($0) ----------------------------------
      // Seed the dup sets from what the loop already accepted this round AND from
      // the KB index, so a duplicate of an existing source is caught even if this
      // driver instance hasn't seen it yet.
      const roundUrlKeys = new Set(
        ctx.acceptedThisRound.map((accepted) => canonicalizeUrl(accepted.uri)),
      )
      const roundContentKeys = new Set(
        ctx.acceptedThisRound.map((accepted) => contentKey(accepted.text)),
      )
      const indexUrlKeys = new Set(
        ctx.index.sources.flatMap((indexed) =>
          typeof indexed.metadata?.originalUri === 'string'
            ? [canonicalizeUrl(indexed.metadata.originalUri)]
            : [],
        ),
      )
      const dupUrl =
        acceptedUrlKeys.has(urlKey) || roundUrlKeys.has(urlKey) || indexUrlKeys.has(urlKey)
      const dupContent = acceptedContentKeys.has(cKey) || roundContentKeys.has(cKey)
      if (dupUrl || dupContent) {
        stats.dedupRejected += 1
        const reason: DedupReason = dupUrl ? 'duplicate-url' : 'duplicate-content'
        record({ uri: source.uri, stage: 'dedup', accepted: false, reason })
        return { accept: false, reason: `dedup: ${reason}` }
      }

      // ---- STAGE 2: CHEAP HEURISTIC TRIAGE ($0) -------------------------------
      const { triage, reason } = triageSource(source, {
        authoritativeHosts,
        spamPatterns,
        minBodyChars,
        substantialBodyChars,
      })
      if (triage === 'keep') {
        stats.heuristicKept += 1
        acceptedUrlKeys.add(urlKey)
        acceptedContentKeys.add(cKey)
        record({ uri: source.uri, stage: 'heuristic', accepted: true, triage, reason })
        return { accept: true }
      }
      if (triage === 'drop') {
        stats.heuristicDropped += 1
        record({ uri: source.uri, stage: 'heuristic', accepted: false, triage, reason })
        return { accept: false, reason: `heuristic drop: ${reason}` }
      }

      // ---- STAGE 3: LLM ESCALATION ($ — ambiguous tail only) ------------------
      stats.llmCalls += 1
      const verdict = await relevance.verifySource(source, ctx)
      if (verdict.accept) {
        stats.llmAccepted += 1
        acceptedUrlKeys.add(urlKey)
        acceptedContentKeys.add(cKey)
      }
      record({
        uri: source.uri,
        stage: 'llm',
        accepted: verdict.accept,
        triage,
        reason: verdict.accept ? 'llm accepted' : verdict.reason,
      })
      return verdict
    },
    stats(): AdaptiveStats {
      return {
        ...stats,
        decisions: [...stats.decisions],
      }
    },
  }
}
