import { describe, expect, it } from 'vitest'
import {
  assertKnowledgeCitationsResolved,
  KnowledgeCitationResolutionError,
  resolveKnowledgeCitation,
  resolveKnowledgeCitations,
} from './citation-resolution'
import type { OriginatedPage, PageOrigin } from './run-scoped'
import type { KnowledgePage } from './types'

function page(id: string, origin: PageOrigin, path = `${id}.md`): OriginatedPage {
  const value: KnowledgePage = {
    id,
    path: `knowledge/${path}`,
    title: id,
    text: `knowledge for ${id}`,
    frontmatter: { id },
    sourceIds: [],
    tags: [],
    outLinks: [],
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

  it('refuses malformed references before matching', () => {
    expect(() => resolveKnowledgeCitation([], { pageId: ' ' })).toThrow(/non-empty string/)
    expect(() =>
      resolveKnowledgeCitation([], { pageId: 'known', origin: 'inherited:' as never }),
    ).toThrow(/origin is invalid/)
  })
})
