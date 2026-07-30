import { canonicalJson } from '@tangle-network/agent-eval'
import { sha256 } from '../../ids'
import { DEFAULT_MEMORY_RECOVERY_RETRIES_PER_ATTEMPT } from '../attempt-log'
import { DEFAULT_MEMORY_CLEANUP_TIMEOUT_MS } from '../lifecycle'
import type {
  AgentMemoryExperimentCandidate,
  AgentMemoryExperimentComparisonRef,
  AgentMemoryMode,
  RunAgentMemoryExperimentOptions,
} from './types'

export const MEMORY_EXPERIMENT_IMPLEMENTATION_REF = `sha256:${sha256(
  canonicalJson({
    stateful: 'retain declared sequence scopes across ordered steps',
    stateless: 'clear every declared sequence scope before each step after the first',
    isolation: 'provider scopes receive an opaque branch id but no experiment or sequence labels',
    recovery: 'unfinished attempts bind cleanup to the exact sequence sha256',
    gain: 'post-first-step stateful minus stateless reward',
    inference: 'average candidates and repetitions within each sequence before paired bootstrap',
    preTreatment: 'report first-step score balance separately from gain',
    transfer: 'only probes with explicit transferKey after the first step',
    forgetting: 'signed prior peak minus final score for exact repeated retentionKey probes',
    evidence: 'full sha256 design, manifest, split, artifact, and probe scoring-input references',
  }),
)}`

const COMPARISON_REF_PATTERN = /^sha256:[a-f0-9]{64}$/

export function resolveAgentMemoryMode(value: unknown): AgentMemoryMode {
  if (value === undefined) return 'stateful'
  if (value !== 'stateful' && value !== 'stateless') {
    throw new Error("memory experiment memoryMode must be 'stateful' or 'stateless'")
  }
  return value
}

export function memoryExperimentComparisonRef(
  options: RunAgentMemoryExperimentOptions,
  resolvedRunDir: string,
): AgentMemoryExperimentComparisonRef {
  const material = canonicalJson({
    implementationRef: MEMORY_EXPERIMENT_IMPLEMENTATION_REF,
    experimentId: options.experimentId,
    experimentRunId: options.experimentRunId ?? resolvedRunDir,
    sequences: options.sequences,
    candidates: options.candidates.map(candidateConditions),
    recoveryCandidates: (options.recoveryCandidates ?? []).map(candidateConditions),
    executeStepRef: options.executeStepRef ?? 'fixtures',
    cleanupBranches: options.cleanupBranches ?? true,
    seed: options.seed ?? 42,
    reps: options.reps ?? 1,
    resumable: options.resumable ?? true,
    costCeilingUsd: options.costCeiling ?? options.costLedger?.costCeilingUsd ?? 0,
    costPhase: options.costPhase ?? null,
    maxConcurrency: options.maxConcurrency ?? 2,
    dispatchTimeoutMs: options.dispatchTimeoutMs || null,
    cleanupTimeoutMs: options.cleanupTimeoutMs ?? DEFAULT_MEMORY_CLEANUP_TIMEOUT_MS,
    maxRecoveryAttempts: options.maxRecoveryAttempts ?? 1_000,
    maxRecoveryRetriesPerAttempt:
      options.maxRecoveryRetriesPerAttempt ?? DEFAULT_MEMORY_RECOVERY_RETRIES_PER_ATTEMPT,
  })
  return `sha256:${sha256(material)}`
}

export function assertAgentMemoryExperimentComparisonRef(
  value: unknown,
  label: string,
): asserts value is AgentMemoryExperimentComparisonRef {
  if (typeof value !== 'string' || !COMPARISON_REF_PATTERN.test(value)) {
    throw new Error(`${label} must be a full lowercase sha256 reference`)
  }
}

function candidateConditions(candidate: AgentMemoryExperimentCandidate) {
  return {
    id: candidate.id,
    label: candidate.label ?? null,
    ref: candidate.ref,
    policy: candidate.policy ?? null,
    baseScope: candidate.baseScope ?? null,
    externalCostUsdPerSequence: candidate.externalCostUsdPerSequence ?? 0,
    externalRecoveryCostUsdPerAttempt: candidate.externalRecoveryCostUsdPerAttempt ?? 0,
    externalCostAccounting: candidate.externalCostAccounting ?? 'exact',
  }
}
