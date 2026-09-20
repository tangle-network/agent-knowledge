import { describe, expect, it } from 'vitest'
import {
  formatKnowledgeCitationReference,
  parseKnowledgeCitationReference,
  resolveKnowledgeCitation,
} from './citation-resolution'
import { buildKnowledgeBrief } from './knowledge-brief'
import type { PageOrigin } from './run-scoped'
import type { KnowledgePage } from './types'

const page = (id: string, text: string): KnowledgePage => ({
  id,
  text,
  title: text,
  path: `${id}.md`,
  outLinks: [],
  tags: [],
  sourceIds: [],
  frontmatter: { id },
})

describe('citation serialization is injective, including legacy delimiter collisions', () => {
  it('round trips every supported origin/page pair without banning existing names', () => {
    const origins: (PageOrigin | undefined)[] = [
      undefined,
      'here',
      'shared',
      'inherited:a',
      'inherited:a::b',
      'inherited:a:',
      'inherited:a%3A%3Ab',
      'inherited:∑:研究',
      'inherited:%/::x',
    ]
    const ids = [
      'c',
      'b::c',
      'here::literal',
      'shared::',
      'knowledge-ref:v1:literal',
      '%3A%3A',
      'quantum-∑',
      'a::b::c',
    ]
    const handles = new Set<string>()
    for (const origin of origins) {
      for (const pageId of ids) {
        const reference = { pageId, ...(origin === undefined ? {} : { origin }) }
        const handle = formatKnowledgeCitationReference(reference)
        expect(parseKnowledgeCitationReference(handle)).toEqual(reference)
        expect(handles.has(handle)).toBe(false)
        handles.add(handle)
      }
    }
  })

  it('leaves normal handles and legacy literal percent sequences unchanged', () => {
    expect(formatKnowledgeCitationReference({ origin: 'inherited:a', pageId: 'c' })).toBe(
      'inherited:a::c',
    )
    expect(parseKnowledgeCitationReference('inherited:a%3A%3Ab::c')).toEqual({
      origin: 'inherited:a%3A%3Ab',
      pageId: 'c',
    })
    expect(formatKnowledgeCitationReference({ pageId: 'plain' })).toBe('plain')
  })

  it('keeps the two former colliding origins distinct through search and resolution', () => {
    const first = page('c', 'Quantum first')
    const second = page('b::c', 'Quantum second')
    const visible = [
      { page: first, origin: 'inherited:a::b' as const },
      { page: second, origin: 'inherited:a' as const },
      { page: page('c', 'Banana local'), origin: 'here' as const },
    ]
    const result = buildKnowledgeBrief(visible, 'quantum')
    expect(result.results).toHaveLength(2)
    expect(new Set(result.citationIds).size).toBe(2)
    for (const [index, hit] of result.results.entries()) {
      const resolved = resolveKnowledgeCitation(
        visible,
        parseKnowledgeCitationReference(result.citationIds[index]!),
      )
      expect(resolved.resolved?.page).toBe(hit.page)
      expect(resolved.resolved?.origin).toBe(hit.origin)
    }
  })

  it('retrieves literal reserved-prefix page names through the same formatter', () => {
    const literal = page('knowledge-ref:v1:literal', 'Quantum reserved name')
    const visible = [{ page: literal, origin: 'here' as const }]
    const brief = buildKnowledgeBrief(visible, 'quantum')
    expect(brief.results).toHaveLength(1)
    expect(
      resolveKnowledgeCitation(visible, parseKnowledgeCitationReference(brief.citationIds[0]!))
        .resolved?.page,
    ).toBe(literal)
  })

  it('rejects malformed encoded references instead of silently changing their identity', () => {
    for (const value of ['%', '%5B%5D', '%5Bnull%5D', '%5Btrue%2C%22p%22%5D']) {
      expect(() => parseKnowledgeCitationReference(`knowledge-ref:v1:${value}`)).toThrow(
        /invalid encoded knowledge citation/,
      )
    }
  })
})
