import type {
  CampaignStorage,
  CostLedgerHandle,
  createRunCostLedger,
  Governor,
  SurfaceProposer,
} from '@tangle-network/agent-eval/campaign'
import type { AgentMemoryExperimentCandidate, RunAgentMemoryExperimentOptions } from '../experiment'
import type { AgentMemoryGovernor, OwnedRunLease, RunAgentMemoryImprovementOptions } from './types'

export function withCostContext(
  proposer: SurfaceProposer,
  costLedger: CostLedgerHandle,
  lease: OwnedRunLease,
  label: string,
): SurfaceProposer {
  return {
    kind: proposer.kind,
    async propose(context) {
      await lease.assertOwned()
      const proposal = await proposer.propose({
        ...context,
        costLedger,
        costPhase: `memory.proposal.${context.track?.id ?? label}`,
      })
      await lease.assertOwned()
      return proposal
    },
    ...(proposer.decide ? { decide: (input) => proposer.decide!(input) } : {}),
  }
}

export function withGovernorCostContext(
  governor: AgentMemoryGovernor,
  costLedger: CostLedgerHandle,
  lease: OwnedRunLease,
): Governor {
  return {
    async decide(context) {
      await lease.assertOwned()
      const decision = await governor.decide({
        ...context,
        costLedger,
        costPhase: 'memory.governor',
      })
      await lease.assertOwned()
      return decision
    },
  }
}

export async function buildCandidate<TConfig>(
  options: RunAgentMemoryImprovementOptions<TConfig>,
  config: TConfig,
  hash: string,
  role: string,
): Promise<AgentMemoryExperimentCandidate> {
  const built = await options.createCandidate({
    config,
    candidateId: `${role}-${hash}`,
    surfaceHash: hash,
  })
  return {
    ...built,
    id: `${role}-${hash}`,
    ref: built.ref,
  }
}

export function experimentOptions<TConfig>(
  options: RunAgentMemoryImprovementOptions<TConfig>,
  costLedger: ReturnType<typeof createRunCostLedger>,
  storage: CampaignStorage,
  lease: OwnedRunLease,
): Pick<
  RunAgentMemoryExperimentOptions,
  | 'storage'
  | 'seed'
  | 'reps'
  | 'resumable'
  | 'maxConcurrency'
  | 'dispatchTimeoutMs'
  | 'cleanupTimeoutMs'
  | 'maxRecoveryAttempts'
  | 'maxRecoveryRetriesPerAttempt'
  | 'executeStep'
  | 'executeStepRef'
  | 'onBranchSnapshot'
  | 'cleanupBranches'
  | 'costLedger'
  | 'acquireRunLease'
  | 'now'
> {
  return {
    storage,
    seed: options.seed,
    reps: options.reps,
    resumable: options.resumable,
    maxConcurrency: options.sequenceConcurrency,
    dispatchTimeoutMs: options.dispatchTimeoutMs,
    cleanupTimeoutMs: options.cleanupTimeoutMs,
    maxRecoveryAttempts: options.maxRecoveryAttempts,
    maxRecoveryRetriesPerAttempt: options.maxRecoveryRetriesPerAttempt,
    executeStep: options.executeStep,
    executeStepRef: options.executeStepRef,
    onBranchSnapshot: options.onBranchSnapshot,
    cleanupBranches: options.cleanupBranches ?? true,
    costLedger,
    acquireRunLease: async () => ({
      assertOwned: () => lease.assertOwned(),
      release() {},
    }),
    now: options.now,
  }
}
