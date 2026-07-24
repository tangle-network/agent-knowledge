import type {
  DispatchContext,
  JsonValue,
  OptimizationMethod,
  Scenario,
} from '@tangle-network/agent-eval/campaign'
import { stableId } from '../ids'
import {
  type RunSerializedKnowledgeOptimizationOptions,
  type RunSerializedKnowledgeOptimizationResult,
  runSerializedKnowledgeOptimization,
} from '../optimization'
import type {
  KnowledgeImprovementOptions,
  KnowledgeImprovementResult,
  KnowledgeImprovementUpdateInput,
} from './contracts'
import { improveKnowledgeBase } from './run'
import { hashKnowledgeBase } from './workspace'

type PolicyCandidateOptions = Omit<
  KnowledgeImprovementOptions,
  'root' | 'goal' | 'runId' | 'maxCandidates' | 'step' | 'knowledgeResearch' | 'updateKnowledge'
>

type PolicyOptimizationBaseOptions<
  TPolicy extends JsonValue,
  TScenario extends Scenario,
  TArtifact,
> = Omit<
  RunSerializedKnowledgeOptimizationOptions<TPolicy, TScenario, TArtifact>,
  'baseline' | 'method' | 'trainScenarios' | 'selectionScenarios' | 'finalScenarios'
>

export interface OptimizeKnowledgeBasePolicyOptions<
  TPolicy extends JsonValue,
  TScenario extends Scenario,
  TArtifact,
> extends PolicyOptimizationBaseOptions<TPolicy, TScenario, TArtifact> {
  root: string
  goal: string
  baselinePolicy: TPolicy
  method: OptimizationMethod<TScenario, TArtifact>
  trainScenarios: readonly TScenario[]
  selectionScenarios: readonly TScenario[]
  finalScenarios: readonly TScenario[]
  /** Stable version for applyPolicy and its external dependencies. */
  policyApplicationRef: string
  /** Optional namespace for parallel materialization of the same measured policy. */
  candidateRunLabel?: string
  candidate?: PolicyCandidateOptions
  applyPolicy(
    input: KnowledgeImprovementUpdateInput & {
      policy: TPolicy
      policySurface: string
      policySurfaceHash: string
      optimizationMethod: string
    },
  ): Promise<{
    applied: boolean
    summary: string
    metadata?: Record<string, JsonValue>
  }>
}

export interface OptimizeKnowledgeBasePolicyResult<TPolicy extends JsonValue> {
  optimization: RunSerializedKnowledgeOptimizationResult<TPolicy>
  improvement: KnowledgeImprovementResult
}

/**
 * Optimizes a serialized KB-maintenance policy, then materializes the selected
 * policy in one isolated knowledge candidate. Activation remains explicit.
 */
export async function optimizeKnowledgeBasePolicy<
  TPolicy extends JsonValue,
  TScenario extends Scenario,
  TArtifact,
>(
  options: OptimizeKnowledgeBasePolicyOptions<TPolicy, TScenario, TArtifact>,
): Promise<OptimizeKnowledgeBasePolicyResult<TPolicy>> {
  const {
    root,
    goal,
    baselinePolicy,
    method,
    trainScenarios,
    selectionScenarios,
    finalScenarios,
    policyApplicationRef,
    candidateRunLabel,
    candidate,
    applyPolicy,
    ...optimizationOptions
  } = options
  if (typeof root !== 'string' || !root.trim()) {
    throw new Error('optimizeKnowledgeBasePolicy root must be non-empty')
  }
  if (typeof goal !== 'string' || !goal.trim()) {
    throw new Error('optimizeKnowledgeBasePolicy goal must be non-empty')
  }
  if (typeof policyApplicationRef !== 'string' || !policyApplicationRef.trim()) {
    throw new Error('optimizeKnowledgeBasePolicy policyApplicationRef must be non-empty')
  }
  if (
    candidateRunLabel !== undefined &&
    (typeof candidateRunLabel !== 'string' || !candidateRunLabel.trim())
  ) {
    throw new Error('optimizeKnowledgeBasePolicy candidateRunLabel must be non-empty')
  }
  const baseHash = await hashKnowledgeBase(root)
  const optimization = await runSerializedKnowledgeOptimization({
    ...optimizationOptions,
    baseline: baselinePolicy,
    method,
    trainScenarios,
    selectionScenarios,
    finalScenarios,
  })
  const winner = optimization.winner
  const currentBaseHash = await hashKnowledgeBase(root)
  if (currentBaseHash !== baseHash) {
    throw new Error(
      `knowledge base changed during policy optimization: expected ${baseHash}, got ${currentBaseHash}`,
    )
  }
  const runId = stableId(
    'kbpolicy',
    `${candidateRunLabel ?? 'default'}:${goal}:${optimization.methodName}:${winner.surfaceHash}:${policyApplicationRef}:${baseHash}`,
  )
  const improvement = await improveKnowledgeBase({
    ...(candidate ?? {}),
    root,
    goal,
    runId,
    maxCandidates: 1,
    updateKnowledge: async (input) => {
      if (input.baseHash !== baseHash) {
        throw new Error(
          `knowledge base changed before policy materialization: expected ${baseHash}, got ${input.baseHash}`,
        )
      }
      const result = await applyPolicy({
        ...input,
        policy: structuredClone(winner.value),
        policySurface: winner.surface,
        policySurfaceHash: winner.surfaceHash,
        optimizationMethod: optimization.methodName,
      })
      return {
        ...result,
        metadata: {
          ...(result.metadata ?? {}),
          optimization: {
            method: optimization.methodName,
            policySurfaceHash: winner.surfaceHash,
            policyApplicationRef,
          },
        },
      }
    },
  })
  return { optimization, improvement }
}

export type KnowledgePolicyDispatch<
  TPolicy extends JsonValue,
  TScenario extends Scenario,
  TArtifact,
> = (input: {
  candidate: TPolicy
  candidateSurface: string
  candidateSurfaceHash: string
  scenario: TScenario
  context: DispatchContext
}) => Promise<TArtifact>
