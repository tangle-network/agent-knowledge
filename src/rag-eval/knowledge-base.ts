import { lintKnowledgeIndex } from '../lint'
import type { RagGapFinding } from '../rag-improvement-loop'
import type { KnowledgeIndex } from '../types'
import { validateKnowledgeIndex } from '../validate'
import type { KnowledgeBaseQualityOptions, KnowledgeBaseQualityReport } from './contracts'

export function scoreKnowledgeBaseIndex(
  index: KnowledgeIndex,
  options: KnowledgeBaseQualityOptions = {},
): KnowledgeBaseQualityReport {
  const validation = validateKnowledgeIndex(index, { strict: options.strict })
  const lintFindings = lintKnowledgeIndex(index)
  const now = options.now ?? new Date()
  const staleSourceCount = index.sources.filter((source) => {
    return source.validUntil ? Date.parse(source.validUntil) < now.getTime() : false
  }).length
  const sourceHashCounts = new Map<string, number>()
  for (const source of index.sources) {
    sourceHashCounts.set(source.contentHash, (sourceHashCounts.get(source.contentHash) ?? 0) + 1)
  }
  const duplicateSourceHashCount = [...sourceHashCounts.values()].filter(
    (count) => count > 1,
  ).length
  const pagesWithInlineCitations = index.pages.filter(
    (page) => sourceRefs(page.text).length > 0,
  ).length
  const pagesWithSources = index.pages.filter((page) => page.sourceIds.length > 0).length
  const metrics = {
    page_count: index.pages.length,
    source_count: index.sources.length,
    citation_rate: index.pages.length === 0 ? 1 : pagesWithInlineCitations / index.pages.length,
    source_backed_page_rate: index.pages.length === 0 ? 1 : pagesWithSources / index.pages.length,
    stale_source_rate: index.sources.length === 0 ? 0 : staleSourceCount / index.sources.length,
    duplicate_source_hash_rate:
      index.sources.length === 0 ? 0 : duplicateSourceHashCount / index.sources.length,
    lint_error_count: validation.findings.filter((finding) => finding.severity === 'error').length,
    lint_warning_count: lintFindings.filter((finding) => finding.severity === 'warning').length,
  }
  const findings: RagGapFinding[] = []
  if (metrics.lint_error_count > 0) {
    findings.push({
      id: 'kb:lint-errors',
      kind: 'unknown',
      severity: 'critical',
      message: `${metrics.lint_error_count} validation error(s) in the knowledge index.`,
      evidence: { lint_error_count: metrics.lint_error_count },
    })
  }
  if (metrics.citation_rate < (options.minCitationRate ?? 0)) {
    findings.push({
      id: 'kb:citation-rate',
      kind: 'missing-source',
      severity: 'error',
      message: 'Inline citation coverage is below the configured minimum.',
      evidence: { citation_rate: metrics.citation_rate },
    })
  }
  if (metrics.stale_source_rate > (options.maxStaleSourceRate ?? 1)) {
    findings.push({
      id: 'kb:stale-source-rate',
      kind: 'stale-source',
      severity: 'error',
      message: 'Stale source rate exceeds the configured maximum.',
      evidence: { stale_source_rate: metrics.stale_source_rate },
    })
  }
  return { ok: findings.length === 0, metrics, findings }
}

function sourceRefs(text: string): string[] {
  const refs: string[] = []
  const regex = /\[\^([A-Za-z0-9_-]+)(?:#([A-Za-z0-9_.:-]+))?\]/g
  let match = regex.exec(text)
  while (match !== null) {
    refs.push(match[0])
    match = regex.exec(text)
  }
  return refs
}
