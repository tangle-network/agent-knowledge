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
import { fixedOptimizationMethod, testExecutionRef } from './support/optimization'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots.length = 0
})

describe('RAG knowledge improvement loop', () => {
  it('runs a complete method over retrieval and answer configuration without exposing final data', async () => {
    const methodInputs: string[][] = []
    let finalDispatchStarted = false
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
        executionRef: testExecutionRef('rag-complete-method'),
        baseline: { answerMode: 'unsupported', k: 1 },
        method,
        trainScenarios: [scenario('rag-train')],
        selectionScenarios: [scenario('rag-selection')],
        finalScenarios: [scenario('rag-final-a'), scenario('rag-final-b')],
        async run({ config, scenario: item }) {
          if (item.id.startsWith('rag-final-')) finalDispatchStarted = true
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
        expect(optimization).toBeUndefined()
        expect(finalDispatchStarted).toBe(false)
        return []
      },
    })

    expect(methodInputs).toEqual([['rag-train', 'rag-selection']])
    expect(result.optimization?.winner.surface).toBe('{"answerMode":"grounded","k":2}')
    expect(result.optimization?.comparison.testScenarioIds).toEqual(['rag-final-a', 'rag-final-b'])
    expect(result.optimization?.comparison.best.lift).toBeGreaterThan(0)
    expect(result.phases.map((phase) => `${phase.phase}:${phase.status}`)).toEqual([
      'gap-diagnosis:completed',
      'rag-optimization:completed',
    ])
  })

  it('exposes retrieval, diagnosis, acquisition, update, answer eval, and promotion phases', async () => {
    const calls: string[] = []
    let finalRetrievalCalls = 0
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
        executionRef: testExecutionRef('rag-retrieval-lifecycle'),
        baseline: { k: 1 },
        trainScenarios: [trainScenario],
        selectionScenarios: [
          makeScenario('q-selection-a'),
          makeScenario('q-selection-b'),
          makeScenario('q-selection-c'),
        ],
        finalScenarios: [makeScenario('q-final-a'), makeScenario('q-final-b')],
        method: fixedOptimizationMethod<RetrievalEvalScenario, unknown>('{"k":2}'),
        retrieve: async ({ k, scenario }) => {
          if (scenario.id.startsWith('q-final-')) finalRetrievalCalls += 1
          return {
            hits: [
              { pageId: 'distractor', path: 'knowledge/distractor.md', rank: 1 },
              ...(k >= 2 ? [{ pageId: 'gold', path: 'knowledge/gold.md', rank: 2 }] : []),
            ],
          }
        },
        runDir: 'memory://rag-lifecycle-retrieval-test',
        storage: inMemoryCampaignStorage(),
        expectUsage: 'off',
        resamples: 200,
      },
      diagnose({ retrieval }) {
        calls.push('diagnose')
        expect(retrieval).toBeUndefined()
        expect(finalRetrievalCalls).toBe(0)
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
        expect(retrieval).toBeUndefined()
        expect(finalRetrievalCalls).toBe(0)
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
        expect(retrieval).toBeUndefined()
        expect(finalRetrievalCalls).toBe(0)
        return { applied: true, summary: 'external vector DB updated' }
      },
      evaluateAnswers({ knowledgeUpdate, retrieval }) {
        calls.push('answer')
        expect(knowledgeUpdate?.applied).toBe(true)
        expect(retrieval).not.toHaveProperty('comparison')
        expect(finalRetrievalCalls).toBeGreaterThan(0)
        return {
          passed: true,
          metrics: { faithfulness: 1, answer_relevance: 0.95 },
          finalScenarioIds: ['answer-final-a', 'answer-final-b'],
          datasetRef: testExecutionRef('answer-final-dataset'),
          evaluatorRef: testExecutionRef('answer-final-evaluator'),
          cost: { totalCostUsd: 0, accountingComplete: true, incompleteReasons: [] },
        }
      },
      answerQualityCostCeiling: 0,
      decidePromotion({ answerQuality, retrieval, retrievalComparison }) {
        calls.push('promote')
        expect(answerQuality?.passed).toBe(true)
        expect(retrieval).not.toHaveProperty('comparison')
        expect(retrievalComparison?.best.liftCi.low).toBeGreaterThanOrEqual(0)
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
      'gap-diagnosis:completed',
      'knowledge-acquisition:completed',
      'knowledge-update:completed',
      'retrieval-tuning:completed',
      'answer-quality:completed',
      'promotion:completed',
    ])
  })

  it('rejects weak answer-only evidence before a promotion decision can run', async () => {
    let promotionCalls = 0
    await expect(
      runRagKnowledgeImprovementLoop({
        goal: 'Reject self-attested answer evidence',
        enabledPhases: ['answer-quality', 'promotion'],
        evaluateAnswers: () =>
          ({
            passed: true,
            metrics: {},
            finalScenarioIds: ['final-a', 'final-b'],
            datasetRef: testExecutionRef('weak-answer-dataset'),
            evaluatorRef: testExecutionRef('weak-answer-evaluator'),
            cost: { totalCostUsd: 0, accountingComplete: true, incompleteReasons: [] },
          }) as never,
        answerQualityCostCeiling: 0,
        decidePromotion() {
          promotionCalls += 1
          return { promoted: true, reason: 'must not run' }
        },
      }),
    ).rejects.toThrow('answer-quality evidence requires non-empty finite metrics')
    expect(promotionCalls).toBe(0)
  })

  it('holds answer-only promotion when observed cost is incomplete', async () => {
    let promotionCalls = 0
    const result = await runRagKnowledgeImprovementLoop({
      goal: 'Require observed answer-evaluation cost',
      enabledPhases: ['answer-quality', 'promotion'],
      evaluateAnswers: () => ({
        passed: true,
        metrics: { faithfulness: 1 },
        finalScenarioIds: ['final-a', 'final-b'],
        datasetRef: testExecutionRef('incomplete-answer-dataset'),
        evaluatorRef: testExecutionRef('incomplete-answer-evaluator'),
        cost: {
          totalCostUsd: 0,
          accountingComplete: false,
          incompleteReasons: ['provider receipt unavailable'],
        },
      }),
      answerQualityCostCeiling: 1,
      decidePromotion() {
        promotionCalls += 1
        return { promoted: true, reason: 'must not run' }
      },
    })

    expect(result.promotion).toMatchObject({
      promoted: false,
      reason: expect.stringContaining('incomplete cost accounting'),
    })
    expect(promotionCalls).toBe(0)
  })

  it('refuses promotion when the selected retrieval candidate regresses on final cases', async () => {
    let decisionCalls = 0
    const scenario = (id: string): RetrievalEvalScenario => ({
      id,
      kind: 'retrieval-eval',
      query: id,
      expected: [{ kind: 'page', pageId: 'gold' }],
    })
    const result = await runRagKnowledgeImprovementLoop({
      goal: 'Reject a final regression',
      enabledPhases: ['retrieval-tuning', 'promotion'],
      retrieval: {
        executionRef: testExecutionRef('rag-final-regression'),
        baseline: { k: 1 },
        trainScenarios: [scenario('train')],
        selectionScenarios: [scenario('selection')],
        finalScenarios: [scenario('final-a'), scenario('final-b')],
        method: fixedOptimizationMethod<RetrievalEvalScenario, unknown>('{"k":2}'),
        retrieve: async ({ k }) => ({
          hits:
            k === 1
              ? [{ pageId: 'gold', path: 'knowledge/gold.md', rank: 1 }]
              : [{ pageId: 'distractor', path: 'knowledge/distractor.md', rank: 1 }],
        }),
        runDir: 'memory://rag-final-regression-test',
        storage: inMemoryCampaignStorage(),
        expectUsage: 'off',
        resamples: 200,
      },
      decidePromotion() {
        decisionCalls += 1
        return { promoted: true, reason: 'caller requested promotion' }
      },
    })

    expect(result.retrieval?.comparison.best).toMatchObject({
      baselineComposite: 1,
      winnerComposite: 0,
      lift: -1,
    })
    expect(result.promotion).toMatchObject({
      promoted: false,
      reason: expect.stringContaining('does not rule out a regression'),
    })
    expect(decisionCalls).toBe(0)
  })

  it('does not call the promotion decision without final evidence', async () => {
    let decisionCalls = 0
    const result = await runRagKnowledgeImprovementLoop({
      goal: 'Reject an unevaluated update',
      enabledPhases: ['promotion'],
      decidePromotion() {
        decisionCalls += 1
        return { promoted: true, reason: 'caller requested promotion' }
      },
    })

    expect(decisionCalls).toBe(0)
    expect(result.promotion).toEqual({
      promoted: false,
      reason: 'promotion requires final RAG, retrieval, or answer-quality evidence',
    })
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
        executionRef: testExecutionRef('rag-disabled-method'),
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
