import { parseKnowledgeCitationReference } from './citation-resolution'
import {
  assertGradeableEvidence,
  CHECKABLE_RUNG_THRESHOLD,
  type ClaimEvidence,
  type EvidenceRung,
  UncheckableClaimError,
} from './claim-evidence'
import { KnowledgePageInvalidationSchema } from './schemas'
import { isScaffoldPath } from './store'
import type { KnowledgeIndex, KnowledgeLintFinding, KnowledgePage } from './types'
import { normalizeLinkTarget } from './wikilinks'

const ABSOLUTE_PATH_TOKEN = /(?:^|[\s"'=(])(?:\/(?!dev\/null\b)[^\s"'();]+|[A-Za-z]:\\[^\s"'();]+)/m

export function lintKnowledgeIndex(index: KnowledgeIndex): KnowledgeLintFinding[] {
  const findings: KnowledgeLintFinding[] = []
  const byTarget = new Set<string>()
  const titles = new Map<string, string[]>()
  const sourceIds = new Set(index.sources.map((source) => source.id))
  const anchorIds = new Map(
    index.sources.map((source) => [
      source.id,
      new Set((source.anchors ?? []).map((anchor) => anchor.id)),
    ]),
  )
  const pageIds = new Map<string, string[]>()
  const invalidatedIds = new Set<string>()
  const sourceHashes = new Map<string, string[]>()
  for (const page of index.pages) {
    pageIds.set(page.id, [...(pageIds.get(page.id) ?? []), page.path])
    if (page.invalidation !== undefined) invalidatedIds.add(page.id)
    byTarget.add(normalizeLinkTarget(page.id))
    byTarget.add(normalizeLinkTarget(page.title))
    byTarget.add(normalizeLinkTarget(page.path.split('/').pop()!.replace(/\.md$/, '')))
    const titleKey = page.title.toLowerCase()
    titles.set(titleKey, [...(titles.get(titleKey) ?? []), page.path])
  }
  for (const source of index.sources) {
    sourceHashes.set(source.contentHash, [
      ...(sourceHashes.get(source.contentHash) ?? []),
      source.id,
    ])
  }

  const inbound = new Map<string, number>()
  for (const page of index.pages) inbound.set(page.id, 0)
  for (const page of index.pages) {
    if (page.outLinks.length === 0 && !isScaffoldPath(page.path)) {
      findings.push({
        type: 'no-outlinks',
        severity: 'info',
        page: page.path,
        message: 'Page has no wikilinks to other knowledge pages.',
      })
    }
    for (const link of page.outLinks) {
      if (!byTarget.has(normalizeLinkTarget(link))) {
        findings.push({
          type: 'broken-link',
          severity: 'warning',
          page: page.path,
          message: `Broken wikilink [[${link}]].`,
        })
      }
    }
  }

  for (const edge of index.graph.edges)
    inbound.set(edge.target, (inbound.get(edge.target) ?? 0) + 1)
  for (const page of index.pages) {
    if (!isScaffoldPath(page.path) && (inbound.get(page.id) ?? 0) === 0) {
      findings.push({
        type: 'orphan',
        severity: 'info',
        page: page.path,
        message: 'No other page links to this page.',
      })
    }
    if (/\bclaim\b/i.test(page.text) && page.sourceIds.length === 0) {
      findings.push({
        type: 'uncited-claim',
        severity: 'warning',
        page: page.path,
        message: 'Page appears to contain claims but has no sources frontmatter.',
      })
    }
    for (const sourceId of page.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        findings.push({
          type: 'missing-source',
          severity: 'error',
          page: page.path,
          message: `Page cites unknown source "${sourceId}".`,
          metadata: { sourceId },
        })
      }
    }
    for (const ref of extractSourceRefs(page.text)) {
      if (!sourceIds.has(ref.sourceId)) {
        findings.push({
          type: 'missing-source',
          severity: 'error',
          page: page.path,
          message: `Page cites unknown source "${ref.sourceId}".`,
          metadata: ref,
        })
      } else if (ref.anchorId && !anchorIds.get(ref.sourceId)?.has(ref.anchorId)) {
        findings.push({
          type: 'missing-source',
          severity: 'error',
          page: page.path,
          message: `Page cites unknown source anchor "${ref.sourceId}#${ref.anchorId}".`,
          metadata: ref,
        })
      }
    }
    findings.push(...lintPageEvidence(page))
    findings.push(...lintPageContradictions(page, pageIds))
    findings.push(...lintPageInvalidation(page))
    findings.push(...lintPageInvalidatedCitations(page, pageIds, invalidatedIds))
  }

  for (const [title, paths] of titles) {
    if (title && paths.length > 1) {
      findings.push({
        type: 'duplicate-title',
        severity: 'warning',
        message: `Duplicate title "${title}" in ${paths.join(', ')}.`,
        metadata: { paths },
      })
    }
  }
  for (const [id, paths] of pageIds) {
    if (id && paths.length > 1) {
      findings.push({
        type: 'duplicate-page-id',
        severity: 'error',
        message: `Duplicate page id "${id}" in ${paths.join(', ')}.`,
        metadata: { paths },
      })
    }
  }
  for (const [hash, ids] of sourceHashes) {
    if (hash && ids.length > 1) {
      findings.push({
        type: 'duplicate-source-hash',
        severity: 'warning',
        message: `Duplicate source content hash across ${ids.join(', ')}.`,
        metadata: { sourceIds: ids },
      })
    }
  }
  return findings
}

function lintPageEvidence(page: KnowledgePage): KnowledgeLintFinding[] {
  if (page.frontmatter.rung === undefined) return []
  const rung = evidenceRung(page.frontmatter.rung)
  if (rung === undefined) {
    return [
      {
        type: 'ungradeable-evidence',
        severity: 'error',
        page: page.path,
        message: 'Evidence rung must be an integer from 1 through 5.',
        metadata: { rung: page.frontmatter.rung },
      },
    ]
  }
  const check = stringValue(page.frontmatter.check)
  const expect = stringValue(page.frontmatter.expect)
  const evidencePath = stringValue(page.frontmatter.evidencePath)
  const evidence: ClaimEvidence = {
    rung,
    ...(check ? { check } : {}),
    ...(expect ? { expect } : {}),
    ...(evidencePath ? { evidencePath } : {}),
  }
  const findings: KnowledgeLintFinding[] = []
  try {
    assertGradeableEvidence(evidence)
  } catch (error) {
    if (!(error instanceof UncheckableClaimError)) throw error
    findings.push({
      type: 'ungradeable-evidence',
      severity: 'error',
      page: page.path,
      message: error.note,
      metadata: { rung: error.rung },
    })
  }
  if (rung >= CHECKABLE_RUNG_THRESHOLD && !evidence.evidencePath) {
    findings.push({
      type: 'missing-evidence-path',
      severity: 'warning',
      page: page.path,
      message: `Rung ${rung} evidence has no evidencePath for a human to inspect.`,
      metadata: { rung },
    })
  }
  for (const [field, value] of [
    ['check', evidence.check],
    ['evidencePath', evidence.evidencePath],
  ] as const) {
    if (value && ABSOLUTE_PATH_TOKEN.test(value)) {
      findings.push({
        type: 'nonportable-evidence',
        severity: 'warning',
        page: page.path,
        message: `${field} contains an absolute path and may not re-run outside the author machine.`,
        metadata: { rung, field },
      })
    }
  }
  return findings
}

function lintPageContradictions(
  page: KnowledgePage,
  pageIds: ReadonlyMap<string, string[]>,
): KnowledgeLintFinding[] {
  const findings: KnowledgeLintFinding[] = []
  for (const targetId of page.contradicts ?? []) {
    const selfReference = targetId === page.id
    if (selfReference || !pageIds.has(targetId)) {
      findings.push({
        type: 'broken-contradiction',
        severity: 'error',
        page: page.path,
        message: selfReference
          ? `Page "${page.id}" cannot contradict itself.`
          : `Page contradicts unknown page id "${targetId}".`,
        metadata: { targetId },
      })
    }
  }
  return findings
}

/**
 * A citation into a page its own evidence refuted.
 *
 * The verdict lives on the cited page, so a reader arriving through the
 * citation never meets it. Ambiguous ids are left to the citation audit, which
 * owns that verdict.
 */
function lintPageInvalidatedCitations(
  page: KnowledgePage,
  pageIds: ReadonlyMap<string, string[]>,
  invalidatedIds: ReadonlySet<string>,
): KnowledgeLintFinding[] {
  const targetIds = [
    ...new Set(
      (page.cites ?? []).map((persisted) => parseKnowledgeCitationReference(persisted).pageId),
    ),
  ]
    .filter(
      (targetId) =>
        targetId !== page.id && pageIds.get(targetId)?.length === 1 && invalidatedIds.has(targetId),
    )
    .sort()
  if (targetIds.length === 0) return []
  return [
    {
      type: 'cites-invalidated',
      severity: 'warning',
      page: page.path,
      message: `Page cites invalidated ${targetIds.length === 1 ? 'page' : 'pages'} ${targetIds.join(', ')}.`,
      metadata: { targetIds },
    },
  ]
}

function lintPageInvalidation(page: KnowledgePage): KnowledgeLintFinding[] {
  if (page.frontmatter.invalidation === undefined) return []
  const parsed = KnowledgePageInvalidationSchema.safeParse(page.frontmatter.invalidation)
  if (parsed.success) return []
  return [
    {
      type: 'invalid-invalidation',
      severity: 'error',
      page: page.path,
      message:
        'Page invalidation must record verdict=contradicted, an ISO observedAt timestamp, and a non-empty reason.',
      metadata: { issues: parsed.error.issues },
    },
  ]
}

function evidenceRung(value: unknown): EvidenceRung | undefined {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return parsed === 1 || parsed === 2 || parsed === 3 || parsed === 4 || parsed === 5
    ? parsed
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function extractSourceRefs(text: string): Array<{ sourceId: string; anchorId?: string }> {
  const refs: Array<{ sourceId: string; anchorId?: string }> = []
  const regex = /\[\^([A-Za-z0-9_-]+)(?:#([A-Za-z0-9_.:-]+))?\]/g
  let match: RegExpExecArray | null
  match = regex.exec(text)
  while (match !== null) {
    refs.push({ sourceId: match[1]!, anchorId: match[2] })
    match = regex.exec(text)
  }
  return refs
}
