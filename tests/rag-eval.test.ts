import { describe, expect, it } from 'vitest'
import {
  calibrateRagAnswerJudge,
  createRagAnswerQualityHook,
  type KnowledgeIndex,
  normalizeExternalRagScores,
  type RagAnswerEvalArtifact,
  type RagAnswerEvalScenario,
  ragAnswerQualityJudge,
  scoreKnowledgeBaseIndex,
  scoreRagAnswerArtifact,
  toDeepEvalTestCases,
  toRagasEvaluationRows,
  toRagCheckerRecords,
  toTruLensRecords,
} from '../src/index'

const scenario: RagAnswerEvalScenario = {
  id: 'refund-window',
  kind: 'rag-answer-eval',
  query: 'How long do customers have to request a refund?',
  referenceAnswer: 'Customers can request refunds within 30 days.',
  expectedClaims: ['Customers can request refunds within 30 days.'],
  requiredContext: [{ id: 'ctx-refund' }],
  requireCitations: true,
}

const secondScenario: RagAnswerEvalScenario = {
  ...scenario,
  id: 'refund-window-paraphrase',
  query: 'What is the refund request deadline?',
}

const strongArtifact: RagAnswerEvalArtifact = {
  query: scenario.query,
  answer: 'Customers can request refunds within 30 days.',
  contexts: [
    {
      id: 'ctx-refund',
      text: 'Customers can request refunds within 30 days.',
      rank: 1,
      sourceId: 'src-refund',
    },
  ],
  claims: [{ id: 'claim-refund', text: 'Customers can request refunds within 30 days.' }],
  citations: [{ id: 'cite-refund', claimId: 'claim-refund', contextId: 'ctx-refund' }],
}

const weakArtifact: RagAnswerEvalArtifact = {
  query: scenario.query,
  answer: 'Customers can request refunds within 90 days.',
  contexts: [{ id: 'ctx-shipping', text: 'Shipping labels expire after 7 days.', rank: 1 }],
  claims: [{ id: 'claim-refund', text: 'Customers can request refunds within 90 days.' }],
  citations: [{ id: 'cite-refund', claimId: 'claim-refund', contextId: 'ctx-shipping' }],
}

describe('RAG answer evaluation', () => {
  it('scores context, support, citations, answer relevance, and abstention', () => {
    const strong = scoreRagAnswerArtifact(strongArtifact, scenario)
    expect(strong.passed).toBe(true)
    expect(strong.metrics.context_recall).toBe(1)
    expect(strong.metrics.faithfulness).toBe(1)
    expect(strong.metrics.citation_support).toBe(1)
    expect(strong.metrics.answer_correctness).toBe(1)

    const weak = scoreRagAnswerArtifact(weakArtifact, scenario)
    expect(weak.passed).toBe(false)
    expect(weak.metrics.context_recall).toBe(0)
    expect(weak.metrics.faithfulness).toBe(0)
    expect(weak.metrics.citation_support).toBe(0)
    expect(weak.findings.map((finding) => finding.kind)).toContain('retrieval-miss')
    expect(weak.findings.map((finding) => finding.kind)).toContain('citation-mismatch')
  })

  it('calibrates the metric on deliberately strong and weak examples', async () => {
    const calibration = await calibrateRagAnswerJudge({
      scenario,
      strong: strongArtifact,
      weak: weakArtifact,
    })

    expect(calibration.passed).toBe(true)
    expect(calibration.strongScore).toBeGreaterThanOrEqual(0.7)
    expect(calibration.weakScore).toBeLessThanOrEqual(0.3)
    expect(calibration.gap).toBeGreaterThan(0.5)
  })

  it('normalizes external Ragas, DeepEval, TruLens, and RAGChecker scores', () => {
    const scores = normalizeExternalRagScores([
      { provider: 'ragas', scores: { faithfulness: 0.91, answer_relevancy: 0.82 } },
      { provider: 'deepeval', scores: { contextual_relevancy: 0.77 } },
      { provider: 'trulens', scores: { groundedness: 0.88, context_relevance: 0.74 } },
      { provider: 'ragchecker', scores: { claim_precision: 0.81, claim_recall: 0.73 } },
    ])

    expect(scores.ragas?.faithfulness).toBe(0.91)
    expect(scores.ragas?.answer_relevance).toBe(0.82)
    expect(scores.deepeval?.context_relevance).toBe(0.77)
    expect(scores.trulens?.groundedness).toBe(0.88)
    expect(scores.ragchecker?.faithfulness).toBe(0.81)
    expect(scores.ragchecker?.context_recall).toBe(0.73)
  })

  it('exports rows that external open-source RAG evaluators can consume', () => {
    const cases = [{ scenario, artifact: strongArtifact }]

    expect(toRagasEvaluationRows(cases)[0]).toMatchObject({
      user_input: scenario.query,
      response: strongArtifact.answer,
      retrieved_contexts: ['Customers can request refunds within 30 days.'],
      reference: scenario.referenceAnswer,
    })
    expect(toDeepEvalTestCases(cases)[0]).toMatchObject({
      input: scenario.query,
      actual_output: strongArtifact.answer,
      expected_output: scenario.referenceAnswer,
    })
    expect(toTruLensRecords(cases)[0]).toMatchObject({
      input: scenario.query,
      output: strongArtifact.answer,
    })
    expect(toRagCheckerRecords(cases)[0]).toMatchObject({
      query_id: scenario.id,
      query: scenario.query,
      response: strongArtifact.answer,
      claims: ['Customers can request refunds within 30 days.'],
    })
  })

  it('builds a lifecycle answer-quality hook over real answer cases', async () => {
    const hook = createRagAnswerQualityHook({
      scenarios: [scenario, secondScenario],
      evaluatorRef: `sha256:${'a'.repeat(64)}`,
      cost: { totalCostUsd: 0, accountingComplete: true, incompleteReasons: [] },
      run: (item) => ({ ...strongArtifact, query: item.query }),
      externalEvaluator: () => ({
        provider: 'trulens',
        scores: { groundedness: 1, answer_relevance: 1, context_relevance: 1 },
      }),
    })

    const result = await hook()
    expect(result.passed).toBe(true)
    expect(result.metrics.composite).toBe(1)
    expect(result.finalScenarioIds).toEqual(['refund-window', 'refund-window-paraphrase'])
    expect(result.datasetRef).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(result.metadata?.scenarioCount).toBe(2)
  })

  it('returns an agent-eval judge for direct campaign wiring', async () => {
    const judge = ragAnswerQualityJudge()
    const result = await judge.score({
      artifact: strongArtifact,
      scenario,
      signal: new AbortController().signal,
    })
    expect(result.composite).toBe(1)
    expect(result.dimensions.faithfulness).toBe(1)
  })

  it('scores unanswerable cases by abstention instead of answer length', () => {
    const unanswerable: RagAnswerEvalScenario = {
      id: 'private-refund-exception',
      kind: 'rag-answer-eval',
      query: 'What private exception did support grant this customer?',
      unanswerable: true,
      slices: ['unanswerable'],
    }

    const abstained = scoreRagAnswerArtifact(
      {
        query: unanswerable.query,
        answer: 'I do not know from the available context.',
        contexts: [],
        abstained: true,
      },
      unanswerable,
    )
    expect(abstained.metrics.abstention).toBe(1)
    expect(abstained.passed).toBe(true)

    const guessed = scoreRagAnswerArtifact(
      {
        query: unanswerable.query,
        answer: 'Support granted a private exception for this customer.',
        contexts: [],
        abstained: false,
      },
      unanswerable,
    )
    expect(guessed.metrics.abstention).toBe(0)
    expect(guessed.passed).toBe(false)
    expect(guessed.findings.map((finding) => finding.kind)).toContain('incorrect-abstention')
  })
})

describe('knowledge base quality scoring', () => {
  it('scores generic KB health without assuming a wiki domain', () => {
    const index: KnowledgeIndex = {
      root: 'memory://kb-quality',
      generatedAt: '2026-01-01T00:00:00.000Z',
      sources: [
        {
          id: 'src-refund',
          uri: 'memory://refund',
          contentHash: 'hash-refund-123456',
          text: 'Customers can request refunds within 30 days.',
          validUntil: '2026-12-31T00:00:00.000Z',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      pages: [
        {
          id: 'refund-policy',
          path: 'knowledge/refund-policy.md',
          title: 'Refund Policy',
          text: 'Customers can request refunds within 30 days.[^src-refund]',
          frontmatter: { id: 'refund-policy', title: 'Refund Policy' },
          sourceIds: ['src-refund'],
          tags: [],
          outLinks: [],
        },
      ],
      graph: { nodes: [], edges: [] },
    }

    const report = scoreKnowledgeBaseIndex(index, {
      strict: true,
      minCitationRate: 1,
      maxStaleSourceRate: 0,
      now: new Date('2026-06-01T00:00:00.000Z'),
    })

    expect(report.ok).toBe(true)
    expect(report.metrics.page_count).toBe(1)
    expect(report.metrics.source_count).toBe(1)
    expect(report.metrics.citation_rate).toBe(1)
    expect(report.metrics.stale_source_rate).toBe(0)
  })

  it('fails closed on stale or uncited KB content when policy asks for it', () => {
    const index: KnowledgeIndex = {
      root: 'memory://kb-quality',
      generatedAt: '2026-01-01T00:00:00.000Z',
      sources: [
        {
          id: 'src-old',
          uri: 'memory://old',
          contentHash: 'hash-old-123456789',
          text: 'Old refund policy.',
          validUntil: '2025-01-01T00:00:00.000Z',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ],
      pages: [
        {
          id: 'refund-policy',
          path: 'knowledge/refund-policy.md',
          title: 'Refund Policy',
          text: 'Customers can request refunds within 30 days.',
          frontmatter: { id: 'refund-policy', title: 'Refund Policy' },
          sourceIds: ['src-old'],
          tags: [],
          outLinks: [],
        },
      ],
      graph: { nodes: [], edges: [] },
    }

    const report = scoreKnowledgeBaseIndex(index, {
      minCitationRate: 1,
      maxStaleSourceRate: 0,
      now: new Date('2026-01-01T00:00:00.000Z'),
    })

    expect(report.ok).toBe(false)
    expect(report.findings.map((finding) => finding.kind)).toContain('missing-source')
    expect(report.findings.map((finding) => finding.kind)).toContain('stale-source')
  })
})
