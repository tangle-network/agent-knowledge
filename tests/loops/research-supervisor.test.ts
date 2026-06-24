import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Capture what runResearchSupervisor hands the runtime's `supervise()` without
// needing a real supervisor brain or worker backend (the LIVE path). We assert
// the wiring: profile assembly + deliverable gate, all offline. The mock is
// created via `vi.hoisted` so it exists when the hoisted `vi.mock` factory runs.
const { superviseMock } = vi.hoisted(() => ({
  superviseMock: vi.fn(async () => ({
    output: undefined,
    settled: [],
    budgetSpent: { iterations: 0, tokens: 0, usd: 0 },
  })),
}))

vi.mock('@tangle-network/agent-runtime/loops', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tangle-network/agent-runtime/loops')>()
  return { ...actual, supervise: superviseMock }
})

import { defineReadinessSpec } from '../../src/eval-readiness'
import { applyKnowledgeWriteBlocks } from '../../src/proposals'
import {
  knowledgeReadinessDeliverable,
  RESEARCH_SUPERVISOR_SYSTEM_PROMPT,
  runResearchSupervisor,
} from '../../src/research-supervisor'
import { addSourceText } from '../../src/sources'
import { initKnowledgeBase } from '../../src/store'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'research-supervisor-'))
  superviseMock.mockClear()
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const blockingSpec = defineReadinessSpec({
  id: 'topic/ventilation',
  description: 'coop ventilation requirements',
  query: 'coop ventilation airflow',
  requiredFor: ['IntakeAgent'],
  importance: 'blocking',
  minSources: 1,
  minHits: 1,
})

describe('knowledgeReadinessDeliverable.check (offline completion oracle)', () => {
  it('reports NOT ready when the blocking gap is unfilled', async () => {
    await initKnowledgeBase(root)
    const deliverable = knowledgeReadinessDeliverable({
      root,
      goal: 'backyard chicken coop requirements',
      readinessSpecs: [blockingSpec],
    })
    expect(deliverable.describe).toContain(root)
    expect(await deliverable.check()).toBe(false)
  })

  it('reports ready once a curated page fills the blocking gap', async () => {
    await initKnowledgeBase(root)
    // The readiness gate searches curated `knowledge/*.md` PAGES (not raw
    // sources). Register the source, then write a page that cites it and repeats
    // the query terms so the token search hits it.
    const source = await addSourceText(root, {
      uri: 'web/ventilation-guide',
      title: 'Coop Ventilation Guide',
      text: 'Coop ventilation airflow keeps the flock healthy. Cross-ventilation near the roof.',
    })
    await applyKnowledgeWriteBlocks(
      root,
      [
        '---FILE: knowledge/ventilation.md---',
        '---',
        'id: topic/ventilation',
        'title: Coop Ventilation',
        `sources: ["${source.id}"]`,
        '---',
        '# Coop Ventilation',
        'Coop ventilation airflow requirements: cross-ventilation near the roof keeps the flock healthy.',
        '---END FILE---',
      ].join('\n'),
    )
    const deliverable = knowledgeReadinessDeliverable({
      root,
      goal: 'backyard chicken coop requirements',
      readinessSpecs: [blockingSpec],
    })
    expect(await deliverable.check()).toBe(true)
  })
})

describe('runResearchSupervisor (stub backend, wiring only)', () => {
  it('drives supervise() with the goal, backend, budget, and the readiness deliverable', async () => {
    const budget = { maxIterations: 4, maxTokens: 1_000, maxUsd: 1 }
    const backend = {
      backend: 'router' as const,
      routerBaseUrl: 'https://router.test',
      routerKey: 'test-key',
      model: 'test-model',
    }
    await runResearchSupervisor({
      root,
      goal: 'backyard chicken coop requirements',
      readinessSpecs: [blockingSpec],
      budget,
      backend,
    })

    expect(superviseMock).toHaveBeenCalledTimes(1)
    const [profile, task, opts] = superviseMock.mock.calls[0] as [
      { name: string; systemPrompt: string },
      string,
      { budget: unknown; backend: unknown; deliverable: { check: () => Promise<boolean> } },
    ]
    expect(profile.name).toBe('research-supervisor')
    // The supervisor instructions are the base prompt + the worker contract.
    expect(profile.systemPrompt).toContain(RESEARCH_SUPERVISOR_SYSTEM_PROMPT)
    expect(profile.systemPrompt).toContain('Each researcher worker you spawn follows this contract')
    expect(task).toBe('backyard chicken coop requirements')
    expect(opts.budget).toBe(budget)
    expect(opts.backend).toBe(backend)
    // The completion oracle is wired and runs over the real (empty) KB on disk.
    expect(await opts.deliverable.check()).toBe(false)
  })
})
