import { dirname, join } from 'node:path'
import { canonicalJson } from '@tangle-network/agent-eval'
import type { CampaignStorage } from '@tangle-network/agent-eval/campaign'
import type { AgentCandidateJsonValue as JsonValue } from '@tangle-network/agent-interface'
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

export async function buildRegisteredCandidate<TConfig extends JsonValue>(
  options: RunAgentMemoryImprovementOptions<TConfig>,
  storage: CampaignStorage,
  runDir: string,
  config: TConfig,
  hash: string,
): Promise<AgentMemoryExperimentCandidate> {
  const candidate = await buildCandidate(options, config, hash)
  const path = join(runDir, 'memory-candidate-identities', `${hash}.json`)
  const record = { surfaceHash: hash, candidateRef: candidate.ref }
  const stored = storage.read(path)
  if (stored !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(stored)
    } catch (error) {
      throw new Error(`invalid memory candidate identity '${path}'`, { cause: error })
    }
    if (canonicalJson(parsed as JsonValue) !== canonicalJson(record)) {
      throw new Error(
        `memory config '${hash}' changed candidate identity within the same improvement run`,
      )
    }
    return candidate
  }
  if (storage.exists(path)) throw new Error(`cannot read memory candidate identity '${path}'`)
  storage.ensureDir(dirname(path))
  storage.write(path, `${JSON.stringify(record, null, 2)}\n`)
  return candidate
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
