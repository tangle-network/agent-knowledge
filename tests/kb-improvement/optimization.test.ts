import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  inMemoryCampaignStorage,
  type OptimizationMethod,
  type Scenario,
} from '@tangle-network/agent-eval/campaign'
import { describe, expect, it } from 'vitest'
import {
  hashKnowledgeBase,
  improveKnowledgeBase,
  optimizeKnowledgeBasePolicy,
  type RagAnswerEvalArtifact,
  type RagAnswerEvalScenario,
  scenarioContentFingerprint,
} from '../../src/index'
import { mutableCandidateRoot, passingMetric, withKb } from '../support/kb-improvement'

interface PolicyScenario extends Scenario {
  kind: 'kb-policy-eval'
  prompt: string
}

interface PolicyArtifact {
  score: number
}

type Policy = { evidence: 'none' | 'required'; maxSources: number }

function immutableRef(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

describe('optimizeKnowledgeBasePolicy', () => {
  it('runs full RAG evaluation against the isolated candidate KB', async () => {
    await withKb(async (root) => {
      const method: OptimizationMethod<RagAnswerEvalScenario, RagAnswerEvalArtifact> = {
        name: 'fixture-candidate-rag-method',
        async optimize(input) {
          expect('testScenarios' in input).toBe(false)
          return {
            winnerSurface: '{"mode":"grounded"}',
            cost: { totalCostUsd: 0, accountingComplete: true, incompleteReasons: [] },
          }
        },
      }
      const scenario = (id: string): RagAnswerEvalScenario => ({
        id,
        kind: 'rag-answer-eval',
        query: `${id} candidate policy`,
      })
      const seenCandidateRoots = new Set<string>()

      const result = await improveKnowledgeBase({
        root,
        goal: 'Evaluate RAG against candidate knowledge',
        runId: 'candidate-rag-optimization',
        async updateKnowledge({ candidateRoot }) {
          const path = join(candidateRoot, 'knowledge', 'candidate-policy.md')
          await mkdir(dirname(path), { recursive: true })
          await writeFile(
            path,
            [
              '---',
              'id: candidate-policy',
              'title: Candidate Policy',
              '---',
              '# Candidate Policy',
              'Candidate-only evidence.',
            ].join('\n'),
          )
          return { applied: true, summary: 'wrote candidate knowledge' }
        },
        ragOptimization: {
          executionRef: immutableRef('candidate-rag-execution'),
          baseline: { mode: 'unsupported' },
          method,
          trainScenarios: [scenario('candidate-rag-train')],
          selectionScenarios: [scenario('candidate-rag-selection')],
          finalScenarios: [scenario('candidate-rag-final-a'), scenario('candidate-rag-final-b')],
          async run({
            config,
            scenario: item,
            baseHash,
            baselineRoot,
            candidateRoot,
            candidateIndex,
          }) {
            seenCandidateRoots.add(candidateRoot)
            expect(candidateRoot).not.toBe(root)
            expect(baselineRoot).not.toBe(root)
            expect(await hashKnowledgeBase(baselineRoot)).toBe(baseHash)
            expect(candidateIndex.pages.map((page) => page.id)).toContain('candidate-policy')
            const score = config.mode === 'grounded' ? 1 : 0
            return {
              query: item.query,
              answer: score ? 'Candidate-only evidence.' : 'Unsupported answer.',
              contexts: [],
              metadata: { score },
            }
          },
          judges: [
            {
              name: 'candidate-rag-quality',
              dimensions: [{ key: 'quality', description: 'candidate RAG quality' }],
              score: ({ artifact }) => {
                const score = Number(artifact.metadata?.score ?? 0)
                return { composite: score, dimensions: { quality: score } }
              },
            },
          ],
          storage: inMemoryCampaignStorage(),
          expectUsage: 'off',
          resamples: 200,
        },
        requiredPhases: ['rag-optimization'],
        evaluate: passingMetric,
      })

      expect(seenCandidateRoots.size).toBe(1)
      expect(result.lifecycle?.optimization?.winner.value).toEqual({ mode: 'grounded' })
      expect(result.lifecycle?.optimization?.comparison.testScenarioIds).toEqual([
        'candidate-rag-final-a',
        'candidate-rag-final-b',
      ])
    })
  })

  it('runs a complete method and applies only the exact winner to an isolated candidate', async () => {
    await withKb(async (root) => {
      const methodInputs: string[][] = []
      const method: OptimizationMethod<PolicyScenario, PolicyArtifact> = {
        name: 'fixture-kb-policy-method',
        async optimize(input) {
          methodInputs.push([
            ...input.trainScenarios.map((scenario) => scenario.id),
            ...input.selectionScenarios.map((scenario) => scenario.id),
          ])
          expect('testScenarios' in input).toBe(false)
          return {
            winnerSurface: '{"evidence":"required","maxSources":4}',
            cost: { totalCostUsd: 0, accountingComplete: true, incompleteReasons: [] },
          }
        },
      }
      const scenario = (id: string): PolicyScenario => ({
        id,
        kind: 'kb-policy-eval',
        prompt: `${id} source-backed update`,
      })

      const result = await optimizeKnowledgeBasePolicy<Policy, PolicyScenario, PolicyArtifact>({
        root,
        goal: 'Select a source-backed KB maintenance policy',
        baselinePolicy: { evidence: 'none', maxSources: 1 },
        method,
        trainScenarios: [scenario('policy-train')],
        selectionScenarios: [scenario('policy-selection')],
        finalScenarios: [scenario('policy-final-a'), scenario('policy-final-b')],
        policyApplicationRef: immutableRef('write-maintenance-policy'),
        dispatchCandidate: async ({ candidate }) => ({
          score: candidate.evidence === 'required' && candidate.maxSources >= 2 ? 1 : 0,
        }),
        judges: [
          {
            name: 'policy-quality',
            dimensions: [{ key: 'quality', description: 'policy satisfies evidence rules' }],
            score: ({ artifact }) => ({
              composite: artifact.score,
              dimensions: { quality: artifact.score },
            }),
          },
        ],
        scenarioFingerprint: scenarioContentFingerprint,
        runDir: 'memory://kb-policy-optimization-test',
        storage: inMemoryCampaignStorage(),
        expectUsage: 'off',
        resamples: 200,
        candidate: { evaluate: passingMetric },
        async applyPolicy({ candidateRoot, policy, policySurfaceHash, optimizationMethod }) {
          expect(policy).toEqual({ evidence: 'required', maxSources: 4 })
          expect(optimizationMethod).toBe('fixture-kb-policy-method')
          const path = join(candidateRoot, 'knowledge', 'maintenance-policy.md')
          await mkdir(dirname(path), { recursive: true })
          await writeFile(
            path,
            `# Maintenance Policy\n\n${policySurfaceHash}: require source evidence.\n`,
          )
          return { applied: true, summary: 'wrote selected maintenance policy' }
        },
      })

      expect(methodInputs).toEqual([['policy-train', 'policy-selection']])
      expect(result.optimization.winner.value).toEqual({
        evidence: 'required',
        maxSources: 4,
      })
      expect(result.optimization.comparison.testScenarioIds).toEqual([
        'policy-final-a',
        'policy-final-b',
      ])
      expect(result.improvement.state.status).toBe('candidate-ready')
      expect(result.improvement.promoted).toBe(false)
      expect(result.improvement.lifecycle?.knowledgeUpdate?.metadata?.optimization).toEqual({
        method: 'fixture-kb-policy-method',
        policySurfaceHash: result.optimization.winner.surfaceHash,
        policyApplicationRef: immutableRef('write-maintenance-policy'),
      })
      await expect(
        readFile(join(root, 'knowledge', 'maintenance-policy.md'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' })

      const candidateRoot = mutableCandidateRoot(root, result.improvement)
      await expect(
        readFile(join(candidateRoot, 'knowledge', 'maintenance-policy.md'), 'utf8'),
      ).resolves.toContain(result.optimization.winner.surfaceHash)
    })
  })

  it('does not materialize a policy winner after the live knowledge base changes', async () => {
    await withKb(async (root) => {
      let applyCalls = 0
      const method: OptimizationMethod<PolicyScenario, PolicyArtifact> = {
        name: 'concurrent-kb-change',
        async optimize() {
          await writeFile(join(root, 'knowledge', 'concurrent-change.md'), '# Concurrent change\n')
          return {
            winnerSurface: '{"evidence":"required","maxSources":2}',
            cost: { totalCostUsd: 0, accountingComplete: true, incompleteReasons: [] },
          }
        },
      }
      const scenario = (id: string): PolicyScenario => ({
        id,
        kind: 'kb-policy-eval',
        prompt: `${id} policy`,
      })

      await expect(
        optimizeKnowledgeBasePolicy<Policy, PolicyScenario, PolicyArtifact>({
          root,
          goal: 'Reject a policy measured against changing knowledge',
          baselinePolicy: { evidence: 'none', maxSources: 1 },
          method,
          trainScenarios: [scenario('changing-train')],
          selectionScenarios: [scenario('changing-selection')],
          finalScenarios: [scenario('changing-final-a'), scenario('changing-final-b')],
          policyApplicationRef: immutableRef('changing-policy'),
          dispatchCandidate: async () => ({ score: 1 }),
          judges: [
            {
              name: 'changing-policy-quality',
              dimensions: [{ key: 'quality', description: 'policy quality' }],
              score: ({ artifact }) => ({
                composite: artifact.score,
                dimensions: { quality: artifact.score },
              }),
            },
          ],
          runDir: 'memory://changing-kb-policy-test',
          storage: inMemoryCampaignStorage(),
          expectUsage: 'off',
          resamples: 200,
          async applyPolicy() {
            applyCalls += 1
            return { applied: true, summary: 'must not run' }
          },
        }),
      ).rejects.toThrow('knowledge base changed during policy optimization')
      expect(applyCalls).toBe(0)
    })
  })
})
