import type { AnalystFinding } from '@tangle-network/agent-eval'
import { describe, expect, it } from 'vitest'
import {
  KnowledgeProposalParseError,
  proposeFromFinding,
  proposeFromFindings,
} from './propose-from-finding'

function f(subject: string | undefined, partial: Partial<AnalystFinding> = {}): AnalystFinding {
  return {
    schema_version: '1.0.0',
    finding_id: 'f_test',
    analyst_id: 'knowledge-gap',
    produced_at: '2026-05-19T00:00:00Z',
    severity: 'high',
    area: 'knowledge-gap',
    claim: 'wiki page missing',
    confidence: 0.85,
    evidence_refs: [{ kind: 'span', uri: 'span://t/s', excerpt: 'quote' }],
    rationale: 'agent asked clarifying question',
    recommended_action: 'Create wiki page with claim: invoice rows have two shapes',
    subject,
    ...partial,
  }
}

describe('proposeFromFinding', () => {
  it('returns null for non-knowledge subjects', () => {
    expect(proposeFromFinding(f('websearch:outdated:invoices'))).toBeNull()
    expect(proposeFromFinding(f('tool-doc:queryTraces'))).toBeNull()
    expect(proposeFromFinding(f('system-prompt:request-classification'))).toBeNull()
    expect(proposeFromFinding(f('memory:prior-decision-on-vendor'))).toBeNull()
  })

  it('returns null when subject is missing', () => {
    expect(proposeFromFinding(f(undefined))).toBeNull()
  })

  it('emits a create-page proposal for agent-knowledge:wiki:<slug>', () => {
    const p = proposeFromFinding(f('agent-knowledge:wiki:invoice-line-items'))
    expect(p).not.toBeNull()
    expect(p?.kind).toBe('create-page')
    expect(p?.locus).toBe('invoice-line-items')
    expect(p?.writeBlocks).toHaveLength(1)
    expect(p?.writeBlocks[0]?.path).toBe('knowledge/invoice-line-items.md')
    expect(p?.writeBlocks[0]?.content).toMatch(/^---\ntitle: Invoice Line Items/)
    expect(p?.writeBlocks[0]?.content).toContain('## Rationale')
    expect(p?.writeBlocks[0]?.content).toContain('## Recommended action')
    expect(p?.metadata.severity).toBe('high')
    expect(p?.sourceFindingId).toBe('f_test')
  })

  it('emits an append-section proposal for wiki:<slug>#<heading>', () => {
    const p = proposeFromFinding(f('agent-knowledge:wiki:invoice-line-items#Two-shapes'))
    expect(p?.kind).toBe('append-section')
    expect(p?.locus).toBe('invoice-line-items')
    expect(p?.writeBlocks[0]?.path).toBe('knowledge/invoice-line-items.md')
    expect(p?.writeBlocks[0]?.content).toMatch(/^## Two-shapes/)
    expect(p?.writeBlocks[0]?.content).toContain('### Rationale')
  })

  it('emits a draft claim for agent-knowledge:claim:<topic>', () => {
    const p = proposeFromFinding(f('agent-knowledge:claim:invoice-shape-A'))
    expect(p?.kind).toBe('create-claim')
    expect(p?.writeBlocks).toHaveLength(0)
    expect(p?.claim).toBeDefined()
    expect(p?.claim?.status).toBe('draft')
    expect(p?.claim?.text).toBe('Create wiki page with claim: invoice rows have two shapes')
    expect(p?.claim?.refs).toEqual([
      { sourceId: 'analyst-finding:f_test', anchorId: 'span://t/s', quote: 'quote' },
    ])
    expect(p?.claim?.metadata?.topic).toBe('invoice-shape-A')
  })

  it('emits a lift-raw proposal for agent-knowledge:raw:<source-id>', () => {
    const p = proposeFromFinding(f('agent-knowledge:raw:vendor-2026-Q1-pdf'))
    expect(p?.kind).toBe('lift-raw')
    expect(p?.writeBlocks[0]?.path).toBe('knowledge/vendor-2026-q1-pdf.md')
    expect(p?.writeBlocks[0]?.content).toContain('source: vendor-2026-Q1-pdf')
    expect(p?.writeBlocks[0]?.content).toContain('## Why this page exists')
  })

  it('emits a mark-stale proposal for agent-knowledge:stale:<slug>', () => {
    const p = proposeFromFinding(
      f('agent-knowledge:stale:legacy-invoice-schema', {
        analyst_id: 'knowledge-poisoning',
        severity: 'critical',
        confidence: 0.95,
      }),
    )
    expect(p?.kind).toBe('mark-stale')
    expect(p?.writeBlocks[0]?.path).toBe('knowledge/legacy-invoice-schema.stale.md')
    expect(p?.writeBlocks[0]?.content).toContain('status: superseded')
    expect(p?.writeBlocks[0]?.content).toContain('superseded_by_finding: f_test')
    expect(p?.metadata.severity).toBe('critical')
  })

  it('throws on malformed knowledge subject (missing locus)', () => {
    expect(() => proposeFromFinding(f('agent-knowledge:wiki:'))).toThrow(
      KnowledgeProposalParseError,
    )
  })

  it('throws on unknown knowledge kind', () => {
    expect(() => proposeFromFinding(f('agent-knowledge:embedding:x'))).toThrow(
      KnowledgeProposalParseError,
    )
  })

  it('proposal id is stable per finding so cross-run diffs hold', () => {
    const p1 = proposeFromFinding(f('agent-knowledge:wiki:x'))
    const p2 = proposeFromFinding(f('agent-knowledge:wiki:x'))
    expect(p1?.id).toBe(p2?.id)
  })

  it('sanitises slugs with unsafe characters', () => {
    const p = proposeFromFinding(f('agent-knowledge:wiki:Invoice/Line Items'))
    expect(p?.writeBlocks[0]?.path).toBe('knowledge/invoice-line-items.md')
  })
})

describe('proposeFromFindings (batch)', () => {
  it('partitions findings into proposals / skipped / errors', () => {
    const out = proposeFromFindings([
      f('agent-knowledge:wiki:foo'),
      f('websearch:outdated:bar'), // skipped
      f('agent-knowledge:wiki:', { finding_id: 'f_bad' }), // error
      f('agent-knowledge:claim:baz'),
    ])
    expect(out.proposals.map((p) => p.kind)).toEqual(['create-page', 'create-claim'])
    expect(out.skipped).toBe(1)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0]?.findingId).toBe('f_bad')
  })
})
