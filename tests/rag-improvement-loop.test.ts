import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inMemoryCampaignStorage } from '@tangle-network/agent-eval/campaign'
import { afterEach, describe, expect, it } from 'vitest'
import { type RetrievalEvalScenario, runRagKnowledgeImprovementLoop } from '../src/index'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots.length = 0
})

describe('RAG knowledge improvement loop', () => {
  it('exposes retrieval, diagnosis, acquisition, update, answer eval, and promotion phases', async () => {
    const calls: string[] = []
    const trainScenario: RetrievalEvalScenario = {
      id: 'q-train',
      kind: 'retrieval-eval',
      query: 'needs second result',
      expected: { kind: 'page', pageId: 'gold' },
    }
    const holdoutScenario: RetrievalEvalScenario = {
      id: 'q-holdout',
      kind: 'retrieval-eval',
      query: 'held out needs second result',
      expected: { kind: 'page', pageId: 'gold' },
    }

    const result = await runRagKnowledgeImprovementLoop({
      goal: 'Improve support RAG',
      retrieval: {
        baseline: { k: 1 },
        scenarios: [trainScenario],
        holdoutScenarios: [holdoutScenario],
        searchSpace: { k: [1, 2] },
        retrieve: async ({ k }) => ({
          hits: [
            { pageId: 'distractor', path: 'knowledge/distractor.md', rank: 1 },
            ...(k >= 2 ? [{ pageId: 'gold', path: 'knowledge/gold.md', rank: 2 }] : []),
          ],
        }),
        targetRecall: 1,
        deltaThreshold: 0.01,
        populationSize: 1,
        maxGenerations: 1,
        runDir: 'memory://rag-lifecycle-retrieval-test',
        storage: inMemoryCampaignStorage(),
        expectUsage: 'off',
      },
      diagnose({ retrieval }) {
        calls.push('diagnose')
        expect(retrieval?.winnerConfig).toMatchObject({ k: 2 })
        return [
          {
            id: 'missing-refund-policy',
            kind: 'missing-source',
            severity: 'error',
            message: 'Refund policy source is missing.',
          },
        ]
      },
      acquireKnowledge({ findings }) {
        calls.push('acquire')
        expect(findings).toHaveLength(1)
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
      updateKnowledge({ acquisition }) {
        calls.push('update')
        expect(acquisition?.sourceTexts).toHaveLength(1)
        return { applied: true, summary: 'external vector DB updated' }
      },
      evaluateAnswers({ knowledgeUpdate }) {
        calls.push('answer')
        expect(knowledgeUpdate?.applied).toBe(true)
        return { passed: true, metrics: { faithfulness: 1, answer_relevance: 0.95 } }
      },
      promote({ answerQuality }) {
        calls.push('promote')
        expect(answerQuality?.passed).toBe(true)
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
