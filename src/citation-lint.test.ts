import { describe, expect, it } from 'vitest'
import { auditKnowledgeCitations } from './citation-resolution'
import { knowledgeCitationAuditFindings } from './citation-lint'
import type { OriginatedPage, PageOrigin } from './run-scoped'
import type { KnowledgePage } from './types'

function page(id: string, origin: PageOrigin, path: string, cites?: string[]): OriginatedPage {
  const value: KnowledgePage = {
    id,
    path,
    title: id,
    text: id,
    frontmatter: { id },
    sourceIds: [],
    tags: [],
    outLinks: [],
    ...(cites ? { cites } : {}),
  }
  return { page: value, origin }
}

describe('knowledgeCitationAuditFindings', () => {
  it('produces blocking missing, ambiguous, and self-citation findings', () => {
    const visible = [
      page('author', 'here', 'knowledge/author.md', ['missing', 'reused', 'author']),
      page('reused', 'inherited:parent', 'knowledge/parent.md'),
      page('reused', 'shared', 'knowledge/shared.md'),
    ]

    const findings = knowledgeCitationAuditFindings(
      auditKnowledgeCitations(visible, { sourceOrigins: ['here'] }),
    )

    expect(findings.map((finding) => [finding.type, finding.severity])).toEqual([
      ['broken-citation', 'error'],
      ['ambiguous-citation', 'error'],
      ['broken-citation', 'error'],
    ])
    expect(findings[1]?.message).toMatch(/qualify it as here::/)
    expect(findings[1]?.metadata).toMatchObject({
      sourcePageId: 'author',
      candidates: [
        { origin: 'inherited:parent', path: 'knowledge/parent.md' },
        { origin: 'shared', path: 'knowledge/shared.md' },
      ],
    })
  })
})
