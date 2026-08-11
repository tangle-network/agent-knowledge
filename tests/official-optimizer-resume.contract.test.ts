import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  gepaOptimizationMethod,
  type OptimizationMethod,
  type Scenario,
  skillOptOptimizationMethod,
} from '@tangle-network/agent-eval/campaign'
import { afterEach, describe, expect, it } from 'vitest'
import { runSerializedKnowledgeOptimization } from '../src/index'
import { testExecutionRef } from './support/optimization'

interface ResumeScenario extends Scenario {
  kind: 'resume-contract'
  prompt: string
}

interface ResumeArtifact {
  score: number
}

type ResumeCandidate = { policy: string }

const roots: string[] = []
const modelBudget = {
  maxCostUsd: 0.1,
  maxRequests: 1,
  maxRequestBytes: 10_000,
  maxResponseBytes: 10_000,
  maxOutputTokensPerRequest: 100,
  pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('official optimizer resume identity', () => {
  it.each([
    [
      'GEPA',
      () =>
        gepaOptimizationMethod<ResumeScenario, ResumeArtifact>({
          recipe: {
            kind: 'engine',
            run: {
              engine: 'gepa',
              maxEvaluations: 1,
              maxProposerCostUsd: 0.1,
            },
          },
          objective: 'Improve the policy.',
          evaluationId: 'knowledge-resume-contract',
          resume: 'if-compatible',
          trustResumeState: true,
          runner: fakeOfficialOptimizerRunner('gepa'),
        }),
    ],
    [
      'SkillOpt',
      () =>
        skillOptOptimizationMethod<ResumeScenario, ResumeArtifact>({
          objective: 'Improve the policy.',
          evaluationId: 'knowledge-resume-contract',
          trainer: { epochs: 1, batchSize: 1 },
          optimizer: {
            model: 'unused-test-model',
            callRef: 'knowledge-test:never-invoked',
            call: async ({ request }) => ({
              succeeded: false,
              error: 'the fake optimizer issued an unexpected model call',
              receipt: {
                model: request.model,
                inputTokens: 0,
                outputTokens: 0,
                costUnknown: true,
                usageUnknown: true,
              },
              execution: { kind: 'unexpected-test-call' },
            }),
            budget: modelBudget,
          },
          maxEvaluations: 1,
          resume: 'if-compatible',
          runner: fakeOfficialOptimizerRunner('skillopt'),
        }),
    ],
  ] as const)(
    'changes %s compatible resume identity when Knowledge executionRef changes',
    async (_label, createMethod) => {
      const root = await mkdtemp(join(tmpdir(), 'agent-knowledge-official-resume-'))
      roots.push(root)
      const method = createMethod()
      const first = await runOfficialMethod(root, method, testExecutionRef('implementation-a'))
      const second = await runOfficialMethod(root, method, testExecutionRef('implementation-b'))

      expect(first).not.toBe(second)
    },
  )
})

async function runOfficialMethod(
  runDir: string,
  method: OptimizationMethod<ResumeScenario, ResumeArtifact>,
  executionRef: string,
): Promise<string | undefined> {
  const result = await runSerializedKnowledgeOptimization<
    ResumeCandidate,
    ResumeScenario,
    ResumeArtifact
  >({
    executionRef,
    baseline: { policy: 'baseline' },
    method,
    trainScenarios: [scenario('train', 'training policy')],
    selectionScenarios: [scenario('selection', 'selection policy')],
    finalScenarios: [
      scenario('final-a', 'first final policy'),
      scenario('final-b', 'second final policy'),
    ],
    dispatchCandidate: async ({ candidate }) => ({
      score: candidate.policy === 'better' ? 1 : 0,
    }),
    judges: [
      {
        name: 'resume-contract-quality',
        dimensions: [{ key: 'quality', description: 'candidate policy quality' }],
        score: ({ artifact }) => ({
          composite: artifact.score,
          dimensions: { quality: artifact.score },
        }),
      },
    ],
    runDir,
    expectUsage: 'off',
    resamples: 40,
  })
  return result.comparison.best.provenance?.compatibleRunId
}

function scenario(id: string, prompt: string): ResumeScenario {
  return { id, kind: 'resume-contract', prompt }
}

function fakeOfficialOptimizerRunner(optimizer: 'gepa' | 'skillopt') {
  const runtime = {
    python: { implementation: 'CPython', version: '3.12.0' },
    bridge: {
      package: 'agent-eval-rpc',
      version: 'test',
      sourceUrl: 'https://github.com/tangle-network/agent-eval',
      revision: 'test',
      sourceSha256: 'a'.repeat(64),
    },
    optimizer: {
      package: optimizer,
      version: 'test',
      sourceUrl:
        optimizer === 'gepa'
          ? 'https://github.com/gepa-ai/gepa'
          : 'https://github.com/microsoft/SkillOpt',
      revision: 'test',
      sourceSha256: 'b'.repeat(64),
    },
    engineModules: [],
  }
  const optimizeResult =
    optimizer === 'gepa'
      ? [
          'bestCandidate: input.seedCandidate,',
          'bestScore: 0,',
          'totalEvaluations: 0,',
          'recipeKind: input.recipe.kind,',
          'proposerCostAccounting: "unavailable",',
          'candidatePopulation,',
        ]
      : [
          'bestCandidate: input.seedCandidate,',
          'bestScore: 0,',
          'totalEvaluations: 0,',
          'totalSteps: 0,',
          'tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, requestAttempts: 0 },',
        ]
  const source = [
    "const fs = require('node:fs')",
    "const crypto = require('node:crypto')",
    "const path = require('node:path')",
    "const inputPath = process.argv[process.argv.indexOf('--input') + 1]",
    "const outputPath = process.argv[process.argv.indexOf('--output') + 1]",
    'const input = JSON.parse(fs.readFileSync(inputPath, "utf8"))',
    `const runtime = ${JSON.stringify(runtime)}`,
    'if (input.operation === "inspect") {',
    '  fs.writeFileSync(outputPath, JSON.stringify({ runtime }))',
    '  process.exit(0)',
    '}',
    ...(optimizer === 'gepa'
      ? [
          'const populationPath = path.join(input.outputDir, "candidate-population.json")',
          'const scenarioIds = (input.selectionSet.length ? input.selectionSet : input.trainSet).map(({ id }) => id)',
          'const populationContents = JSON.stringify({',
          '  schemaVersion: 1,',
          '  scope: "gepa-candidate-population",',
          '  runId: input.runId,',
          '  bestIndex: 0,',
          '  candidates: [{',
          '    index: 0,',
          '    candidate: input.seedCandidate,',
          '    parentIndices: [null],',
          '    aggregateScore: null,',
          '    selectionScores: [],',
          '    discoveryEvaluationCount: 0,',
          '  }],',
          '})',
          'fs.mkdirSync(input.outputDir, { recursive: true })',
          'fs.writeFileSync(populationPath, populationContents)',
          'const candidatePopulation = {',
          '  scope: "gepa-candidate-population",',
          '  path: populationPath,',
          '  sha256: "sha256:" + crypto.createHash("sha256").update(populationContents).digest("hex"),',
          '  bytes: Buffer.byteLength(populationContents),',
          '  runId: input.runId,',
          '  candidates: 1,',
          '  bestIndex: 0,',
          '  maxCandidates: input.maxPopulationCandidates,',
          '  maxCandidateChars: input.maxCandidateChars,',
          '  scenarioIds,',
          '  surfaceKind: typeof input.seedCandidate === "string" ? "text" : "components",',
          '}',
        ]
      : []),
    'fs.writeFileSync(outputPath, JSON.stringify({',
    ...optimizeResult,
    'upstream: runtime.optimizer,',
    'runId: input.runId,',
    'resumed: false,',
    '}))',
  ].join('\n')
  return { command: process.execPath, args: ['-e', source, '--'] }
}
