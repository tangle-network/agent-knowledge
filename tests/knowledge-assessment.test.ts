import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as indexer from '../src/indexer'
import * as lint from '../src/lint'
import { scoreKnowledgeBaseIndex } from '../src/rag-eval'
import { evaluateKnowledgeBaseReadiness } from '../src/readiness-check'
import { assessKnowledgeIndex } from '../src/readiness-helpers'
import { runKnowledgeResearchLoop } from '../src/research-loop'
import { KnowledgeIndexSchema } from '../src/schemas'
import { initKnowledgeBase } from '../src/store'
import type { KnowledgeIndex } from '../src/types'
import { validateKnowledgeIndex } from '../src/validate'

const roots: string[] = []
const now = new Date('2026-10-14T00:00:00.000Z')

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root() {
  const path = await mkdtemp(join(tmpdir(), 'knowledge-assessment-'))
  roots.push(path)
  await initKnowledgeBase(path)
  return path
}

function index(): KnowledgeIndex {
  return {
    root: '/unused-assessment-fixture',
    generatedAt: now.toISOString(),
    sources: [],
    pages: [
      {
        id: 'policy',
        path: 'knowledge/policy.md',
        title: 'Policy',
        text: 'A claim with a missing citation [^missing].',
        frontmatter: {},
        sourceIds: [],
        tags: [],
        outLinks: ['absent'],
      },
    ],
    graph: { nodes: [], edges: [] },
  }
}

describe('one knowledge assessment per observation', () => {
  it.each([
    [undefined, undefined],
    [false, false],
    [true, true],
    [true, false],
    [false, true],
  ])(
    'preserves independent validation and quality strictness: %s / %s',
    (strict, qualityStrict) => {
      const view = index()
      // Include a schema error, not just lint and strict-frontmatter findings.
      view.generatedAt = 'invalid-date'
      const qualityOptions = { strict: qualityStrict, now }
      const expectedValidation = validateKnowledgeIndex(view, { strict })
      const expectedQuality = scoreKnowledgeBaseIndex(view, qualityOptions)
      const lintCalls = vi.spyOn(lint, 'lintKnowledgeIndex')
      const schemaCalls = vi.spyOn(KnowledgeIndexSchema, 'safeParse')
      const actual = assessKnowledgeIndex(
        { goal: 'policy', strict, kbQuality: qualityOptions },
        view,
      )
      expect(actual.validation).toEqual(expectedValidation)
      expect(actual.kbQuality).toEqual(expectedQuality)
      expect(actual.readiness).toBeUndefined()
      expect(lintCalls).toHaveBeenCalledTimes(1)
      expect(schemaCalls).toHaveBeenCalledTimes(1)
    },
  )

  it('scores the public quality report with one lint/schema pass', () => {
    const lintCalls = vi.spyOn(lint, 'lintKnowledgeIndex')
    const schemaCalls = vi.spyOn(KnowledgeIndexSchema, 'safeParse')
    const report = scoreKnowledgeBaseIndex(index(), { strict: true, now })
    expect(report.metrics.lint_error_count).toBe(2)
    expect(report.metrics.lint_warning_count).toBe(2)
    expect(lintCalls).toHaveBeenCalledTimes(1)
    expect(schemaCalls).toHaveBeenCalledTimes(1)
  })

  it('routes public readiness through one assessment and re-observes a later call', async () => {
    const path = await root()
    await writeFile(join(path, 'knowledge', 'policy.md'), '# Policy\nA policy claim.\n')
    const lintCalls = vi.spyOn(lint, 'lintKnowledgeIndex')
    const schemaCalls = vi.spyOn(KnowledgeIndexSchema, 'safeParse')
    const options = { root: path, goal: 'policy', strict: true, kbQuality: { strict: false, now } }
    const first = await evaluateKnowledgeBaseReadiness(options)
    expect(first.validation.ok).toBe(false)
    expect(first.kbQuality.ok).toBe(true)
    expect(lintCalls).toHaveBeenCalledTimes(1)
    expect(schemaCalls).toHaveBeenCalledTimes(1)
    await writeFile(
      join(path, 'knowledge', 'policy.md'),
      '---\nid: policy\ntitle: Policy\n---\n# Policy\n',
    )
    const second = await evaluateKnowledgeBaseReadiness(options)
    expect(second.ready).toBe(true)
    expect(second.index).not.toBe(first.index)
    expect(lintCalls).toHaveBeenCalledTimes(2)
    expect(schemaCalls).toHaveBeenCalledTimes(2)
  })

  it('returns the exact post-decision index that produced the step assessment', async () => {
    const path = await root()
    const built: KnowledgeIndex[] = []
    const build = indexer.buildKnowledgeIndex
    const buildCalls = vi
      .spyOn(indexer, 'buildKnowledgeIndex')
      .mockImplementation(async (...args) => {
        const view = await build(...args)
        built.push(view)
        return view
      })
    const lintCalls = vi.spyOn(lint, 'lintKnowledgeIndex')
    const result = await runKnowledgeResearchLoop({
      root: path,
      goal: 'policy',
      step: () => ({ done: true }),
    })
    expect(buildCalls).toHaveBeenCalledTimes(2)
    expect(lintCalls).toHaveBeenCalledTimes(2)
    expect(result.index).toBe(built[1])
    expect(result.validation).toBe(result.steps[0]!.validation)
    expect(result.lintFindings).toBe(result.steps[0]!.lintFindings)
    expect(Object.hasOwn(result.steps[0]!, 'index')).toBe(false)
    expect(Object.hasOwn(result.steps[0]!, 'readiness')).toBe(false)
  })

  it('keeps public lint findings detached from validation findings', async () => {
    const path = await root()
    await writeFile(join(path, 'knowledge', 'one.md'), '# Duplicate\n')
    await writeFile(join(path, 'knowledge', 'two.md'), '# Duplicate\n')
    const result = await runKnowledgeResearchLoop({
      root: path,
      goal: 'policy',
      step: () => ({ done: true }),
    })
    const finding = result.lintFindings.find((item) => item.type === 'duplicate-title')!
    const validationFinding = result.validation.findings.find(
      (item) => item.type === 'duplicate-title',
    )!
    expect(finding).toEqual(validationFinding)
    finding.message = 'caller changed the lint explanation'
    ;(finding.metadata!.paths as string[]).push('caller-added.md')
    expect(validationFinding.message).not.toBe(finding.message)
    expect(validationFinding.metadata!.paths).not.toContain('caller-added.md')
  })

  it('passes the same assessed snapshot into the next research decision', async () => {
    const path = await root()
    const build = indexer.buildKnowledgeIndex
    const built: KnowledgeIndex[] = []
    vi.spyOn(indexer, 'buildKnowledgeIndex').mockImplementation(async (...args) => {
      const view = await build(...args)
      built.push(view)
      return view
    })
    const result = await runKnowledgeResearchLoop({
      root: path,
      goal: 'policy',
      maxIterations: 2,
      step: ({ iteration, index: view, validation, lintFindings, previousSteps }) => {
        if (iteration === 1)
          return { sourceTexts: [{ uri: 'memory://policy', text: 'Policy evidence.' }] }
        expect(view).toBe(built[1])
        expect(view.sources).toHaveLength(1)
        expect(validation).toBe(previousSteps[0]!.validation)
        expect(lintFindings).toBe(previousSteps[0]!.lintFindings)
        return { done: true }
      },
    })
    expect(built).toHaveLength(3)
    expect(result.index).toBe(built[2])
    expect(result.done).toBe(true)
  })
})
