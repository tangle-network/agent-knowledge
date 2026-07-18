import { describe, expect, it } from 'vitest'
import { detectChanges } from '../src/changes'
import { sha256 } from '../src/ids'
import type { KnowledgeFragment } from '../src/sources/types'

function fragment(
  id: string,
  body: string,
  opts: Partial<KnowledgeFragment & { hints: string[]; verifiable: boolean }> = {},
): KnowledgeFragment {
  return {
    id,
    title: opts.title ?? id,
    body,
    bodyHash: sha256(body),
    provenance: {
      url: opts.provenance?.url ?? `https://example.test/${id}`,
      sourceUpdatedAt: opts.provenance?.sourceUpdatedAt ?? '2026-05-14T12:00:00.000Z',
      fetchedAt: opts.provenance?.fetchedAt ?? '2026-05-14T12:00:00.000Z',
      jurisdiction: opts.provenance?.jurisdiction,
      verifiable: opts.verifiable ?? opts.provenance?.verifiable ?? true,
    },
    dimensionHints: opts.hints ?? opts.dimensionHints ?? ['citation_hygiene'],
  }
}

describe('detectChanges', () => {
  it('flags an added fragment with after-body diff', () => {
    const result = detectChanges([], [fragment('wex:non-compete', 'BODY-V1')])
    expect(result.summary).toEqual({ added: 1, removed: 0, modified: 0 })
    expect(result.changes[0]?.kind).toBe('added')
    expect(result.changes[0]?.diff?.after).toBe('BODY-V1')
    expect(result.changes[0]?.diff?.before).toBeUndefined()
  })

  it('flags a removed fragment with before-body diff', () => {
    const result = detectChanges([fragment('uscode:18/1836', 'BODY-V1')], [])
    expect(result.summary).toEqual({ added: 0, removed: 1, modified: 0 })
    expect(result.changes[0]?.kind).toBe('removed')
    expect(result.changes[0]?.diff?.before).toBe('BODY-V1')
    expect(result.changes[0]?.diff?.after).toBeUndefined()
  })

  it('flags a modification when body hash changes', () => {
    const prev = [fragment('wex:non-compete', 'BEFORE')]
    const next = [fragment('wex:non-compete', 'AFTER')]
    const result = detectChanges(prev, next)
    expect(result.summary).toEqual({ added: 0, removed: 0, modified: 1 })
    expect(result.changes[0]?.kind).toBe('modified')
    expect(result.changes[0]?.diff).toEqual({ before: 'BEFORE', after: 'AFTER' })
  })

  it('does not flag identical-hash fragments', () => {
    const result = detectChanges(
      [fragment('wex:non-compete', 'SAME')],
      [fragment('wex:non-compete', 'SAME')],
    )
    expect(result.summary).toEqual({ added: 0, removed: 0, modified: 0 })
  })

  it('unions and dedupes dimension hints across before/after', () => {
    const prev = [fragment('wex:non-compete', 'BEFORE', { hints: ['citation_hygiene'] })]
    const next = [
      fragment('wex:non-compete', 'AFTER', {
        hints: ['citation_hygiene', 'jurisdictional_accuracy'],
      }),
    ]
    const result = detectChanges(prev, next)
    expect(result.changes[0]?.affectedDimensions.sort()).toEqual([
      'citation_hygiene',
      'jurisdictional_accuracy',
    ])
  })

  it('drops unverifiable fragments before diffing (no false `removed`)', () => {
    const real = fragment('wex:non-compete', 'REAL', { hints: ['jurisdictional_accuracy'] })
    const blocked = fragment('wex:non-compete', '', { verifiable: false, hints: [] })
    const result = detectChanges([real], [blocked])
    expect(result.summary).toEqual({ added: 0, removed: 1, modified: 0 })
    expect(result.warnings.join('\n')).toMatch(/dropped 1 unverifiable/)
  })

  it('filterDimensions narrows the result set', () => {
    const next = [
      fragment('a', 'A', { hints: ['citation_hygiene'] }),
      fragment('b', 'B', { hints: ['jurisdictional_accuracy'] }),
    ]
    const result = detectChanges([], next, { filterDimensions: ['jurisdictional_accuracy'] })
    expect(result.changes).toHaveLength(1)
    expect(result.changes[0]?.fragmentId).toBe('b')
    expect(result.summary).toEqual({ added: 1, removed: 0, modified: 0 })
  })

  it('warns on duplicate fragment ids', () => {
    const result = detectChanges([], [fragment('dup', 'A'), fragment('dup', 'B')])
    expect(result.warnings.join('\n')).toMatch(/duplicate fragment id dup/)
    expect(result.changes[0]?.diff?.after).toBe('B')
  })

  it('emits `modified` change tagged for the eval-cron worked example', () => {
    // Worked example from the README/PR body: Cornell LII Wex non-compete
    // page changes after Ryan-LLC v. FTC. The KnowledgeChange the eval cron
    // consumes carries `jurisdictional_accuracy` so it knows to re-run the
    // legal-compliance campaign.
    const prev = [
      fragment('wex:non-compete', 'Federal non-compete rule effective 2024-09-04', {
        hints: ['jurisdictional_accuracy'],
      }),
    ]
    const next = [
      fragment(
        'wex:non-compete',
        'On 2024-08-20 the U.S. District Court for the Northern District of Texas set aside the FTC rule',
        { hints: ['jurisdictional_accuracy'] },
      ),
    ]
    const result = detectChanges(prev, next)
    expect(result.summary.modified).toBe(1)
    expect(result.changes[0]?.affectedDimensions).toContain('jurisdictional_accuracy')
  })
})
