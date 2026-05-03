import { describe, expect, it } from 'vitest'
import {
  knowledgeVariantFromCandidate,
  runKnowledgeBaseOptimization,
  type KnowledgeBaseCandidate,
} from '../src/index'

function candidate(id: string, quality: number): KnowledgeBaseCandidate {
  return {
    id,
    units: [{ id: `${id}-unit`, title: id, text: `quality ${quality}` }],
    metadata: { quality },
  }
}

describe('runKnowledgeBaseOptimization', () => {
  it('uses agent-eval multi-shot optimization for KB candidates', async () => {
    const baseline = knowledgeVariantFromCandidate(candidate('baseline', 0.2))
    const result = await runKnowledgeBaseOptimization({
      runId: 'knowledge-opt',
      seedVariants: [baseline],
      searchScenarioIds: ['single-shot', 'multi-shot'],
      reps: 1,
      generations: 2,
      populationSize: 2,
      runner: {
        run: ({ variant, scenarioId }) => ({
          trace: {
            scenarioId,
            transcript: `${scenarioId}:${variant.payload.id}`,
          },
        }),
      },
      scorer: {
        score: ({ variant }) => ({
          score: Number(variant.payload.metadata?.quality ?? 0),
          asi: Number(variant.payload.metadata?.quality ?? 0) > 0.8
            ? []
            : [{ message: 'knowledge was incomplete', responsibleSurface: 'knowledge-base' }],
        }),
      },
      mutateAdapter: {
        mutate: async ({ childCount, generation }) => Array.from({ length: childCount }, (_, i) =>
          knowledgeVariantFromCandidate(candidate(`candidate-${generation}-${i}`, 0.9), { generation }),
        ),
      },
      scalarWeights: { score: 1, cost: 0 },
      earlyStopOnNoImprovement: false,
    })

    expect(result.promotedVariant.payload.id).toContain('candidate')
    expect(result.searchBestAggregate.meanScore).toBe(0.9)
  })
})
