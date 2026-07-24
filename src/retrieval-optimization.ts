import { canonicalJson } from '@tangle-network/agent-eval'
import {
  type JudgeConfig,
  type OptimizationMethod,
  surfaceHash,
} from '@tangle-network/agent-eval/campaign'
import type { AgentCandidateJsonValue as JsonValue } from '@tangle-network/agent-interface'
import {
  jsonObjectCandidateCodec,
  type RunSerializedKnowledgeOptimizationOptions,
  type RunSerializedKnowledgeOptimizationResult,
  runSerializedKnowledgeOptimization,
} from './optimization'
import {
  buildRetrievalEvalDispatch,
  type RetrievalConfig,
  type RetrievalEvalArtifact,
  type RetrievalEvalRetriever,
  type RetrievalEvalScenario,
  type RetrievalMetricWeights,
  retrievalRecallJudge,
} from './retrieval-eval'
import type { KnowledgeIndex } from './types'

type RetrievalOptimizationBaseOptions = Omit<
  RunSerializedKnowledgeOptimizationOptions<
    RetrievalConfig,
    RetrievalEvalScenario,
    RetrievalEvalArtifact
  >,
  | 'baseline'
  | 'method'
  | 'trainScenarios'
  | 'selectionScenarios'
  | 'finalScenarios'
  | 'dispatchCandidate'
  | 'judges'
  | 'codec'
  | 'scenarioFingerprint'
>

export interface RunRetrievalImprovementLoopOptions extends RetrievalOptimizationBaseOptions {
  baseline: RetrievalConfig
  trainScenarios: readonly RetrievalEvalScenario[]
  selectionScenarios: readonly RetrievalEvalScenario[]
  finalScenarios: readonly RetrievalEvalScenario[]
  method: OptimizationMethod<RetrievalEvalScenario, RetrievalEvalArtifact>
  index?: KnowledgeIndex
  defaultK?: number
  retrieve?: RetrievalEvalRetriever
  judges?: readonly JudgeConfig<RetrievalEvalArtifact, RetrievalEvalScenario>[]
  metricWeights?: RetrievalMetricWeights
}

export interface RunRetrievalImprovementLoopResult
  extends RunSerializedKnowledgeOptimizationResult<RetrievalConfig> {
  baselineConfig: RetrievalConfig
  winnerConfig: RetrievalConfig
  trainScenarios: readonly RetrievalEvalScenario[]
  selectionScenarios: readonly RetrievalEvalScenario[]
  finalScenarios: readonly RetrievalEvalScenario[]
}

export async function runRetrievalImprovementLoop(
  options: RunRetrievalImprovementLoopOptions,
): Promise<RunRetrievalImprovementLoopResult> {
  const dispatch = buildRetrievalEvalDispatch({
    index: options.index,
    defaultK: options.defaultK,
    retrieve: options.retrieve,
  })
  const {
    baseline,
    trainScenarios,
    selectionScenarios,
    finalScenarios,
    method,
    index: _index,
    defaultK: _defaultK,
    retrieve: _retrieve,
    judges,
    metricWeights,
    ...runOptions
  } = options
  const result = await runSerializedKnowledgeOptimization({
    ...runOptions,
    baseline,
    method,
    trainScenarios,
    selectionScenarios,
    finalScenarios,
    codec: jsonObjectCandidateCodec<RetrievalConfig>(),
    judges: [...(judges ?? [retrievalRecallJudge({ weights: metricWeights })])],
    scenarioFingerprint: retrievalScenarioFingerprint,
    dispatchCandidate: ({ candidateSurface, scenario, context }) =>
      dispatch(candidateSurface, scenario, context),
  })
  return {
    ...result,
    baselineConfig: result.baseline.value,
    winnerConfig: result.winner.value,
    trainScenarios: [...trainScenarios],
    selectionScenarios: [...selectionScenarios],
    finalScenarios: [...finalScenarios],
  }
}

function retrievalScenarioFingerprint(scenario: RetrievalEvalScenario): string {
  return surfaceHash(
    canonicalJson({
      query: scenario.query,
      expected: scenario.expected,
      k: scenario.k ?? null,
    } as JsonValue),
  )
}
