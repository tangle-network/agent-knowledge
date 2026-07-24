import type { CampaignStorage, JsonValue } from '@tangle-network/agent-eval/campaign'
import { assertImmutableRef } from '../../immutable-ref'
import type { AgentMemoryExperimentCandidate, RunAgentMemoryExperimentOptions } from '../experiment'
import type { OwnedRunLease, RunAgentMemoryImprovementOptions } from './types'

export async function buildCandidate<TConfig extends JsonValue>(
  options: RunAgentMemoryImprovementOptions<TConfig>,
  config: TConfig,
  hash: string,
): Promise<AgentMemoryExperimentCandidate> {
  const id = `memory-config-${hash}`
  const built = await options.createCandidate({
    config,
    candidateId: id,
    surfaceHash: hash,
  })
  assertImmutableRef(built.ref, `${id}: ref`)
  assertDeclaredCost(built.externalCostUsdPerSequence, `${id}: externalCostUsdPerSequence`)
  assertDeclaredCost(
    built.externalRecoveryCostUsdPerAttempt,
    `${id}: externalRecoveryCostUsdPerAttempt`,
  )
  if (built.externalCostAccounting !== 'exact') {
    throw new Error(`${id}: memory improvement requires exact external cost accounting`)
  }
  return {
    ...built,
    id,
    ref: built.ref,
  }
}

function assertDeclaredCost(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a declared non-negative finite number`)
  }
}

export function experimentOptions<TConfig extends JsonValue>(
  options: RunAgentMemoryImprovementOptions<TConfig>,
  storage: CampaignStorage,
  lease: OwnedRunLease,
): Pick<
  RunAgentMemoryExperimentOptions,
  | 'storage'
  | 'resumable'
  | 'dispatchTimeoutMs'
  | 'cleanupTimeoutMs'
  | 'maxRecoveryAttempts'
  | 'maxRecoveryRetriesPerAttempt'
  | 'executeStep'
  | 'executeStepRef'
  | 'onBranchSnapshot'
  | 'cleanupBranches'
  | 'acquireRunLease'
  | 'now'
> {
  return {
    storage,
    resumable: options.resumable,
    dispatchTimeoutMs: options.dispatchTimeoutMs,
    cleanupTimeoutMs: options.cleanupTimeoutMs,
    maxRecoveryAttempts: options.maxRecoveryAttempts,
    maxRecoveryRetriesPerAttempt: options.maxRecoveryRetriesPerAttempt,
    executeStep: options.executeStep,
    executeStepRef: options.executeStepRef,
    onBranchSnapshot: options.onBranchSnapshot,
    cleanupBranches: options.cleanupBranches ?? true,
    acquireRunLease: async () => ({
      assertOwned: () => lease.assertOwned(),
      release() {},
    }),
    now: options.now,
  }
}
