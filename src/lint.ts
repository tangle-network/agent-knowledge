import type { KnowledgeIndex, KnowledgeLintFinding } from './types'
import { normalizeLinkTarget } from './wikilinks'

export function lintKnowledgeIndex(index: KnowledgeIndex): KnowledgeLintFinding[] {
  const findings: KnowledgeLintFinding[] = []
  const byTarget = new Set<string>()
  const titles = new Map<string, string[]>()
  const sourceIds = new Set(index.sources.map((source) => source.id))
  const anchorIds = new Map(index.sources.map((source) => [source.id, new Set((source.anchors ?? []).map((anchor) => anchor.id))]))
  for (const page of index.pages) {
    byTarget.add(normalizeLinkTarget(page.id))
    byTarget.add(normalizeLinkTarget(page.title))
    byTarget.add(normalizeLinkTarget(page.path.split('/').pop()!.replace(/\.md$/, '')))
    const titleKey = page.title.toLowerCase()
    titles.set(titleKey, [...(titles.get(titleKey) ?? []), page.path])
  }

  const inbound = new Map<string, number>()
  for (const page of index.pages) inbound.set(page.id, 0)
  for (const page of index.pages) {
    if (page.outLinks.length === 0 && !isStructural(page.path)) {
      findings.push({ type: 'no-outlinks', severity: 'info', page: page.path, message: 'Page has no wikilinks to other knowledge pages.' })
    }
    for (const link of page.outLinks) {
      if (!byTarget.has(normalizeLinkTarget(link))) {
        findings.push({ type: 'broken-link', severity: 'warning', page: page.path, message: `Broken wikilink [[${link}]].` })
      }
    }
  }

  for (const edge of index.graph.edges) inbound.set(edge.target, (inbound.get(edge.target) ?? 0) + 1)
  for (const page of index.pages) {
    if (!isStructural(page.path) && (inbound.get(page.id) ?? 0) === 0) {
      findings.push({ type: 'orphan', severity: 'info', page: page.path, message: 'No other page links to this page.' })
    }
    if (/\bclaim\b/i.test(page.text) && page.sourceIds.length === 0) {
      findings.push({ type: 'uncited-claim', severity: 'warning', page: page.path, message: 'Page appears to contain claims but has no sources frontmatter.' })
    }
    for (const sourceId of page.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        findings.push({ type: 'missing-source', severity: 'error', page: page.path, message: `Page cites unknown source "${sourceId}".`, metadata: { sourceId } })
      }
    }
    for (const ref of extractSourceRefs(page.text)) {
      if (!sourceIds.has(ref.sourceId)) {
        findings.push({ type: 'missing-source', severity: 'error', page: page.path, message: `Page cites unknown source "${ref.sourceId}".`, metadata: ref })
      } else if (ref.anchorId && !(anchorIds.get(ref.sourceId)?.has(ref.anchorId))) {
        findings.push({ type: 'missing-source', severity: 'error', page: page.path, message: `Page cites unknown source anchor "${ref.sourceId}#${ref.anchorId}".`, metadata: ref })
      }
    }
  }

  for (const [title, paths] of titles) {
    if (title && paths.length > 1) {
      findings.push({ type: 'duplicate-title', severity: 'warning', message: `Duplicate title "${title}" in ${paths.join(', ')}.`, metadata: { paths } })
    }
  }
  return findings
}

function isStructural(path: string): boolean {
  return path.endsWith('/index.md') || path.endsWith('/log.md') || path === 'knowledge/index.md' || path === 'knowledge/log.md'
}

function extractSourceRefs(text: string): Array<{ sourceId: string; anchorId?: string }> {
  const refs: Array<{ sourceId: string; anchorId?: string }> = []
  const regex = /\[\^([A-Za-z0-9_-]+)(?:#([A-Za-z0-9_.:-]+))?\]/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    refs.push({ sourceId: match[1]!, anchorId: match[2] })
  }
  return refs
}
