/**
 * Invalidation propagation.
 *
 * A page whose own evidence refuted it carries an `invalidation`. That verdict
 * is invisible to a reader who arrives through a citation, so a page that cites
 * a refuted page records which of its citations are refuted. The pass is
 * planned as a diff, so a store already stamped produces no mutation and the
 * pass can run after every grading round.
 */
import { parseKnowledgeCitationReference, resolveKnowledgeCitation } from './citation-resolution'
import { formatFrontmatter } from './frontmatter'
import type { OriginatedPage } from './run-scoped'
import type { KnowledgeId, KnowledgePage } from './types'

/** Frontmatter field naming the cited pages whose evidence refuted them. */
export const CITES_INVALIDATED_FIELD = 'citesInvalidated'

export interface KnowledgeInvalidationStamp {
  readonly page: KnowledgePage
  /** The value the field must hold, sorted and deduplicated. Empty removes the field. */
  readonly citesInvalidated: readonly KnowledgeId[]
  /** The value the page holds now, in the order it is stored. */
  readonly current: readonly KnowledgeId[]
}

export interface KnowledgeInvalidationPlan {
  /** Every visible page carrying an invalidation, sorted by id. */
  readonly invalidatedPageIds: readonly KnowledgeId[]
  /** Only the pages whose stamp differs from what they hold, in path order. */
  readonly stamps: readonly KnowledgeInvalidationStamp[]
}

/**
 * Plan the `citesInvalidated` stamp for every page authored in the target
 * store.
 *
 * Citations resolve over the whole chain, so a page here may be stamped for
 * citing a refuted inherited or shared page. Only `here` pages are stamped: a
 * run does not write the stores it inherits or shares.
 */
export function planInvalidationPropagation(
  visiblePages: readonly OriginatedPage[],
): KnowledgeInvalidationPlan {
  if (!Array.isArray(visiblePages)) {
    throw new TypeError('knowledge invalidation propagation requires the visible pages')
  }
  const invalidatedPageIds = [
    ...new Set(
      visiblePages
        .filter((entry) => entry.page.invalidation !== undefined)
        .map((entry) => entry.page.id),
    ),
  ].sort()

  const stamps: KnowledgeInvalidationStamp[] = []
  for (const entry of visiblePages) {
    if (entry.origin !== 'here') continue
    const page = entry.page
    const refuted = new Set<KnowledgeId>()
    for (const persisted of page.cites ?? []) {
      const resolution = resolveKnowledgeCitation(
        visiblePages,
        parseKnowledgeCitationReference(persisted),
      )
      if (resolution.resolved?.page.invalidation !== undefined) {
        refuted.add(resolution.resolved.page.id)
      }
    }
    const citesInvalidated = [...refuted].sort()
    const current = idList(page.frontmatter[CITES_INVALIDATED_FIELD])
    if (sameOrder(current, citesInvalidated)) continue
    stamps.push({ page, citesInvalidated, current })
  }
  stamps.sort((left, right) => left.page.path.localeCompare(right.page.path))
  return { invalidatedPageIds, stamps }
}

/**
 * Render one plan as a write-block proposal for `applyKnowledgeWriteBlocks`.
 *
 * Only the stamped field changes. The page is rendered through
 * `formatFrontmatter`, so its frontmatter is written in that writer's
 * normalized form.
 */
export function formatKnowledgeInvalidationProposal(plan: KnowledgeInvalidationPlan): string {
  return plan.stamps.map((stamp) => renderStampedBlock(stamp)).join('\n')
}

function renderStampedBlock(stamp: KnowledgeInvalidationStamp): string {
  const frontmatter: Record<string, unknown> = { ...stamp.page.frontmatter }
  if (stamp.citesInvalidated.length === 0) delete frontmatter[CITES_INVALIDATED_FIELD]
  else frontmatter[CITES_INVALIDATED_FIELD] = [...stamp.citesInvalidated]
  const content = formatFrontmatter(frontmatter, stamp.page.text)
  return `---FILE: ${stamp.page.path}---\n${content.replace(/\n+$/, '')}\n---END FILE---`
}

function idList(value: unknown): KnowledgeId[] {
  const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
  return values.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}
