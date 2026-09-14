import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inMemoryCampaignStorage } from '@tangle-network/agent-eval/campaign'
import {
  defineEvaluationClaim,
  openFinalEvidenceLedger,
} from '@tangle-network/agent-eval/experiment'
import { hashCanonical } from '@tangle-network/agent-eval/ledger-core'
import { expect, it } from 'vitest'
import {
  type RetrievalEvalArtifact,
  type RetrievalEvalScenario,
  runRetrievalImprovementLoop,
} from '../src/index'
import { fixedOptimizationMethod, testExecutionRef } from './support/optimization'

it('forwards source-unit claims and consumes fresh final evidence through retrieval optimization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-final-evidence-'))
  try {
    const ledger = openFinalEvidenceLedger({ path: join(root, 'evidence.jsonl') })
    const evaluatorDigest = hashCanonical({ evaluator: 'retrieval-integrity-fixture' })
    const claim = defineEvaluationClaim({
      use: 'comparison',
      population: { id: 'fixture-sources', description: 'Offline adapter fixtures' },
      samplingFrame: 'Authored fixtures for execution checks only',
      independentUnit: 'source.id',
      generalization: 'new-units',
      minimumEffect: 0.05,
    })
    const fixed = fixedOptimizationMethod<RetrievalEvalScenario, RetrievalEvalArtifact>('{}')
    let searches = 0
    const run = () =>
      runRetrievalImprovementLoop({
        executionRef: testExecutionRef('retrieval-integrity-fixture'),
        baseline: { k: 1 },
        method: {
          name: fixed.name,
          async optimize(input) {
            searches += 1
            const reserved = await ledger.read()
            expect(reserved.succeeded).toBe(true)
            if (!reserved.succeeded) throw new Error(reserved.error.message)
            expect(reserved.value).toHaveLength(1)
            expect(reserved.value[0]?.exposure).toBeNull()
            expect(reserved.value[0]?.reservation.unitIds).toEqual(['final-1', 'final-2'])
            return fixed.optimize(input)
          },
        },
        trainScenarios: [scenario('train', 'train')],
        selectionScenarios: [scenario('selection', 'selection')],
        finalScenarios: [
          scenario('final-1-a', 'final-1'),
          scenario('final-1-b', 'final-1'),
          scenario('final-2-a', 'final-2'),
          scenario('final-2-b', 'final-2'),
        ],
        retrieve: async () => ({
          hits: [{ pageId: 'answer', path: 'knowledge/answer.md', rank: 1 }],
        }),
        runDir: '/runs/retrieval-integrity-fixture',
        storage: inMemoryCampaignStorage(),
        expectUsage: 'off',
        claim,
        finalEvidence: { ledger, requestId: 'retrieval-fixture', evaluatorDigest },
        resamples: 200,
      })

    const result = await run()
    expect(result.comparison.claim).toEqual(claim)
    expect(result.comparison).toMatchObject({
      observationUnit: 'registered',
      pairedCellN: 4,
      units: { observations: 4, independentUnits: 2 },
    })
    expect(result.comparison.best.scenarioScores).toHaveLength(4)
    expect(result.comparison.best.unitScores).toHaveLength(2)
    expect(result.comparison.finalEvidence?.record.exposure?.measurement.evaluatorDigest).toBe(
      evaluatorDigest,
    )
    await expect(run().then(() => undefined)).rejects.toMatchObject({ kind: 'conflict' })
    expect(searches).toBe(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function scenario(id: string, sourceId: string): RetrievalEvalScenario {
  return {
    id,
    kind: 'retrieval-eval',
    query: `question ${id}`,
    expected: { kind: 'page', pageId: 'answer' },
    source: { id: sourceId },
  }
}
