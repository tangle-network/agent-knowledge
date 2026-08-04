import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ExternalOptimizerModelCall,
  JudgeConfig,
  Scenario,
} from '@tangle-network/agent-eval/campaign'
import { describe, expect, it } from 'vitest'
import type { RetrievalEvalArtifact, RetrievalEvalScenario } from '../src'
import { testExecutionRef } from './support/optimization'

const campaign = (await import(
  process.env.AGENT_EVAL_CAMPAIGN_URL ?? '@tangle-network/agent-eval/campaign'
)) as typeof import('@tangle-network/agent-eval/campaign')
const knowledge = (await import(
  process.env.AGENT_KNOWLEDGE_PACKAGE_URL ?? '../src/index'
)) as typeof import('../src/index')
const { gepaOptimizationMethod, skillOptOptimizationMethod } = campaign
const { runRetrievalImprovementLoop, runSerializedKnowledgeOptimization } = knowledge

const python = process.env.AGENT_EVAL_TEST_PYTHON
const describeWithOfficialEngines = python ? describe : describe.skip

describeWithOfficialEngines('official optimizer integration', () => {
  it('runs official GEPA through retrieval optimization and final scoring', async () => {
    assertPythonModules(python!, ['agent_eval_rpc.gepa_bridge', 'gepa.optimize_anything'])
    const root = await mkdtemp(join(tmpdir(), 'agent-knowledge-gepa-'))
    try {
      const method = gepaOptimizationMethod<RetrievalEvalScenario, RetrievalEvalArtifact>({
        name: 'official-gepa-retrieval',
        objective: 'Return a JSON retrieval configuration that finds the expected page.',
        evaluationId: 'agent-knowledge-official-gepa-retrieval',
        background: 'The complete candidate is one canonical JSON object.',
        recipe: {
          kind: 'engine',
          run: {
            engine: 'gepa',
            maxEvaluations: 4,
            maxProposerCostUsd: 1,
            maxConcurrency: 1,
            stopAtScore: 1,
            engineConfig: {
              engine: {
                capture_stdio: false,
                max_workers: 1,
                parallel: false,
                raise_on_exception: true,
                seed: 7,
              },
              reflection: {
                reflection_minibatch_size: 1,
                skip_perfect_score: false,
              },
            },
          },
        },
        optimizer: optimizerModel('```\n{"k":2}\n```', 'agent-knowledge-test:gepa-fixed-response'),
        describeScenario: (scenario) => ({
          query: scenario.query,
          expected: scenario.expected,
        }),
        describeArtifact: (artifact) => ({
          requestedK: artifact.requestedK,
          hits: artifact.hits,
        }),
        runner: pythonRunner(python!, 'agent_eval_rpc.gepa_bridge'),
      })
      const result = await runRetrievalImprovementLoop({
        executionRef: testExecutionRef('official-gepa-retrieval'),
        baseline: { k: 1 },
        method,
        trainScenarios: [retrievalScenario('gepa-train', 'train query')],
        selectionScenarios: [retrievalScenario('gepa-selection', 'selection query')],
        finalScenarios: [
          retrievalScenario('gepa-final-a', 'final query a'),
          retrievalScenario('gepa-final-b', 'final query b'),
        ],
        retrieve: async ({ k }) => ({
          hits: [
            { pageId: 'distractor', path: 'knowledge/distractor.md', rank: 1 },
            ...(k >= 2 ? [{ pageId: 'gold', path: 'knowledge/gold.md', rank: 2 }] : []),
          ],
        }),
        runDir: join(root, 'run'),
        expectUsage: 'off',
        maxConcurrency: 1,
        costCeiling: 1,
        optimizationRunOptions: {
          maxConcurrency: 1,
        },
        resamples: 200,
        seed: 7,
      })

      expect(result.winnerConfig).toEqual({ k: 2 })
      expect(result.comparison.best).toMatchObject({
        baselineComposite: 0,
        winnerComposite: 1,
        lift: 1,
        provenance: {
          source: { package: 'gepa', evidence: 'observed' },
          bridge: { package: 'agent-eval-rpc', evidence: 'observed' },
        },
      })
      expect(result.comparison.best.provenance?.evaluationCount).toBeGreaterThan(0)
      expect(result.comparison.best.provenance?.tokenUsage?.calls).toBeGreaterThan(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 300_000)

  it('runs official SkillOpt through serialized text optimization and final scoring', async () => {
    assertPythonModules(python!, ['agent_eval_rpc.skillopt_bridge', 'skillopt.engine.trainer'])
    const root = await mkdtemp(join(tmpdir(), 'agent-knowledge-skillopt-'))
    const modelResponse = JSON.stringify({
      batch_size: 1,
      failure_summary: [
        {
          count: 1,
          description: 'The required response rule is absent.',
          failure_type: 'missing_rule',
        },
      ],
      patch: {
        edits: [
          {
            content: '\n\n## Required Rule\nALWAYS_RETURN_READY\n',
            op: 'append',
          },
        ],
        reasoning: 'Add the missing response rule.',
      },
    })
    try {
      const method = skillOptOptimizationMethod<SkillScenario, SkillArtifact>({
        name: 'official-skillopt-policy',
        objective: 'Add the rule required for a correct answer.',
        evaluationId: 'agent-knowledge-official-skillopt-policy',
        trainer: {
          epochs: 1,
          batchSize: 1,
          accumulation: 1,
          editBudget: 1,
          minEditBudget: 1,
          analystWorkers: 1,
          minibatchSize: 1,
          maxAnalystRounds: 1,
          evaluationWorkers: 1,
        },
        optimizer: optimizerModel(modelResponse, 'agent-knowledge-test:skillopt-fixed-response'),
        maxEvaluations: 3,
        describeScenario: (scenario) => ({ prompt: scenario.prompt }),
        describeArtifact: (artifact) => ({ candidate: artifact.candidate }),
        runner: pythonRunner(python!, 'agent_eval_rpc.skillopt_bridge'),
      })
      const result = await runSerializedKnowledgeOptimization({
        executionRef: testExecutionRef('official-skillopt-skill'),
        baseline: '# Base Skill\nAnswer normally.\n',
        method,
        trainScenarios: [skillScenario('skill-train', 'Return READY for training.')],
        selectionScenarios: [skillScenario('skill-selection', 'Return READY for selection.')],
        finalScenarios: [
          skillScenario('skill-final-a', 'Return READY for final case A.'),
          skillScenario('skill-final-b', 'Return READY for final case B.'),
        ],
        codec: {
          serialize: (candidate) => candidate,
          parse: (surface) => surface,
        },
        dispatchCandidate: async ({ candidate }) => {
          return { candidate }
        },
        judges: [skillJudge],
        runDir: join(root, 'run'),
        expectUsage: 'off',
        maxConcurrency: 1,
        costCeiling: 1,
        optimizationRunOptions: {
          maxConcurrency: 1,
        },
        resamples: 200,
        seed: 11,
      })

      expect(result.winner.value).toContain('ALWAYS_RETURN_READY')
      expect(result.comparison.best).toMatchObject({
        baselineComposite: 0,
        winnerComposite: 1,
        lift: 1,
        provenance: {
          source: { package: 'skillopt', evidence: 'observed' },
          bridge: { package: 'agent-eval-rpc', evidence: 'observed' },
        },
      })
      expect(result.comparison.best.provenance?.evaluationCount).toBe(3)
      expect(result.comparison.best.provenance?.tokenUsage?.calls).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 300_000)
})

interface SkillScenario extends Scenario {
  kind: 'skill-policy'
  prompt: string
}

interface SkillArtifact {
  candidate: string
}

const skillJudge: JudgeConfig<SkillArtifact, SkillScenario> = {
  name: 'required-rule',
  dimensions: [{ key: 'correctness', description: 'The candidate includes the required rule.' }],
  score: ({ artifact }) => {
    const score = artifact.candidate.includes('ALWAYS_RETURN_READY') ? 1 : 0
    return {
      dimensions: { correctness: score },
      composite: score,
      notes: score ? '' : 'The required response rule is absent.',
    }
  },
}

function retrievalScenario(id: string, query: string): RetrievalEvalScenario {
  return {
    id,
    kind: 'retrieval-eval',
    query,
    expected: { kind: 'page', pageId: 'gold' },
  }
}

function skillScenario(id: string, prompt: string): SkillScenario {
  return { id, kind: 'skill-policy', prompt }
}

function pythonRunner(command: string, module: string) {
  return { command, args: ['-m', module] }
}

function optimizerModel(content: string, callRef: string) {
  const pricing = {
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
  }
  const call: ExternalOptimizerModelCall = async ({ callId, request }) =>
    optimizerModelCall({ callId, request, content, pricing })
  return {
    model: 'local-optimizer',
    callRef,
    call,
    budget: {
      maxCostUsd: 1,
      maxRequests: 100,
      maxRequestBytes: 100_000,
      maxResponseBytes: 100_000,
      maxOutputTokensPerRequest: 2_000,
      pricing,
    },
  }
}

async function optimizerModelCall({
  callId,
  request,
  content,
  pricing,
}: {
  callId: string
  request: { model: string }
  content: string
  pricing: { inputUsdPerMillion: number; outputUsdPerMillion: number }
}) {
  return {
    succeeded: true as const,
    response: {
      content,
      usage: { promptTokens: 11, completionTokens: 13, totalTokens: 24 },
      costUsd: 0.000037,
      model: request.model,
      durationMs: 0,
      finishReason: 'stop',
      contentEmpty: false,
      raw: { id: callId, fixture: true },
    },
    receipt: {
      model: request.model,
      inputTokens: 11,
      outputTokens: 13,
      customTokenPricing: pricing,
    },
    execution: { kind: 'fixed-test-response', callId, model: request.model },
  }
}

function assertPythonModules(command: string, modules: readonly string[]): void {
  const imports = modules.map((module) => `import ${module}`).join('; ')
  const result = spawnSync(command, ['-c', imports], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`official optimizer Python environment is unavailable: ${result.stderr.trim()}`)
  }
}
