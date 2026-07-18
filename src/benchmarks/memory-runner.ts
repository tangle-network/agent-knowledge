import { join } from 'node:path'

import { canonicalJson } from '@tangle-network/agent-eval'

import {
  type CampaignStorage,
  type CostLedgerHandle,
  createRunCostLedger,
  fsCampaignStorage,
  resolveRunDir,
} from '@tangle-network/agent-eval/campaign'

import { stableId } from '../ids'

import { DEFAULT_MEMORY_RECOVERY_RETRIES_PER_ATTEMPT } from '../memory/attempt-log'

import {
  releaseMemoryAdapterCreatedAfterAbort,
  resolveMemoryCleanupTimeoutMs,
  runBoundedMemoryLifecycle,
} from '../memory/lifecycle'

import { acquireAgentMemoryRunLease, type OwnedAgentMemoryRunLease } from '../memory/run-control'

import type { AgentMemoryAdapter } from '../memory/types'

import {
  assertScopedMemoryBenchmarkAdapter,
  memoryAdapterBenchmarkExpectedId,
  recoverMemoryAdapterBenchmarkAttempts,
} from './memory-recovery'

import {
  createMemoryAdapterBenchmarkResponder,
  MemoryAdapterBenchmarkCleanupError,
} from './memory-responder'

import { runKnowledgeBenchmarkSuite } from './suite'

import type {
  KnowledgeBenchmarkArtifact,
  KnowledgeBenchmarkResponder,
  MemoryAdapterBenchmarkCandidate,
  MemoryAdapterBenchmarkRankingRow,
  RunKnowledgeBenchmarkSuiteResult,
  RunMemoryAdapterBenchmarkOptions,
  RunMemoryAdapterBenchmarkResult,
} from './types'

import { formatNumber, normalizeUsd } from './utils'

import { assertNonEmptyBenchmarkString, assertUniqueNonEmptyStrings } from './validation'

const MEMORY_ADAPTER_BENCHMARK_IMPLEMENTATION_REF = 'agent-knowledge:memory-adapter-benchmark:v7'

export async function runMemoryAdapterBenchmark(
  options: RunMemoryAdapterBenchmarkOptions,
): Promise<RunMemoryAdapterBenchmarkResult> {
  if (options.candidates.length === 0)
    throw new Error('memory adapter benchmark requires candidates')
  const allCandidates = [...options.candidates, ...(options.recoveryCandidates ?? [])]
  assertUniqueNonEmptyStrings(
    allCandidates.map((candidate) => candidate.id),
    'memory adapter candidate id',
  )
  for (const candidate of allCandidates) {
    assertNonEmptyBenchmarkString(candidate.ref, `memory adapter candidate ${candidate.id} ref`)
    if (candidate.adapterId !== undefined) {
      assertNonEmptyBenchmarkString(
        candidate.adapterId,
        `memory adapter candidate ${candidate.id} adapterId`,
      )
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate.id)) {
      throw new Error(
        `memory adapter candidate id '${candidate.id}' must be a safe directory segment`,
      )
    }
    if (
      candidate.adapterCreationCostUsd !== undefined &&
      (!Number.isFinite(candidate.adapterCreationCostUsd) || candidate.adapterCreationCostUsd < 0)
    ) {
      throw new Error(
        `${candidate.id}: adapterCreationCostUsd must be a non-negative finite number`,
      )
    }
    if (
      candidate.costUsdPerCase !== undefined &&
      (!Number.isFinite(candidate.costUsdPerCase) || candidate.costUsdPerCase < 0)
    ) {
      throw new Error(`${candidate.id}: costUsdPerCase must be a non-negative finite number`)
    }
    if (
      candidate.recoveryCostUsdPerAttempt !== undefined &&
      (!Number.isFinite(candidate.recoveryCostUsdPerAttempt) ||
        candidate.recoveryCostUsdPerAttempt < 0)
    ) {
      throw new Error(
        `${candidate.id}: recoveryCostUsdPerAttempt must be a non-negative finite number`,
      )
    }
  }
  const storage = options.storage ?? fsCampaignStorage()
  if (!storage.append) {
    throw new Error('memory adapter benchmark requires CampaignStorage.append')
  }
  const runDir = resolveRunDir(options.runDir, options.repo)
  const cleanupTimeoutMs = resolveMemoryCleanupTimeoutMs(
    options.cleanupTimeoutMs,
    'memory adapter benchmark',
  )
  const maxRecoveryAttempts = options.maxRecoveryAttempts ?? 1_000
  if (!Number.isSafeInteger(maxRecoveryAttempts) || maxRecoveryAttempts <= 0) {
    throw new Error('memory adapter benchmark maxRecoveryAttempts must be a positive safe integer')
  }
  const maxRecoveryRetriesPerAttempt =
    options.maxRecoveryRetriesPerAttempt ?? DEFAULT_MEMORY_RECOVERY_RETRIES_PER_ATTEMPT
  if (!Number.isSafeInteger(maxRecoveryRetriesPerAttempt) || maxRecoveryRetriesPerAttempt <= 0) {
    throw new Error(
      'memory adapter benchmark maxRecoveryRetriesPerAttempt must be a positive safe integer',
    )
  }
  storage.ensureDir(runDir)
  const lease = await acquireAgentMemoryRunLease({
    experimentId: `memory-adapter-benchmark:${runDir}`,
    runDir,
    storage,
    customStorage: options.storage !== undefined,
    lockFileName: 'memory-adapter-benchmark.lock',
    label: 'memory adapter benchmark',
    controllerMode: options.controllerMode,
    acquireRunLease: options.acquireRunLease,
  })
  let result: RunMemoryAdapterBenchmarkResult | undefined
  let primaryError: unknown
  try {
    result = await runOwnedMemoryAdapterBenchmark(
      options,
      storage,
      runDir,
      lease,
      cleanupTimeoutMs,
      maxRecoveryAttempts,
      maxRecoveryRetriesPerAttempt,
    )
  } catch (error) {
    primaryError = error
  }
  let releaseError: unknown
  try {
    await lease.release()
  } catch (error) {
    releaseError = error
  }
  if (primaryError && releaseError) {
    throw new AggregateError(
      [primaryError, releaseError],
      'memory adapter benchmark failed and its controller lease could not be released',
    )
  }
  if (primaryError) throw primaryError
  if (releaseError) throw releaseError
  if (!result) throw new Error('memory adapter benchmark produced no result')
  return result
}

async function runOwnedMemoryAdapterBenchmark(
  options: RunMemoryAdapterBenchmarkOptions,
  storage: CampaignStorage,
  runDir: string,
  lease: OwnedAgentMemoryRunLease,
  cleanupTimeoutMs: number,
  maxRecoveryAttempts: number,
  maxRecoveryRetriesPerAttempt: number,
): Promise<RunMemoryAdapterBenchmarkResult> {
  const maxConcurrency = options.maxConcurrency ?? 2
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency <= 0) {
    throw new Error('memory adapter benchmark maxConcurrency must be a positive safe integer')
  }
  const costCeiling = options.costCeiling ?? options.costLedger?.costCeilingUsd ?? 0
  const costLedger =
    options.costLedger ??
    createRunCostLedger({
      storage,
      runDir,
      costCeilingUsd: costCeiling,
    })
  if (costLedger.costCeilingUsd !== costCeiling) {
    throw new Error(
      'memory adapter benchmark costCeiling must match the shared cost ledger ceiling',
    )
  }
  const attemptLogPath = join(runDir, 'memory-adapter-attempts.jsonl')
  const recoveryLogPath = join(runDir, 'memory-adapter-recovery-attempts.jsonl')
  await recoverMemoryAdapterBenchmarkAttempts({
    candidates: [...options.candidates, ...(options.recoveryCandidates ?? [])],
    storage,
    attemptLogPath,
    lease,
    cleanupTimeoutMs,
    maxConcurrency,
    now: options.now,
    runDir,
    costLedger,
    costPhase: options.costPhase ?? 'memory.adapter-benchmark',
    maxRecoveryAttempts,
    recoveryLogPath,
    maxRecoveryRetriesPerAttempt,
  })
  await lease.assertOwned()
  const rows: MemoryAdapterBenchmarkRankingRow[] = []
  for (const candidate of options.candidates) {
    await lease.assertOwned()
    const expectedAdapterId = memoryAdapterBenchmarkExpectedId(candidate)
    let adapter: AgentMemoryAdapter | undefined
    let adapterPromise: Promise<AgentMemoryAdapter> | undefined
    let adapterCreationError: unknown
    const getAdapter = (): Promise<AgentMemoryAdapter> => {
      if (!adapterPromise) {
        const abortController = new AbortController()
        const creation = createMemoryAdapterBenchmarkAdapter({
          candidate,
          purpose: 'execute',
          signal: abortController.signal,
          costLedger,
          runDir,
          costPhase: options.costPhase ?? 'memory.adapter-benchmark',
        })
        releaseMemoryAdapterCreatedAfterAbort({ creation, signal: abortController.signal })
        adapterPromise = runBoundedMemoryLifecycle({
          operation: `${candidate.id}: benchmark execute adapter creation`,
          timeoutMs: Math.min(cleanupTimeoutMs, options.dispatchTimeoutMs ?? cleanupTimeoutMs),
          abortController,
          run: () => creation,
        })
          .then((created) => {
            adapter = created
            if (created.id !== expectedAdapterId) {
              throw new Error(
                `${candidate.id}: createAdapter returned id '${created.id}', expected '${expectedAdapterId}'`,
              )
            }
            assertScopedMemoryBenchmarkAdapter(created)
            return created
          })
          .catch((error) => {
            adapterCreationError = error
            throw error
          })
      }
      return adapterPromise
    }
    const dispatchedExecutions: Promise<KnowledgeBenchmarkArtifact>[] = []
    let run: RunKnowledgeBenchmarkSuiteResult<KnowledgeBenchmarkArtifact> | undefined
    let primaryError: unknown
    try {
      await lease.assertOwned()
      let respond: KnowledgeBenchmarkResponder<KnowledgeBenchmarkArtifact> | undefined
      run = await runKnowledgeBenchmarkSuite({
        cases: options.cases,
        respond(input) {
          const operation = getAdapter().then((activeAdapter) => {
            respond ??= createMemoryAdapterBenchmarkResponder({
              adapter: activeAdapter,
              candidateId: candidate.id,
              candidateRef: candidate.ref,
              storage,
              attemptLogPath,
              lease,
              cleanupTimeoutMs,
              searchLimit: candidate.searchLimit,
              scope: candidate.scope,
              adapterCreationCostUsd: candidate.adapterCreationCostUsd,
              costUsdPerCase: candidate.costUsdPerCase,
              recoveryCostUsdPerAttempt: candidate.recoveryCostUsdPerAttempt,
              now: options.now,
            })
            return respond(input)
          })
          dispatchedExecutions.push(operation)
          return operation
        },
        respondRef: stableId(
          'memory_adapter_benchmark',
          canonicalJson({
            implementationRef: MEMORY_ADAPTER_BENCHMARK_IMPLEMENTATION_REF,
            candidateRef: candidate.ref,
            adapterId: expectedAdapterId,
            searchLimit: candidate.searchLimit ?? null,
            adapterCreationCostUsd: candidate.adapterCreationCostUsd ?? 0,
            costUsdPerCase: candidate.costUsdPerCase ?? 0,
            recoveryCostUsdPerAttempt: candidate.recoveryCostUsdPerAttempt ?? 0,
            scope: candidate.scope ?? null,
          }),
        ),
        runDir: join(runDir, candidate.id),
        storage,
        seed: options.seed,
        reps: options.reps,
        resumable: options.resumable,
        costCeiling,
        costLedger,
        costPhase: `${options.costPhase ?? 'memory.adapter-benchmark'}.${candidate.id}`,
        maxConcurrency: options.maxConcurrency,
        dispatchTimeoutMs: options.dispatchTimeoutMs,
        expectUsage: options.expectUsage ?? 'off',
        now: options.now,
      })
    } catch (error) {
      primaryError = error
    }

    const settledExecutions = await Promise.allSettled(dispatchedExecutions)
    const dispatchCleanupErrors = settledExecutions.flatMap((settled) =>
      settled.status === 'rejected' && settled.reason instanceof MemoryAdapterBenchmarkCleanupError
        ? [settled.reason]
        : [],
    )
    if (!primaryError && adapterCreationError) primaryError = adapterCreationError
    if (run) {
      rows.push({
        rank: 0,
        candidateId: candidate.id,
        label: candidate.label ?? candidate.id,
        adapterId: expectedAdapterId,
        scoreMean: run.report.score.mean,
        passRate: run.report.dimensions.passed?.mean ?? 0,
        totalCases: run.report.totalCases,
        totalCells: run.report.totalCells,
        cellsFailed: run.report.cellsFailed,
        totalCostUsd: run.report.totalCostUsd,
        reportJsonPath: run.reportJsonPath,
        reportMarkdownPath: run.reportMarkdownPath,
        report: run.report,
      })
    }
    const cleanupErrors: unknown[] = []
    let cleanupOwned = true
    try {
      await lease.assertOwned()
    } catch (error) {
      cleanupOwned = false
      cleanupErrors.push(error)
    }
    if (cleanupOwned && adapter && !adapterCreationError) {
      const activeAdapter = adapter
      try {
        await runBoundedMemoryLifecycle({
          operation: `${candidate.id}: benchmark adapter flush`,
          timeoutMs: cleanupTimeoutMs,
          resource: activeAdapter,
          run: () => activeAdapter.flush?.(),
        })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (adapter) {
      try {
        await runBoundedMemoryLifecycle({
          operation: `${candidate.id}: benchmark adapter close`,
          timeoutMs: cleanupTimeoutMs,
          resource: adapter,
          run: () => adapter!.close?.(),
        })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (primaryError || dispatchCleanupErrors.length > 0 || cleanupErrors.length > 0) {
      const errors = [
        ...(primaryError ? [primaryError] : []),
        ...dispatchCleanupErrors,
        ...cleanupErrors,
      ]
      if (errors.length === 1) throw errors[0]
      throw new AggregateError(errors, `${candidate.id}: memory adapter benchmark cleanup failed`)
    }
    await lease.assertOwned()
  }

  const costByCandidate = memoryAdapterBenchmarkCostByCandidate(costLedger, runDir, [
    ...options.candidates,
    ...(options.recoveryCandidates ?? []),
  ])
  const ranked = rows
    .map((row) => {
      const totalCostUsd = normalizeUsd(costByCandidate.get(row.candidateId) ?? 0)
      return {
        ...row,
        totalCostUsd,
      }
    })
    .sort(
      (a, b) =>
        Number(a.cellsFailed > 0) - Number(b.cellsFailed > 0) ||
        b.scoreMean - a.scoreMean ||
        b.passRate - a.passRate ||
        a.totalCostUsd - b.totalCostUsd ||
        a.candidateId.localeCompare(b.candidateId),
    )
    .map((row, index) => ({ ...row, rank: index + 1 }))
  const rankingJsonPath = join(runDir, 'memory-adapter-ranking.json')
  const rankingMarkdownPath = join(runDir, 'memory-adapter-ranking.md')
  const unrankedRecoveryCostUsd = normalizeUsd(
    (options.recoveryCandidates ?? []).reduce(
      (sum, candidate) => sum + (costByCandidate.get(candidate.id) ?? 0),
      0,
    ),
  )
  const totalCostUsd = normalizeUsd(
    [...costByCandidate.values()].reduce((sum, cost) => sum + cost, 0),
  )
  storage.write(
    rankingJsonPath,
    `${JSON.stringify({ totalCostUsd, unrankedRecoveryCostUsd, rows: ranked }, null, 2)}\n`,
  )
  storage.write(
    rankingMarkdownPath,
    renderMemoryAdapterRankingMarkdown(ranked, totalCostUsd, unrankedRecoveryCostUsd),
  )
  return {
    rows: ranked,
    totalCostUsd,
    unrankedRecoveryCostUsd,
    rankingJsonPath,
    rankingMarkdownPath,
    attemptLogPath,
    recoveryLogPath,
  }
}

async function createMemoryAdapterBenchmarkAdapter(input: {
  candidate: MemoryAdapterBenchmarkCandidate
  purpose: 'execute' | 'recovery'
  signal: AbortSignal
  costLedger: CostLedgerHandle
  runDir: string
  costPhase: string
}): Promise<AgentMemoryAdapter> {
  const { candidate, purpose, signal, costLedger, runDir, costPhase } = input
  const costUsd = candidate.adapterCreationCostUsd ?? 0
  let externalCallAttempted = false
  const create = async (): Promise<AgentMemoryAdapter> => {
    const adapter = await candidate.createAdapter({
      purpose,
      signal,
      markExternalCall: () => {
        externalCallAttempted = true
      },
    })
    if (!adapter || typeof adapter !== 'object') {
      throw new Error(`${candidate.id}: createAdapter returned no ${purpose} adapter`)
    }
    return adapter
  }
  if (costUsd === 0) return create()

  const tags = memoryAdapterCreationCostTags(runDir, candidate.id, purpose)
  const generation = costLedger.list({ tags }).length
  const receipt = {
    model: candidate.id,
    inputTokens: 0,
    outputTokens: 0,
    actualCostUsd: costUsd,
  } as const
  const paid = await costLedger.runPaidCall({
    callId: memoryAdapterCreationCostCallId(candidate, purpose, generation),
    channel: 'driver',
    phase: `${costPhase}.${candidate.id}.adapter-${purpose}`,
    actor: `agent-knowledge:memory-adapter:${candidate.id}`,
    model: candidate.id,
    tags,
    maximumCharge: { externallyEnforcedMaximumUsd: costUsd },
    execute: create,
    receipt: () => ({
      ...receipt,
      actualCostUsd: externalCallAttempted ? costUsd : 0,
    }),
    receiptFromError: () => ({
      ...receipt,
      actualCostUsd: externalCallAttempted ? costUsd : 0,
    }),
  })
  if (!paid.succeeded) throw paid.error
  return paid.value
}

function memoryAdapterCreationCostTags(
  runDir: string,
  candidateId: string,
  purpose: 'execute' | 'recovery',
): Record<string, string> {
  return {
    runDir: join(runDir, candidateId),
    candidateId,
    memoryAdapterCreation: purpose,
  }
}

function memoryAdapterCreationCostCallId(
  candidate: MemoryAdapterBenchmarkCandidate,
  purpose: 'execute' | 'recovery',
  generation: number,
): string {
  return stableId(
    'memory_adapter_creation_cost_call',
    canonicalJson({
      purpose,
      generation,
      candidateId: candidate.id,
      candidateRef: candidate.ref,
      adapterCreationCostUsd: candidate.adapterCreationCostUsd ?? 0,
    }),
  )
}

function memoryAdapterBenchmarkCostByCandidate(
  costLedger: CostLedgerHandle,
  runDir: string,
  candidates: readonly MemoryAdapterBenchmarkCandidate[],
): ReadonlyMap<string, number> {
  const candidateByRunDir = new Map(
    candidates.map((candidate) => [join(runDir, candidate.id), candidate.id]),
  )
  const totals = new Map<string, number>()
  for (const receipt of costLedger.list()) {
    const candidateId = receipt.tags?.runDir
      ? candidateByRunDir.get(receipt.tags.runDir)
      : undefined
    if (!candidateId) continue
    totals.set(candidateId, (totals.get(candidateId) ?? 0) + receipt.costUsd)
  }
  return totals
}

function renderMemoryAdapterRankingMarkdown(
  rows: readonly MemoryAdapterBenchmarkRankingRow[],
  totalCostUsd: number,
  unrankedRecoveryCostUsd: number,
): string {
  return [
    '# Memory Adapter Ranking',
    '',
    `- total cost: $${formatNumber(totalCostUsd)}`,
    `- retired-candidate recovery cost: $${formatNumber(unrankedRecoveryCostUsd)}`,
    '',
    '| rank | candidate | adapter | cases | cells | failed | mean score | pass rate | cost |',
    '| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(
      (row) =>
        `| ${row.rank} | ${row.label} | ${row.adapterId} | ${row.totalCases} | ${row.totalCells} | ${row.cellsFailed} | ${formatNumber(row.scoreMean)} | ${formatNumber(row.passRate)} | $${formatNumber(row.totalCostUsd)} |`,
    ),
    '',
  ].join('\n')
}
