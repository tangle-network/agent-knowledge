/**
 * Retrieval briefing.
 *
 * A brief turns "retrieved" from something a run claims into something the
 * infrastructure can prove. It ranks the knowledge visible to a question,
 * renders it with the ids a later write must cite, and returns the ranked
 * results in the shape a retrieval receipt takes, so what an actor was given
 * is recorded rather than asserted.
 *
 * Pure: no clock, no filesystem, no network.
 */
import { canonicalCandidateDigest, type Sha256Digest } from '@tangle-network/agent-interface'
import type { OriginatedKnowledgeSearchResult } from './knowledge-use-receipts'
import type { OriginatedPage, PageOrigin } from './run-scoped'
import {
  KNOWLEDGE_SEARCH_RETRIEVER_ID,
  type KnowledgeSearchHit,
  searchKnowledgePages,
} from './search'
import type { KnowledgeId } from './types'

/** Pages in a brief when the caller names no limit. */
export const DEFAULT_KNOWLEDGE_BRIEF_LIMIT = 5

export interface KnowledgeBriefOptions {
  /** Maximum pages in the brief. Defaults to 5. */
  limit?: number
  /**
   * Drop pages whose own evidence refuted them. Defaults to true, the opposite
   * of `searchKnowledge`: a brief is injected before a run's first token and
   * offers every page it names with an id ready to cite, so a refuted page in
   * it is an invitation to build on a dead claim.
   */
  excludeInvalidated?: boolean
  /** Match pages carrying at least one of these tags. */
  tags?: readonly string[]
  /** Match the exact string stored in `frontmatter.kind`. */
  kinds?: readonly string[]
  /**
   * Bound on the rendered brief. A page whose line does not fit is left out of
   * the whole brief, so `text`, `hits`, `citationIds`, and `results` always
   * describe one identical set of pages.
   */
  maxChars?: number
}

export interface KnowledgeBrief {
  readonly question: string
  /** Retriever id to declare in a receipt minted from `results`. */
  readonly retrieverId: typeof KNOWLEDGE_SEARCH_RETRIEVER_ID
  /**
   * Digest of the retrieval settings this brief used. Pass it as the
   * `configDigest` of the receipt's retriever identity. The running package
   * version is the caller's to declare, because a bundled build cannot read it.
   */
  readonly retrieverConfigDigest: Sha256Digest
  readonly hits: readonly KnowledgeSearchHit[]
  /** The ids a write should persist in `cites`, in rank order. */
  readonly citationIds: readonly KnowledgeId[]
  /** Ranked results in the shape `createKnowledgeRetrievalReceipt` takes. */
  readonly results: readonly OriginatedKnowledgeSearchResult[]
  /** Deterministic Markdown: one `- [id] title — snippet` line per page, in rank order. */
  readonly text: string
}

/**
 * Rank the knowledge one question can see and render it for injection.
 *
 * The same page set produces the same brief on every run: ranking, ordering,
 * and rendering are deterministic, and no field carries a timestamp.
 */
export function buildKnowledgeBrief(
  visiblePages: readonly OriginatedPage[],
  question: string,
  options: KnowledgeBriefOptions = {},
): KnowledgeBrief {
  if (!Array.isArray(visiblePages)) {
    throw new TypeError('knowledge brief requires the visible pages')
  }
  if (typeof question !== 'string' || question.trim().length === 0) {
    throw new TypeError('knowledge brief question must be a non-empty string')
  }
  const limit = options.limit ?? DEFAULT_KNOWLEDGE_BRIEF_LIMIT
  const excludeInvalidated = options.excludeInvalidated ?? true
  const maxChars = options.maxChars
  if (maxChars !== undefined && (!Number.isInteger(maxChars) || maxChars < 0)) {
    throw new Error(`knowledge brief maxChars must be a non-negative integer, got ${maxChars}`)
  }

  const originByPage = new Map<object, PageOrigin>()
  for (const entry of visiblePages) originByPage.set(entry.page, entry.origin)

  const ranked = searchKnowledgePages(
    visiblePages.map((entry) => entry.page),
    question,
    {
      limit,
      excludeInvalidated,
      ...(options.tags === undefined ? {} : { tags: options.tags }),
      ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
    },
  )

  const hits: KnowledgeSearchHit[] = []
  const lines: string[] = []
  let length = 0
  for (const hit of ranked) {
    const line = briefLine(hit)
    const next = length === 0 ? line.length : length + 1 + line.length
    if (maxChars !== undefined && next > maxChars) break
    hits.push(hit)
    lines.push(line)
    length = next
  }

  return Object.freeze({
    question: question.trim(),
    retrieverId: KNOWLEDGE_SEARCH_RETRIEVER_ID,
    retrieverConfigDigest: canonicalCandidateDigest({
      limit,
      excludeInvalidated,
      tags: options.tags === undefined ? null : [...options.tags],
      kinds: options.kinds === undefined ? null : [...options.kinds],
      maxChars: maxChars ?? null,
    }),
    hits: Object.freeze(hits),
    citationIds: Object.freeze(hits.map((hit) => hit.citationId)),
    results: Object.freeze(
      hits.map((hit) => Object.freeze({ ...hit, origin: originOf(originByPage, hit) })),
    ),
    text: lines.join('\n'),
  })
}

function briefLine(hit: KnowledgeSearchHit): string {
  const snippet = hit.snippet.replace(/\s+/g, ' ').trim()
  return snippet === ''
    ? `- [${hit.citationId}] ${hit.page.title}`
    : `- [${hit.citationId}] ${hit.page.title} — ${snippet}`
}

function originOf(
  originByPage: ReadonlyMap<object, PageOrigin>,
  hit: KnowledgeSearchHit,
): PageOrigin {
  const origin = originByPage.get(hit.page)
  if (origin === undefined) {
    throw new Error(`knowledge brief ranked a page outside the visible chain: ${hit.page.path}`)
  }
  return origin
}
