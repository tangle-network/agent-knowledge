import { describe, expect, it } from 'vitest'
import {
  assertKnowledgeCitationAudit,
  assertKnowledgeCitationsResolved,
  auditKnowledgeCitations,
  formatKnowledgeCitationReference,
  KnowledgeCitationAuditError,
  KnowledgeCitationResolutionError,
  parseKnowledgeCitationReference,
  resolveKnowledgeCitation,
  resolveKnowledgeCitations,
} from './citation-resolution'
import type { OriginatedPage, PageOrigin } from './run-scoped'
import type { KnowledgePage } from './types'

function page(
  id: string,
  origin: PageOrigin,
  path = `${id}.md`,
  cites?: string[],
): OriginatedPage {
  const value: KnowledgePage = {
    id,
    path: `knowledge/${path}`,
    title: id,
    text: `knowledge for ${id}`,
    frontmatter: { id },
    sourceIds: [],
    tags: [],
    outLinks: [],
    ...(cites ? { cites } : {}),
  }
  return { page: value, origin }
}

describe('knowledge citation resolution', () => {
  it('resolves an unqualified id only when one visible page owns it', () => {
    const resolution = resolveKnowledgeCitation(
      [page('current', 'here'), page('parent', 'inherited:run-a'), page('prior', 'shared')],
      { pageId: 'parent' },
    )

    expect(resolution).toMatchObject({
      status: 'resolved',
      reference: { pageId: 'parent' },
      resolved: { pageId: 'parent', origin: 'inherited:run-a' },
    })
    expect(resolution.candidates).toHaveLength(1)
    expect(Object.isFrozen(resolution)).toBe(true)
  })

  it('retains a missing row instead of silently dropping it', () => {
    const resolution = resolveKnowledgeCitation([page('known', 'here')], { pageId: 'missing' })

    expect(resolution.status).toBe('missing')
    expect(resolution.candidates).toEqual([])
    expect(Object.hasOwn(resolution, 'resolved')).toBe(false)
  })

  it('reports an unqualified id as ambiguous across visible stores', () => {
    const visible = [
      page('reused', 'here', 'current.md'),
      page('reused', 'inherited:run-a', 'ancestor.md'),
      page('reused', 'shared', 'shared.md'),
    ]

    const resolution = resolveKnowledgeCitation(visible, { pageId: 'reused' })

    expect(resolution.status).toBe('ambiguous')
    expect(resolution.candidates.map((candidate) => candidate.origin)).toEqual([
      'here',
      'inherited:run-a',
      'shared',
    ])
  })

  it('uses an explicit origin to disambiguate an intentional id reuse', () => {
    const visible = [
      page('reused', 'here', 'current.md'),
      page('reused', 'inherited:run-a', 'ancestor.md'),
      page('reused', 'shared', 'shared.md'),
    ]

    const resolution = resolveKnowledgeCitation(visible, {
      pageId: 'reused',
      origin: 'inherited:run-a',
    })

    expect(resolution).toMatchObject({
      status: 'resolved',
      resolved: { pageId: 'reused', origin: 'inherited:run-a' },
    })
  })

  it('round-trips persisted origin qualifiers', () => {
    const references = [
      { pageId: 'plain' },
      { pageId: 'current', origin: 'here' as const },
      { pageId: 'prior', origin: 'shared' as const },
      { pageId: 'parent', origin: 'inherited:run-a' as const },
    ]

    expect(
      references.map((reference) =>
        parseKnowledgeCitationReference(formatKnowledgeCitationReference(reference)),
      ),
    ).toEqual(references)
    expect(parseKnowledgeCitationReference('unknown-prefix::still-one-page-id')).toEqual({
      pageId: 'unknown-prefix::still-one-page-id',
    })
  })

  it('fails a batch with exact missing and ambiguity diagnostics', () => {
    const visible = [
      page('unique', 'here'),
      page('reused', 'here', 'current.md'),
      page('reused', 'shared', 'shared.md'),
    ]
    const references = [{ pageId: 'unique' }, { pageId: 'missing' }, { pageId: 'reused' }]

    expect(resolveKnowledgeCitations(visible, references).map((row) => row.status)).toEqual([
      'resolved',
      'missing',
      'ambiguous',
    ])
    expect(() => assertKnowledgeCitationsResolved(visible, references)).toThrow(
      /missing: missing; ambiguous: reused \(2 matches\)/,
    )
    try {
      assertKnowledgeCitationsResolved(visible, references)
      throw new Error('expected citation resolution to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(KnowledgeCitationResolutionError)
      expect((error as KnowledgeCitationResolutionError).resolutions.map((row) => row.status)).toEqual(
        ['missing', 'ambiguous'],
      )
    }
  })

  it('audits persisted citations without silently shadowing duplicate ids', () => {
    const visible = [
      page('current', 'here', 'current.md', [
        'unique',
        'missing',
        'reused',
        'shared::reused',
        'current',
      ]),
      page('unique', 'inherited:run-a'),
      page('reused', 'inherited:run-a', 'ancestor.md'),
      page('reused', 'shared', 'shared.md'),
    ]

    const report = auditKnowledgeCitations(visible, { sourceOrigins: ['here'] })

    expect(report.checkedPages).toBe(1)
    expect(report.checkedCitations).toBe(5)
    expect(report.issues.map((issue) => [issue.persistedCitation, issue.kind])).toEqual([
      ['missing', 'missing'],
      ['reused', 'ambiguous'],
      ['current', 'self'],
    ])
    expect(report.ok).toBe(false)
    expect(() => assertKnowledgeCitationAudit(report)).toThrow(KnowledgeCitationAuditError)
  })

  it('refuses malformed references before matching', () => {
    expect(() => resolveKnowledgeCitation([], { pageId: ' ' })).toThrow(/non-empty string/)
    expect(() =>
      resolveKnowledgeCitation([], { pageId: 'known', origin: 'inherited:' as never }),
    ).toThrow(/origin is invalid/)
    expect(() => parseKnowledgeCitationReference(' ')).toThrow(/non-empty string/)
  })
})
