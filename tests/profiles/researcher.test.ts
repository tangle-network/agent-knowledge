import type { SandboxEvent } from '@tangle-network/sandbox'
import { describe, expect, it } from 'vitest'
import {
  createResearcherValidator,
  type KnowledgeItem,
  multiHarnessResearcherFanout,
  type ResearchOutput,
  type ResearchTask,
  researcherProfile,
} from '../../src/profiles/researcher'

function ageMs(days: number): number {
  return Date.now() - days * 24 * 60 * 60 * 1000
}

function item(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    id: overrides.id ?? 'item-1',
    namespace: overrides.namespace ?? 'cust_42',
    claim: overrides.claim ?? 'cpg-founder ICP engages with founder-pov threads',
    evidence: overrides.evidence ?? [
      {
        source: 'twitter',
        quote: 'Engagement rate 4.2x',
        url: 'https://x.com/example/status/1',
        capturedAt: ageMs(7),
      },
    ],
    confidence: overrides.confidence ?? 0.82,
    authoredBy: overrides.authoredBy ?? { kind: 'agent', id: 'researcher-glm' },
    ...overrides,
  }
}

function output(overrides: Partial<ResearchOutput> = {}): ResearchOutput {
  const items = overrides.items ?? [item()]
  return {
    items,
    citations: overrides.citations ?? [
      { url: 'https://x.com/example/status/1', quote: 'Engagement rate 4.2x', confidence: 0.82 },
    ],
    proposedWrites:
      overrides.proposedWrites ??
      items.map((i) => ({
        kind: 'insert' as const,
        namespace: i.namespace,
        item: i,
      })),
    gaps: overrides.gaps,
    notes: overrides.notes,
    raw: overrides.raw,
  }
}

const task: ResearchTask = {
  question: 'What does cpg-founder ICP engage with on Twitter?',
  knowledgeNamespace: 'cust_42',
  sources: ['twitter', 'web'],
  maxItems: 10,
  minConfidence: 0.6,
}

describe('researcherProfile()', () => {
  it('builds an AgentProfile + AgentRunSpec with role=researcher metadata', () => {
    const { profile, agentRunSpec } = researcherProfile({
      harness: 'opencode/zai-coding-plan/glm-5.1',
    })
    expect(profile.name).toBe('researcher-opencode/zai-coding-plan/glm-5.1')
    expect(profile.metadata?.role).toBe('researcher')
    expect(profile.metadata?.backendType).toBe('opencode/zai-coding-plan/glm-5.1')
    expect(profile.tools).toMatchObject({ web_search: true, fs: true })
    expect(agentRunSpec.name).toBe(profile.name)
    expect(typeof agentRunSpec.taskToPrompt).toBe('function')
  })

  it('formats the prompt with namespace + scope + recency window', () => {
    const { taskToPrompt } = researcherProfile()
    const prompt = taskToPrompt({
      question: 'q?',
      knowledgeNamespace: 'ws_1',
      scope: 'b2b SaaS',
      sources: ['web', 'twitter'],
      recencyWindow: { since: new Date('2026-01-01'), until: new Date('2026-05-01') },
      maxItems: 5,
      minConfidence: 0.7,
    })
    expect(prompt).toContain('Knowledge namespace (DO NOT cross): ws_1')
    expect(prompt).toContain('Scope: b2b SaaS')
    expect(prompt).toContain('Preferred sources: web, twitter')
    expect(prompt).toContain('Recency window: 2026-01-01T00:00:00.000Z .. 2026-05-01T00:00:00.000Z')
    expect(prompt).toContain('Max items: 5')
  })
})

describe('validator scoring', () => {
  it('passes a fully-grounded, in-namespace output', async () => {
    const validator = createResearcherValidator(task)
    const verdict = await validator.validate(output(), {
      iteration: 0,
      signal: new AbortController().signal,
    })
    expect(verdict.valid).toBe(true)
    expect(verdict.score).toBeGreaterThan(0.5)
    expect(verdict.scores?.citation_density).toBe(1)
    expect(verdict.scores?.provenance).toBe(1)
    expect(verdict.scores?.namespace).toBe(1)
  })

  it('hard-fails when items.length === 0', async () => {
    const validator = createResearcherValidator(task)
    const verdict = await validator.validate(
      output({ items: [], proposedWrites: [], citations: [] }),
      { iteration: 0, signal: new AbortController().signal },
    )
    expect(verdict.valid).toBe(false)
    expect(verdict.notes).toContain('no items')
  })

  it('hard-fails when any item lacks evidence (provenance missing)', async () => {
    const validator = createResearcherValidator(task)
    const verdict = await validator.validate(output({ items: [item({ evidence: [] })] }), {
      iteration: 0,
      signal: new AbortController().signal,
    })
    expect(verdict.valid).toBe(false)
    expect(verdict.notes).toContain('without evidence')
    expect(verdict.scores?.provenance).toBe(0)
  })

  it('hard-fails on cross-namespace item leak', async () => {
    const validator = createResearcherValidator(task)
    const verdict = await validator.validate(
      output({ items: [item({ namespace: 'cust_99' })], proposedWrites: [] }),
      { iteration: 0, signal: new AbortController().signal },
    )
    expect(verdict.valid).toBe(false)
    expect(verdict.notes).toMatch(/namespace violation/)
    expect(verdict.scores?.namespace).toBe(0)
  })

  it('hard-fails on cross-namespace proposedWrite leak (even when items are clean)', async () => {
    const validator = createResearcherValidator(task)
    const cleanItem = item({ namespace: 'cust_42' })
    const verdict = await validator.validate(
      output({
        items: [cleanItem],
        proposedWrites: [{ kind: 'insert', namespace: 'cust_99', item: cleanItem }],
      }),
      { iteration: 0, signal: new AbortController().signal },
    )
    expect(verdict.valid).toBe(false)
    expect(verdict.notes).toMatch(/namespace violation/)
  })

  it('hard-fails when citation density falls below the floor', async () => {
    const validator = createResearcherValidator(task, { citationDensityMin: 0.8 })
    const itemsArr = [
      item({ id: 'a' }),
      item({ id: 'b' }),
      item({ id: 'c' }),
      item({ id: 'd' }),
      item({ id: 'e' }),
    ]
    const verdict = await validator.validate(
      output({
        items: itemsArr,
        citations: [{ url: 'https://x.com/1', quote: 'q1', confidence: 0.8 }],
        proposedWrites: itemsArr.map((i) => ({
          kind: 'insert' as const,
          namespace: i.namespace,
          item: i,
        })),
      }),
      { iteration: 0, signal: new AbortController().signal },
    )
    expect(verdict.valid).toBe(false)
    expect(verdict.notes).toMatch(/citation density 0\.20 below floor 0\.80/)
  })

  it('rewards source diversity in the aggregate score', async () => {
    const validator = createResearcherValidator(task)
    const single = await validator.validate(
      output({
        items: [
          item({ id: 'a', evidence: [{ source: 'twitter', capturedAt: ageMs(1) }] }),
          item({ id: 'b', evidence: [{ source: 'twitter', capturedAt: ageMs(2) }] }),
        ],
        citations: [
          { url: 'https://x.com/1', quote: 'q', confidence: 0.8 },
          { url: 'https://x.com/2', quote: 'q', confidence: 0.8 },
        ],
        proposedWrites: [],
      }),
      { iteration: 0, signal: new AbortController().signal },
    )
    const diverse = await validator.validate(
      output({
        items: [
          item({ id: 'a', evidence: [{ source: 'twitter', capturedAt: ageMs(1) }] }),
          item({ id: 'b', evidence: [{ source: 'github', capturedAt: ageMs(2) }] }),
        ],
        citations: [
          { url: 'https://x.com/1', quote: 'q', confidence: 0.8 },
          { url: 'https://github.com/1', quote: 'q', confidence: 0.8 },
        ],
        proposedWrites: [],
      }),
      { iteration: 0, signal: new AbortController().signal },
    )
    expect(diverse.scores?.source_diversity ?? 0).toBeGreaterThan(
      single.scores?.source_diversity ?? 0,
    )
    expect(diverse.score).toBeGreaterThan(single.score)
  })

  it('penalises recency mismatches when a recencyWindow is supplied', async () => {
    const windowed: ResearchTask = {
      ...task,
      recencyWindow: { since: new Date(ageMs(5)) },
    }
    const validator = createResearcherValidator(windowed)
    const stale = await validator.validate(
      output({
        items: [item({ evidence: [{ source: 'twitter', capturedAt: ageMs(100) }] })],
      }),
      { iteration: 0, signal: new AbortController().signal },
    )
    const fresh = await validator.validate(
      output({
        items: [item({ evidence: [{ source: 'twitter', capturedAt: ageMs(1) }] })],
      }),
      { iteration: 0, signal: new AbortController().signal },
    )
    expect(stale.scores?.recency_match).toBe(0)
    expect(fresh.scores?.recency_match).toBe(1)
  })

  it('penalises gaps in the score, never auto-fails on gaps alone', async () => {
    const validator = createResearcherValidator(task)
    const noGaps = await validator.validate(output(), {
      iteration: 0,
      signal: new AbortController().signal,
    })
    const withGaps = await validator.validate(
      output({ gaps: ['no data on Q4 2025 engagement window'] }),
      { iteration: 0, signal: new AbortController().signal },
    )
    expect(withGaps.valid).toBe(true)
    expect(withGaps.scores?.gap_coverage ?? 0).toBeLessThan(noGaps.scores?.gap_coverage ?? 1)
  })

  it('namespaceCheck=false disables the namespace gate (for shared validators)', async () => {
    const validator = createResearcherValidator(task, { namespaceCheck: false })
    const verdict = await validator.validate(
      output({ items: [item({ namespace: 'cust_99' })], proposedWrites: [] }),
      { iteration: 0, signal: new AbortController().signal },
    )
    expect(verdict.valid).toBe(true)
    expect(verdict.scores?.namespace).toBeUndefined()
  })
})

describe('propose-without-materialize invariant', () => {
  it('emits proposedWrites but never invokes any FS / KB primitive', async () => {
    // The profile has no FS dependency by construction. We verify by
    // checking that `researcherProfile()` returns the same shape on
    // every call without touching disk — and by inspecting the static
    // imports of the module.
    const { profile, output: adapter, validator, taskToPrompt, agentRunSpec } = researcherProfile()
    expect(profile).toBeDefined()
    expect(adapter.parse([])).toEqual({ items: [], citations: [], proposedWrites: [] })
    expect(typeof validator.validate).toBe('function')
    expect(typeof taskToPrompt).toBe('function')
    expect(agentRunSpec.profile).toBe(profile)
    // The caller — not the profile — applies updates. Sanity-check that
    // the profile module does not import any FS / KB primitive that would
    // let it materialize writes itself.
    const modText = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../src/profiles/researcher.ts', import.meta.url), 'utf8'),
    )
    // Forbid imports from the materialize / FS surface.
    expect(modText).not.toMatch(/from ['"]\.\.\/proposals['"]/)
    expect(modText).not.toMatch(/from ['"]\.\.\/store['"]/)
    expect(modText).not.toMatch(/from ['"]\.\.\/kb-store['"]/)
    expect(modText).not.toMatch(/from ['"]\.\.\/sources['"]/)
    expect(modText).not.toMatch(/from ['"]node:fs(\/promises)?['"]/)
    // Forbid actually calling the materialize / write APIs anywhere
    // outside an `@example` or fenced-prose docblock. We accept the
    // identifier inside source-level prose (audit context) but never as
    // a callable identifier — a callable is `name(` with parens.
    expect(modText).not.toMatch(/applyKnowledgeWriteBlocks\s*\(/)
    expect(modText).not.toMatch(/writeFile\s*\(/)
    expect(modText).not.toMatch(/addSourcePath\s*\(/)
    expect(modText).not.toMatch(/addSourceText\s*\(/)
  })
})

describe('loose-output passthrough', () => {
  it('parses a result event with the typed shape', () => {
    const { output: adapter } = researcherProfile()
    const items = [item()]
    const events: SandboxEvent[] = [
      {
        type: 'result',
        data: {
          result: {
            items,
            citations: [{ url: 'https://x.com/1', quote: 'q', confidence: 0.8 }],
            proposedWrites: [{ kind: 'insert', namespace: 'cust_42', item: items[0] }],
            gaps: ['no Q4 data'],
            notes: 'inspected 4 sources',
          },
        },
      },
    ]
    const parsed = adapter.parse(events)
    expect(parsed.items).toHaveLength(1)
    expect(parsed.items[0]?.namespace).toBe('cust_42')
    expect(parsed.citations).toHaveLength(1)
    expect(parsed.proposedWrites).toHaveLength(1)
    expect(parsed.gaps).toEqual(['no Q4 data'])
    expect(parsed.notes).toBe('inspected 4 sources')
  })

  it('preserves agent extras under raw — never drops free-form intelligence', () => {
    const { output: adapter } = researcherProfile()
    const events: SandboxEvent[] = [
      {
        type: 'final',
        data: {
          result: {
            items: [item()],
            citations: [{ url: 'https://x.com/1', quote: 'q', confidence: 0.8 }],
            proposedWrites: [],
            customField: { agentMood: 'curious', extraInsight: 42 },
            anotherUnknown: ['a', 'b'],
          },
        },
      },
    ]
    const parsed = adapter.parse(events)
    expect(parsed.items).toHaveLength(1)
    expect(parsed.raw).toMatchObject({
      customField: { agentMood: 'curious', extraInsight: 42 },
      anotherUnknown: ['a', 'b'],
    })
  })

  it('parses a fenced JSON block from a text delta when no structured result exists', () => {
    const { output: adapter } = researcherProfile()
    const payload = {
      items: [item()],
      citations: [{ url: 'https://x.com/1', quote: 'q', confidence: 0.8 }],
      proposedWrites: [],
    }
    const events: SandboxEvent[] = [
      {
        type: 'text',
        data: { delta: `here is my answer:\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n` },
      },
    ]
    const parsed = adapter.parse(events)
    expect(parsed.items).toHaveLength(1)
    expect(parsed.citations).toHaveLength(1)
  })

  it('drops items that lack required fields rather than crashing', () => {
    const { output: adapter } = researcherProfile()
    const events: SandboxEvent[] = [
      {
        type: 'result',
        data: {
          result: {
            items: [
              {
                id: 'good',
                namespace: 'cust_42',
                claim: 'ok',
                evidence: [{ source: 'twitter', capturedAt: 0 }],
                confidence: 0.5,
                authoredBy: { kind: 'agent', id: 'r' },
              },
              { id: 'no-claim', namespace: 'cust_42' },
              null,
            ],
            citations: [],
            proposedWrites: [],
          },
        },
      },
    ]
    const parsed = adapter.parse(events)
    expect(parsed.items).toHaveLength(1)
    expect(parsed.items[0]?.id).toBe('good')
  })

  it('returns an empty result when no events match the expected shape', () => {
    const { output: adapter } = researcherProfile()
    const parsed = adapter.parse([{ type: 'noise', data: { random: 1 } }])
    expect(parsed).toEqual({ items: [], citations: [], proposedWrites: [] })
  })

  it('parses a result event whose answer is only in finalText (opencode)', () => {
    const { output: adapter } = researcherProfile()
    const payload = {
      items: [item()],
      citations: [{ url: 'https://x.com/1', quote: 'q', confidence: 0.8 }],
      proposedWrites: [],
    }
    // opencode puts the terminal answer in `finalText`, not `result`/`output`.
    const events: SandboxEvent[] = [
      { type: 'result', data: { finalText: `done:\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n` } },
    ]
    const parsed = adapter.parse(events)
    expect(parsed.items).toHaveLength(1)
    expect(parsed.citations).toHaveLength(1)
  })

  it('mines fenced JSON from finalText in the text-scan fallback', () => {
    const { output: adapter } = researcherProfile()
    const payload = { items: [item()], citations: [], proposedWrites: [] }
    const events: SandboxEvent[] = [
      { type: 'message', data: { finalText: `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`` } },
    ]
    const parsed = adapter.parse(events)
    expect(parsed.items).toHaveLength(1)
  })
})

describe('multiHarnessResearcherFanout', () => {
  it('builds N AgentRunSpecs with a single-fanout-then-stop driver', () => {
    const fan = multiHarnessResearcherFanout({
      harnesses: ['claude-code', 'codex', 'opencode/zai-coding-plan/glm-5.1'],
    })
    expect(fan.agentRuns).toHaveLength(3)
    expect(fan.agentRuns.map((spec) => spec.name)).toEqual([
      'researcher-claude-code',
      'researcher-codex',
      'researcher-opencode/zai-coding-plan/glm-5.1',
    ])
    expect(typeof fan.driver.plan).toBe('function')
    expect(typeof fan.driver.decide).toBe('function')
    expect(fan.driver.name).toBe('dynamic')
  })

  it('falls back to three default harnesses when none supplied', () => {
    const fan = multiHarnessResearcherFanout()
    expect(fan.agentRuns).toHaveLength(3)
  })
})
