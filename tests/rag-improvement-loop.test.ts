import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  inMemoryCampaignStorage,
  type OptimizationMethod,
} from '@tangle-network/agent-eval/campaign'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type RagAnswerEvalArtifact,
  type RagAnswerEvalScenario,
  type RetrievalEvalScenario,
  runRagKnowledgeImprovementLoop,
} from '../src/index'
import { fixedOptimizationMethod } from './support/optimization'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots.length = 0
})

describe('RAG knowledge improvement loop', () => {
  it('runs a complete method over retrieval and answer configuration without exposing final data', async () => {
    const methodInputs: string[][] = []
    const method: OptimizationMethod<RagAnswerEvalScenario, RagAnswerEvalArtifact> = {
      name: 'fixture-rag-method',
      async optimize(input) {
        methodInputs.push([
          ...input.trainScenarios.map((scenario) => scenario.id),
          ...input.selectionScenarios.map((scenario) => scenario.id),
        ])
        expect('testScenarios' in input).toBe(false)
        return {
          winnerSurface: '{"answerMode":"grounded","k":2}',
          cost: { totalCostUsd: 0, accountingComplete: true, incompleteReasons: [] },
        }
      },
    }
    const scenario = (id: string): RagAnswerEvalScenario => ({
      id,
      kind: 'rag-answer-eval',
      query: `${id} refund window`,
      expectedClaims: [`${id} refunds are allowed within 30 days`],
      requiredContext: [{ id: `${id}-policy` }],
      requireCitations: true,
    })

    const result = await runRagKnowledgeImprovementLoop({
      goal: 'Optimize retrieval and grounded answers together',
      enabledPhases: ['rag-optimization', 'gap-diagnosis'],
      requiredPhases: ['rag-optimization'],
      optimization: {
        baseline: { answerMode: 'unsupported', k: 1 },
        method,
        trainScenarios: [scenario('rag-train')],
        selectionScenarios: [scenario('rag-selection')],
        finalScenarios: [scenario('rag-final-a'), scenario('rag-final-b')],
        async run({ config, scenario: item }) {
          const claim = `${item.id} refunds are allowed within 30 days`
          if (config.answerMode !== 'grounded') {
            return {
              query: item.query,
              answer: `${item.id} refunds are never allowed`,
              contexts: [],
            }
          }
          return {
            query: item.query,
            answer: claim,
            contexts: [{ id: `${item.id}-policy`, text: claim, rank: 1 }],
            claims: [{ id: `${item.id}-claim`, text: claim, citationIds: [`${item.id}-cite`] }],
            citations: [
              {
                id: `${item.id}-cite`,
                claimId: `${item.id}-claim`,
                contextId: `${item.id}-policy`,
                quote: claim,
              },
            ],
          }
        },
        runDir: 'memory://full-rag-optimization-test',
        storage: inMemoryCampaignStorage(),
        expectUsage: 'off',
        resamples: 200,
      },
      diagnose({ optimization }) {
        expect(optimization?.winnerConfig).toEqual({ answerMode: 'grounded', k: 2 })
        expect(optimization).not.toHaveProperty('comparison')
        expect(optimization).not.toHaveProperty('finalScenarios')
        return []
      },
    })

    expect(methodInputs).toEqual([['rag-train', 'rag-selection']])
    expect(result.optimization?.winner.surface).toBe('{"answerMode":"grounded","k":2}')
    expect(result.optimization?.comparison.testScenarioIds).toEqual(['rag-final-a', 'rag-final-b'])
    expect(result.optimization?.comparison.best.lift).toBeGreaterThan(0)
    expect(result.phases.map((phase) => `${phase.phase}:${phase.status}`)).toEqual([
      'rag-optimization:completed',
      'gap-diagnosis:completed',
    ])
  })

  it('exposes retrieval, diagnosis, acquisition, update, answer eval, and promotion phases', async () => {
    const calls: string[] = []
    const trainScenario: RetrievalEvalScenario = {
      id: 'q-train',
      kind: 'retrieval-eval',
      query: 'needs second result',
      expected: { kind: 'page', pageId: 'gold' },
    }
    const makeScenario = (id: string): RetrievalEvalScenario => ({
      id,
      kind: 'retrieval-eval',
      query: `${id} needs second result`,
      expected: { kind: 'page', pageId: 'gold' },
    })

    const result = await runRagKnowledgeImprovementLoop({
      goal: 'Improve support RAG',
      retrieval: {
        baseline: { k: 1 },
        trainScenarios: [trainScenario],
        selectionScenarios: [
          makeScenario('q-selection-a'),
          makeScenario('q-selection-b'),
          makeScenario('q-selection-c'),
        ],
        finalScenarios: [makeScenario('q-final-a'), makeScenario('q-final-b')],
        method: fixedOptimizationMethod<RetrievalEvalScenario, unknown>('{"k":2}'),
        retrieve: async ({ k }) => ({
          hits: [
            { pageId: 'distractor', path: 'knowledge/distractor.md', rank: 1 },
            ...(k >= 2 ? [{ pageId: 'gold', path: 'knowledge/gold.md', rank: 2 }] : []),
          ],
        }),
        runDir: 'memory://rag-lifecycle-retrieval-test',
        storage: inMemoryCampaignStorage(),
        expectUsage: 'off',
        resamples: 200,
      },
      diagnose({ retrieval }) {
        calls.push('diagnose')
        expect(retrieval?.winnerConfig).toMatchObject({ k: 2 })
        expect(retrieval).not.toHaveProperty('comparison')
        expect(retrieval).not.toHaveProperty('finalScenarios')
        return [
          {
            id: 'missing-refund-policy',
            kind: 'missing-source',
            severity: 'error',
            message: 'Refund policy source is missing.',
          },
        ]
      },
      acquireKnowledge({ findings, retrieval, phases }) {
        calls.push('acquire')
        expect(findings).toHaveLength(1)
        expect(retrieval).not.toHaveProperty('comparison')
        expect(phases.some((phase) => phase.summary.includes('final_lift'))).toBe(false)
        return {
          sourceTexts: [
            {
              uri: 'research://refund-policy',
              title: 'Refund Policy',
              text: 'Refunds are available within 30 days.',
            },
          ],
          proposalText: 'proposed KB update',
          done: true,
        }
      },
      updateKnowledge({ acquisition, retrieval }) {
        calls.push('update')
        expect(acquisition?.sourceTexts).toHaveLength(1)
        expect(retrieval).not.toHaveProperty('comparison')
        return { applied: true, summary: 'external vector DB updated' }
      },
      evaluateAnswers({ knowledgeUpdate, retrieval }) {
        calls.push('answer')
        expect(knowledgeUpdate?.applied).toBe(true)
        expect(retrieval).not.toHaveProperty('comparison')
        return { passed: true, metrics: { faithfulness: 1, answer_relevance: 0.95 } }
      },
      promote({ answerQuality, retrieval }) {
        calls.push('promote')
        expect(answerQuality?.passed).toBe(true)
        expect(retrieval).not.toHaveProperty('comparison')
        return { promoted: true, reason: 'retrieval and answer checks passed' }
      },
    })

    expect(calls).toEqual(['diagnose', 'acquire', 'update', 'answer', 'promote'])
    expect(result.retrieval?.winnerConfig).toMatchObject({ k: 2 })
    expect(result.findings).toHaveLength(1)
    expect(result.knowledgeUpdate?.applied).toBe(true)
    expect(result.answerQuality?.passed).toBe(true)
    expect(result.promotion?.promoted).toBe(true)
    expect(result.phases.map((phase) => `${phase.phase}:${phase.status}`)).toEqual([
      'retrieval-tuning:completed',
      'gap-diagnosis:completed',
      'knowledge-acquisition:completed',
      'knowledge-update:completed',
      'answer-quality:completed',
      'promotion:completed',
    ])
  })

  it('does not run full RAG optimization when the phase is disabled', async () => {
    let methodCalled = false
    const method: OptimizationMethod<RagAnswerEvalScenario, RagAnswerEvalArtifact> = {
      name: 'disabled-rag-method',
      async optimize(input) {
        methodCalled = true
        return {
          winnerSurface: input.baselineSurface,
          cost: { totalCostUsd: 0, accountingComplete: true, incompleteReasons: [] },
        }
      },
    }
    const scenario = (id: string): RagAnswerEvalScenario => ({
      id,
      kind: 'rag-answer-eval',
      query: id,
    })

    const result = await runRagKnowledgeImprovementLoop({
      goal: 'Run diagnosis only',
      enabledPhases: ['gap-diagnosis'],
      optimization: {
        baseline: { k: 1 },
        method,
        trainScenarios: [scenario('disabled-train')],
        selectionScenarios: [scenario('disabled-selection')],
        finalScenarios: [scenario('disabled-final-a'), scenario('disabled-final-b')],
        run: async ({ scenario: item }) => ({
          query: item.query,
          answer: 'unused',
          contexts: [],
        }),
        runDir: 'memory://disabled-rag-optimization-test',
        storage: inMemoryCampaignStorage(),
        expectUsage: 'off',
      },
      diagnose: () => [],
    })

    expect(methodCalled).toBe(false)
    expect(result.optimization).toBeUndefined()
    expect(result.phases.map((phase) => phase.phase)).toEqual(['gap-diagnosis'])
  })

  it('can apply acquired source text and write blocks through the existing research loop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-knowledge-rag-loop-'))
    tempRoots.push(root)

    const result = await runRagKnowledgeImprovementLoop({
      goal: 'Fill refund-policy knowledge',
      enabledPhases: ['knowledge-acquisition', 'knowledge-update'],
      requiredPhases: ['knowledge-update'],
      acquireKnowledge: () => ({
        sourceTexts: [
          {
            uri: 'research://refund-policy',
            title: 'Refund Policy Source',
            text: 'Customers can request refunds within 30 days.',
          },
        ],
        proposalText: [
          '---FILE: knowledge/support/refund-policy.md---',
          '---',
          'id: refund-policy',
          'title: Refund Policy',
          '---',
          '# Refund Policy',
          'Customers can request refunds within 30 days.',
          '---END FILE---',
        ].join('\n'),
        done: true,
      }),
      knowledgeResearch: {
        root,
        sourceOptions: { now: () => new Date('2026-01-01T00:00:00.000Z') },
      },
    })

    expect(result.knowledgeUpdate?.applied).toBe(true)
    expect(result.knowledgeUpdate?.research?.iterations).toBe(1)
    expect(result.knowledgeUpdate?.research?.index.pages.map((page) => page.path)).toContain(
      'knowledge/support/refund-policy.md',
    )
    expect(result.knowledgeUpdate?.research?.index.sources).toHaveLength(1)
  })

  it('fails loudly when a required phase has no implementation hook', async () => {
    await expect(
      runRagKnowledgeImprovementLoop({
        goal: 'Do not fake answer eval',
        requiredPhases: ['answer-quality'],
      }),
    ).rejects.toThrow(/answer-quality requires an evaluateAnswers hook/)
  })
})
