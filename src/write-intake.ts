/**
 * Write-time intake gate.
 *
 * A store degrades in two ways that no post-hoc report reverses: a page lands
 * that restates knowledge already present without relating itself to it, and a
 * page lands citing an id that exists nowhere. Both are cheap to refuse at the
 * moment of the write and expensive to repair afterwards, so the gate runs
 * before bytes are committed.
 */
import {
  assertKnowledgeCitationsResolved,
  type KnowledgeCitationCandidate,
  parseKnowledgeCitationReference,
} from './citation-resolution'
import {
  detectNearDuplicatePages,
  type NearDuplicateDetectionOptions,
} from './rag-eval/near-duplicates'
import type { OriginatedPage } from './run-scoped'
import type { KnowledgeId, KnowledgePage } from './types'

/** One candidate that duplicates visible knowledge without relating itself to it. */
export interface KnowledgeDuplicateIntakePair {
  readonly candidatePageId: KnowledgeId
  readonly candidatePath: string
  readonly matchedPageId: KnowledgeId
  readonly matchedPath: string
  readonly similarity: number
  readonly exact: boolean
}

/**
 * A write duplicates visible knowledge and declares no relation to it.
 *
 * Every listed pair is cleared by one authoring action: cite the matched page,
 * name it in `contradicts`, or give the candidate the matched page's id so the
 * write is an update of it.
 */
export class KnowledgeDuplicateIntakeError extends Error {
  readonly pairs: readonly KnowledgeDuplicateIntakePair[]
  readonly threshold: number

  constructor(pairs: readonly KnowledgeDuplicateIntakePair[], threshold: number) {
    const summary = pairs
      .map(
        (pair) =>
          `${pair.candidatePath} ~ ${pair.matchedPath} (${pair.exact ? 'exact copy' : pair.similarity.toFixed(3)})`,
      )
      .join('; ')
    super(
      `knowledge write intake refused ${pairs.length} duplicate ${pairs.length === 1 ? 'pair' : 'pairs'}: ${summary}. Cite the matched page, name it in contradicts, or reuse its id to update it.`,
    )
    this.name = 'KnowledgeDuplicateIntakeError'
    this.pairs = Object.freeze([...pairs])
    this.threshold = threshold
  }
}

export interface KnowledgeWriteIntakeOptions {
  /**
   * The chain the write lands in, as `loadChain` reports it. Candidates replace
   * the `here` entries at the same paths; an inherited or shared page at one of
   * those paths stays visible, so a citation into it still reports its true
   * ambiguity.
   */
  readonly visiblePages: readonly OriginatedPage[]
  /** Near-duplicate detector settings. The detector's own defaults apply when absent. */
  readonly nearDuplicates?: NearDuplicateDetectionOptions
  /** Refuse a citation that resolves to no visible page. Defaults to true. */
  readonly citations?: boolean
}

/**
 * Refuse a write that duplicates visible knowledge or cites a page that exists
 * nowhere.
 *
 * The candidates are part of the corpus both checks see, so a batch may cite a
 * page it writes in the same call, and two candidates that duplicate each other
 * are caught before either lands.
 *
 * Returns the resolved citation candidates in the order the candidates declare
 * them.
 */
export function assertKnowledgeWriteIntake(
  candidates: readonly KnowledgePage[],
  options: KnowledgeWriteIntakeOptions,
): readonly KnowledgeCitationCandidate[] {
  if (!Array.isArray(candidates)) {
    throw new TypeError('knowledge write intake candidates must be an array')
  }
  if (!options || typeof options !== 'object' || !Array.isArray(options.visiblePages)) {
    throw new TypeError('knowledge write intake requires the visible pages of the target chain')
  }
  const candidatePaths = new Set(candidates.map((candidate) => candidate.path))
  const corpus: OriginatedPage[] = [
    ...options.visiblePages.filter(
      (entry) => !(entry.origin === 'here' && candidatePaths.has(entry.page.path)),
    ),
    ...candidates.map((page) => ({ page, origin: 'here' as const })),
  ]

  assertNoUnrelatedDuplicate(candidatePaths, corpus, options.nearDuplicates ?? {})
  if (options.citations === false) return Object.freeze([])
  return assertKnowledgeCitationsResolved(
    corpus,
    candidates.flatMap((candidate) =>
      (candidate.cites ?? []).map((persisted: string) =>
        parseKnowledgeCitationReference(persisted),
      ),
    ),
  )
}

function assertNoUnrelatedDuplicate(
  candidatePaths: ReadonlySet<string>,
  corpus: readonly OriginatedPage[],
  nearDuplicates: NearDuplicateDetectionOptions,
): void {
  if (candidatePaths.size === 0) return
  const report = detectNearDuplicatePages(
    corpus.map((entry) => entry.page),
    nearDuplicates,
  )
  const byIdentity = new Map<string, KnowledgePage>()
  for (const entry of corpus) {
    const key = identityKey(entry.page.path, entry.page.id)
    if (!byIdentity.has(key)) byIdentity.set(key, entry.page)
  }

  const offending: KnowledgeDuplicateIntakePair[] = []
  for (const pair of report.pairs) {
    const leftIsCandidate = candidatePaths.has(pair.leftPath)
    if (!leftIsCandidate && !candidatePaths.has(pair.rightPath)) continue
    // Two pages under one stable id are an identity defect, which the
    // `duplicate-page-id` lint owns. Here the same id means the write updates
    // the page it matched, which is the third way to relate the two.
    if (pair.leftPageId === pair.rightPageId) continue
    const left = byIdentity.get(identityKey(pair.leftPath, pair.leftPageId))!
    const right = byIdentity.get(identityKey(pair.rightPath, pair.rightPageId))!
    if (declaresRelation(left, right.id) || declaresRelation(right, left.id)) continue
    const candidate = leftIsCandidate ? left : right
    const matched = leftIsCandidate ? right : left
    offending.push({
      candidatePageId: candidate.id,
      candidatePath: candidate.path,
      matchedPageId: matched.id,
      matchedPath: matched.path,
      similarity: pair.similarity,
      exact: pair.exact,
    })
  }
  if (offending.length > 0) throw new KnowledgeDuplicateIntakeError(offending, report.threshold)
}

function identityKey(path: string, id: KnowledgeId): string {
  return `${path}\u0000${id}`
}

/** Whether `page` already relates itself to `targetId` through `cites` or `contradicts`. */
function declaresRelation(page: KnowledgePage, targetId: KnowledgeId): boolean {
  for (const persisted of page.cites ?? []) {
    if (parseKnowledgeCitationReference(persisted).pageId === targetId) return true
  }
  return (page.contradicts ?? []).includes(targetId)
}
