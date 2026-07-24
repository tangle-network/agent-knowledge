import type {
  DispatchContext,
  JudgeConfig,
  OptimizationMethod,
} from '@tangle-network/agent-eval/campaign'
import type { AgentCandidateJsonValue as JsonValue } from '@tangle-network/agent-interface'
import {
  jsonObjectCandidateCodec,
  type RunSerializedKnowledgeOptimizationOptions,
  type RunSerializedKnowledgeOptimizationResult,
  runSerializedKnowledgeOptimization,
  scenarioContentFingerprint,
} from './optimization'
import type { RagAnswerEvalArtifact, RagAnswerEvalScenario } from './rag-eval'
import { ragAnswerQualityJudge } from './rag-eval'

export type RagOptimizationConfig = Record<string, JsonValue>

type RagOptimizationBaseOptions = Omit<
  RunSerializedKnowledgeOptimizationOptions<
    RagOptimizationConfig,
    RagAnswerEvalScenario,
    RagAnswerEvalArtifact
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

export interface RunRagOptimizationOptions extends RagOptimizationBaseOptions {
  baseline: RagOptimizationConfig
  method: OptimizationMethod<RagAnswerEvalScenario, RagAnswerEvalArtifact>
  trainScenarios: readonly RagAnswerEvalScenario[]
  selectionScenarios: readonly RagAnswerEvalScenario[]
  finalScenarios: readonly RagAnswerEvalScenario[]
  run(input: {
    config: RagOptimizationConfig
    configSurface: string
    configSurfaceHash: string
    scenario: RagAnswerEvalScenario
    context: DispatchContext
  }): Promise<RagAnswerEvalArtifact>
  judges?: readonly JudgeConfig<RagAnswerEvalArtifact, RagAnswerEvalScenario>[]
}

export interface RunRagOptimizationResult
  extends RunSerializedKnowledgeOptimizationResult<RagOptimizationConfig> {
  baselineConfig: RagOptimizationConfig
  winnerConfig: RagOptimizationConfig
  trainScenarios: readonly RagAnswerEvalScenario[]
  selectionScenarios: readonly RagAnswerEvalScenario[]
  finalScenarios: readonly RagAnswerEvalScenario[]
}

/** Optimizes retrieval and answer behavior together as one serialized RAG configuration. */
export async function runRagOptimization(
  options: RunRagOptimizationOptions,
): Promise<RunRagOptimizationResult> {
  const {
    baseline,
    method,
    trainScenarios,
    selectionScenarios,
    finalScenarios,
    run,
    judges,
    ...runOptions
  } = options
  const result = await runSerializedKnowledgeOptimization({
    ...runOptions,
    baseline,
    method,
    trainScenarios,
    selectionScenarios,
    finalScenarios,
    codec: jsonObjectCandidateCodec<RagOptimizationConfig>(),
    judges: [...(judges ?? [ragAnswerQualityJudge()])],
    scenarioFingerprint: scenarioContentFingerprint,
    dispatchCandidate: ({ candidate, candidateSurface, candidateSurfaceHash, scenario, context }) =>
      run({
        config: candidate,
        configSurface: candidateSurface,
        configSurfaceHash: candidateSurfaceHash,
        scenario,
        context,
      }),
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
