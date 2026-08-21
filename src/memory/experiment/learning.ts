import { join } from 'node:path'
import {
  canonicalDigest,
  createRunCostLedger,
  fsCampaignStorage,
  resolveRunDir,
} from '@tangle-network/agent-eval/campaign'
import { normalizeUsd } from '../../candidate-ranking'
import { assertImmutableRef } from '../../immutable-ref'
import { assertStoredAgentMemoryEvidence } from './learning-evidence'
import { measureAgentMemoryLearning } from './learning-metrics'
import { pairAgentMemoryLearningRuns } from './learning-pairs'
import { runAgentMemoryExperiment } from './run'
import type {
  AgentMemoryLearningComparison,
  CompareAgentMemoryLearningOptions,
  RunAgentMemoryLearningExperimentOptions,
  RunAgentMemoryLearningExperimentResult,
} from './types'
import { assertMemoryLearningSequences, assertNonEmptyString } from './validation'

/** Compare exact matched stateful and stateless memory runs. */
export function compareAgentMemoryLearning(
  options: CompareAgentMemoryLearningOptions,
): AgentMemoryLearningComparison {
  const paired = pairAgentMemoryLearningRuns(options)
  return measureAgentMemoryLearning(paired, options.stateful, options.stateless)
}

/** Run a matched stateful-versus-stateless memory experiment under one cost limit. */
export async function runAgentMemoryLearningExperiment(
  options: RunAgentMemoryLearningExperimentOptions,
): Promise<RunAgentMemoryLearningExperimentResult> {
  assertNonEmptyString(options.runDir, 'memory learning experiment runDir')
  options.signal?.throwIfAborted()
  assertMemoryLearningSequences(options.sequences)
  for (const candidate of [...options.candidates, ...(options.recoveryCandidates ?? [])]) {
    assertImmutableRef(candidate.ref, `${candidate.id}: memory learning candidate ref`)
  }
  if (options.executeStep) {
    assertImmutableRef(options.executeStepRef, 'memory learning experiment executeStepRef')
  }
  const storage = options.storage ?? fsCampaignStorage()
  const runDir = resolveRunDir(options.runDir, options.repo)
  storage.ensureDir(runDir)
  const costCeiling = options.costCeiling ?? options.costLedger?.costCeilingUsd ?? 0
  const costLedger =
    options.costLedger ?? createRunCostLedger({ storage, runDir, costCeilingUsd: costCeiling })
  if (costLedger.costCeilingUsd !== costCeiling) {
    throw new Error(
      'memory learning experiment costCeiling must match the shared cost ledger ceiling',
    )
  }
  const armOrder = options.armOrder ?? 'stateful-first'
  if (armOrder !== 'stateful-first' && armOrder !== 'stateless-first') {
    throw new Error(
      "memory learning experiment armOrder must be 'stateful-first' or 'stateless-first'",
    )
  }
  const { armOrder: _armOrder, ...experimentOptions } = options
  const shared = {
    ...experimentOptions,
    experimentRunId: options.experimentRunId ?? runDir,
    costCeiling,
    costLedger,
  }
  const runArm = async (memoryMode: 'stateful' | 'stateless') => {
    const result = await runAgentMemoryExperiment({
      ...shared,
      memoryMode,
      runDir: armRunDir(runDir, memoryMode),
    })
    assertStoredAgentMemoryEvidence(storage, result, options.sequences)
    return result
  }
  const firstMode = armOrder === 'stateful-first' ? 'stateful' : 'stateless'
  const secondMode = firstMode === 'stateful' ? 'stateless' : 'stateful'
  const first = await runArm(firstMode)
  const second = await runArm(secondMode)
  const stateful = firstMode === 'stateful' ? first : second
  const stateless = firstMode === 'stateless' ? first : second
  const comparison = compareAgentMemoryLearning({ stateful, stateless })
  const ledgerSummary = costLedger.summary()
  const cost = {
    experimentUsd: normalizeUsd(stateful.totalCostUsd + stateless.totalCostUsd),
    ledgerUsd: normalizeUsd(ledgerSummary.totalCostUsd),
    ceilingUsd: costLedger.costCeilingUsd,
    accountingComplete: ledgerSummary.accountingComplete,
  }
  const report = { armOrder, comparison, cost }
  const evidenceRef = canonicalDigest(report)
  const comparisonDir = armRunDir(runDir, 'comparisons')
  storage.ensureDir(comparisonDir)
  const comparisonPath = armRunDir(comparisonDir, `${evidenceRef.slice(7)}.json`)
  storage.write(comparisonPath, `${JSON.stringify({ evidenceRef, ...report }, null, 2)}\n`)
  return {
    armOrder,
    stateful,
    stateless,
    comparison,
    evidenceRef,
    comparisonPath,
    cost,
  }
}

function armRunDir(runDir: string, child: string): string {
  return runDir.startsWith('mem://')
    ? `${runDir.replace(/\/+$/, '')}/${child}`
    : join(runDir, child)
}
