import type {
  DispatchContext,
  OptimizationMethod,
  Scenario,
} from '@tangle-network/agent-eval/campaign'
import type { AgentCandidateJsonValue as JsonValue } from '@tangle-network/agent-interface'
import { sha256, stableId } from '../ids'
import { assertImmutableRef } from '../immutable-ref'
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
  | 'root'
  | 'goal'
  | 'implementationRef'
  | 'runId'
  | 'maxCandidates'
  | 'step'
  | 'knowledgeResearch'
  | 'updateKnowledge'
>

type PolicyOptimizationBaseOptions<
  TPolicy extends JsonValue,
  TScenario extends Scenario,
  TArtifact,
> = Omit<
  RunSerializedKnowledgeOptimizationOptions<TPolicy, TScenario, TArtifact>,
  | 'baseline'
  | 'method'
  | 'trainScenarios'
  | 'selectionScenarios'
  | 'finalScenarios'
  | 'executionRef'
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
  /** Commit or content identity for evaluation, applyPolicy, and external dependencies. */
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
  assertImmutableRef(policyApplicationRef, 'optimizeKnowledgeBasePolicy policyApplicationRef')
  if (
    candidateRunLabel !== undefined &&
    (typeof candidateRunLabel !== 'string' || !candidateRunLabel.trim())
  ) {
    throw new Error('optimizeKnowledgeBasePolicy candidateRunLabel must be non-empty')
  }
  const baseHash = await hashKnowledgeBase(root)
  const optimization = await runSerializedKnowledgeOptimization({
    ...optimizationOptions,
    executionRef: policyApplicationRef,
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
    implementationRef: `sha256:${sha256(
      `${policyApplicationRef}\n${winner.surfaceHash}\n${optimization.methodName}`,
    )}`,
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
