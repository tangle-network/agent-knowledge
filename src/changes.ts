import type { KnowledgeFragment } from './sources/types'

/**
 * Change detection across snapshots of one source's fragments.
 *
 * The output drives the continuous-ingestion loop: each `KnowledgeChange`
 * carries the eval dimensions affected (`affectedDimensions`), which an
 * agent-eval campaign scheduler consumes to decide which campaigns to
 * re-run. Three change kinds:
 *
 *   - `added` — fragment id appears in `next` but not `prev`.
 *   - `removed` — fragment id appears in `prev` but not `next`. Typical
 *     trigger: an authority retires a Wex slug, or a state SOS reorganises
 *     its forms catalogue.
 *   - `modified` — fragment id appears in both, body hash differs. This
 *     is the dominant change kind in practice — the Ryan-LLC v. FTC
 *     vacatur case manifests as a `modified` on the Wex non-compete
 *     fragment, NOT as a removed one.
 *
 * Unverifiable fragments are filtered out before diffing — comparing a
 * captcha-blocked snapshot against a real one would falsely fire every
 * fragment as removed. The caller can inspect the raw lists if they want
 * to surface block-page failures.
 *
 * Within-snapshot duplicate ids are an upstream bug; this function picks
 * the LAST one and emits a diagnostic via the `warnings` field.
 *
 * @stable
 */

export type KnowledgeChangeKind = 'added' | 'removed' | 'modified'

export interface KnowledgeChange {
  /** Source-scoped id (matches `KnowledgeFragment.id`). */
  fragmentId: string
  kind: KnowledgeChangeKind
  /**
   * For `added`: full body of the new fragment.
   * For `removed`: full body of the prior fragment.
   * For `modified`: unified-diff-style payload `{ before, after }` body strings.
   */
  diff?: { before?: string; after?: string }
  /**
   * Eval dimensions to re-score. Computed as the union of both fragments'
   * `dimensionHints`. The eval cron treats this as a set of campaign tags.
   */
  affectedDimensions: string[]
  /** URL of the affected authority page (from whichever side has it). */
  url?: string
  /**
   * Source-attested change time. For `modified`, takes the NEXT fragment's
   * `sourceUpdatedAt`. For `removed`, takes the PRIOR fragment's
   * `sourceUpdatedAt`. For `added`, takes the NEXT fragment's
   * `sourceUpdatedAt`. Consumers index changes by this date.
   */
  detectedAt: string
}

export interface DetectChangesResult {
  changes: KnowledgeChange[]
  /** Counts by kind — handy for dashboards. */
  summary: { added: number; removed: number; modified: number }
  /** Non-fatal diagnostics (duplicate ids, dropped unverifiable fragments). */
  warnings: string[]
}

export interface DetectChangesOptions {
  /**
   * When true (default), unverifiable fragments are dropped from both
   * sides before comparison. Set false ONLY when debugging block-page
   * issues — comparing against unverifiable content emits false
   * `removed`/`modified` changes.
   */
  skipUnverifiable?: boolean
  /**
   * When provided, only changes whose `affectedDimensions` intersect this
   * set are returned. Useful for cron loops that schedule per-dimension
   * eval campaigns and only care about a subset.
   */
  filterDimensions?: string[]
}

export function detectChanges(
  prev: KnowledgeFragment[],
  next: KnowledgeFragment[],
  options: DetectChangesOptions = {},
): DetectChangesResult {
  const skipUnverifiable = options.skipUnverifiable ?? true
  const warnings: string[] = []

  const { map: prevMap, warnings: prevWarn } = indexFragments(prev, skipUnverifiable, 'prev')
  const { map: nextMap, warnings: nextWarn } = indexFragments(next, skipUnverifiable, 'next')
  warnings.push(...prevWarn, ...nextWarn)

  const changes: KnowledgeChange[] = []
  const seen = new Set<string>()

  for (const [id, nextFragment] of nextMap) {
    seen.add(id)
    const prevFragment = prevMap.get(id)
    if (!prevFragment) {
      changes.push({
        fragmentId: id,
        kind: 'added',
        diff: { after: nextFragment.body },
        affectedDimensions: dedup(nextFragment.dimensionHints),
        url: nextFragment.provenance.url,
        detectedAt: nextFragment.provenance.sourceUpdatedAt,
      })
      continue
    }
    if (prevFragment.bodyHash !== nextFragment.bodyHash) {
      changes.push({
        fragmentId: id,
        kind: 'modified',
        diff: { before: prevFragment.body, after: nextFragment.body },
        affectedDimensions: dedup([...prevFragment.dimensionHints, ...nextFragment.dimensionHints]),
        url: nextFragment.provenance.url,
        detectedAt: nextFragment.provenance.sourceUpdatedAt,
      })
    }
  }

  for (const [id, prevFragment] of prevMap) {
    if (seen.has(id)) continue
    changes.push({
      fragmentId: id,
      kind: 'removed',
      diff: { before: prevFragment.body },
      affectedDimensions: dedup(prevFragment.dimensionHints),
      url: prevFragment.provenance.url,
      detectedAt: prevFragment.provenance.sourceUpdatedAt,
    })
  }

  const filtered = options.filterDimensions
    ? changes.filter((c) => c.affectedDimensions.some((d) => options.filterDimensions?.includes(d)))
    : changes

  return {
    changes: filtered,
    summary: {
      added: filtered.filter((c) => c.kind === 'added').length,
      removed: filtered.filter((c) => c.kind === 'removed').length,
      modified: filtered.filter((c) => c.kind === 'modified').length,
    },
    warnings,
  }
}

function indexFragments(
  fragments: KnowledgeFragment[],
  skipUnverifiable: boolean,
  side: string,
): { map: Map<string, KnowledgeFragment>; warnings: string[] } {
  const map = new Map<string, KnowledgeFragment>()
  const warnings: string[] = []
  let dropped = 0
  for (const fragment of fragments) {
    if (skipUnverifiable && !fragment.provenance.verifiable) {
      dropped += 1
      continue
    }
    if (map.has(fragment.id)) {
      warnings.push(`${side}: duplicate fragment id ${fragment.id} — keeping last`)
    }
    map.set(fragment.id, fragment)
  }
  if (dropped > 0) {
    warnings.push(`${side}: dropped ${dropped} unverifiable fragment(s) before diff`)
  }
  return { map, warnings }
}

function dedup<T>(items: T[]): T[] {
  return [...new Set(items)]
}
