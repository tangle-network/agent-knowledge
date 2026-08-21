import type { CampaignResult, CostLedgerHandle } from '@tangle-network/agent-eval/campaign'
import { normalizeUsd, rankCandidates } from '../../candidate-ranking'
import { stableId } from '../../ids'
import type {
  AgentMemoryExperimentCandidate,
  AgentMemoryExperimentRankingRow,
  AgentMemorySequenceArtifact,
  AgentMemorySequenceScenario,
} from './types'

export function rankAgentMemoryExperiment(
  candidates: readonly AgentMemoryExperimentCandidate[],
  scenarios: readonly AgentMemorySequenceScenario[],
  campaign: CampaignResult<AgentMemorySequenceArtifact, AgentMemorySequenceScenario>,
  costByCandidate: ReadonlyMap<string, number>,
): AgentMemoryExperimentRankingRow[] {
  const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]))
  const rows = candidates.map((candidate): AgentMemoryExperimentRankingRow => {
    const candidateScenarios = scenarios.filter((scenario) => scenario.candidateId === candidate.id)
    const cells = campaign.cells.filter(
      (cell) => scenarioById.get(cell.scenarioId)?.candidateId === candidate.id,
    )
    const successful = cells.filter((cell) => !cell.error && cell.artifact)
    const dimensionRows = successful.map((cell) => cell.artifact.dimensions)
    return {
      rank: 0,
      candidateId: candidate.id,
      label: candidate.label ?? candidate.id,
      scoreMean: mean(
        cells.map((cell) => (!cell.error && cell.artifact ? cell.artifact.score : 0)),
      ),
      passRate: mean(cells.map((cell) => (!cell.error && cell.artifact?.passed ? 1 : 0))),
      totalSequences: candidateScenarios.length,
      totalCells: cells.length,
      totalProbes: successful.reduce((sum, cell) => sum + cell.artifact.probes.length, 0),
      cellsFailed: cells.filter((cell) => Boolean(cell.error)).length,
      totalCostUsd: normalizeUsd(costByCandidate.get(candidate.id) ?? 0),
      durationMs: cells.reduce((sum, cell) => sum + cell.durationMs, 0),
      dimensions: meanDimensions(dimensionRows),
    }
  })
  return rankCandidates(rows)
}

export function memoryExperimentCostByCandidate(
  costLedger: CostLedgerHandle,
  runDir: string,
  scenarios: readonly AgentMemorySequenceScenario[],
  candidateIdsInput: readonly string[],
): ReadonlyMap<string, number> {
  const candidateByScenario = new Map(
    scenarios.map((scenario) => [scenario.id, scenario.candidateId]),
  )
  const candidateIds = new Set(candidateIdsInput)
  const sequenceIds = new Set(scenarios.map((scenario) => scenario.sequenceId))
  for (const candidateId of candidateIds) {
    for (const sequenceId of sequenceIds) {
      candidateByScenario.set(`${stableId('candidate', candidateId)}:${sequenceId}`, candidateId)
    }
  }
  const totals = new Map<string, number>()
  for (const receipt of costLedger.list()) {
    if (receipt.tags?.runDir !== runDir) continue
    const scenarioCandidate = receipt.tags.scenarioId
      ? candidateByScenario.get(receipt.tags.scenarioId)
      : undefined
    const recoveryCandidate =
      receipt.tags.memoryRecovery === 'attempt' && receipt.tags.candidateId
        ? receipt.tags.candidateId
        : undefined
    const candidateId = scenarioCandidate ?? recoveryCandidate
    if (!candidateId || !candidateIds.has(candidateId)) continue
    totals.set(candidateId, (totals.get(candidateId) ?? 0) + receipt.costUsd)
  }
  return totals
}

export function renderAgentMemoryExperimentRanking(
  rows: readonly AgentMemoryExperimentRankingRow[],
  totalCostUsd: number,
  unrankedRecoveryCostUsd: number,
): string {
  return [
    '# Agent Memory Experiment',
    '',
    `- total cost: $${format(totalCostUsd)}`,
    `- retired-candidate cost: $${format(unrankedRecoveryCostUsd)}`,
    '',
    '| rank | candidate | sequences | cells | probes | failed | score | pass rate | cost | duration ms |',
    '| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(
      (row) =>
        `| ${row.rank} | ${row.label} | ${row.totalSequences} | ${row.totalCells} | ${row.totalProbes} | ${row.cellsFailed} | ${format(row.scoreMean)} | ${format(row.passRate)} | $${format(row.totalCostUsd)} | ${format(row.durationMs)} |`,
    ),
    '',
  ].join('\n')
}

export function meanDimensions(rows: readonly Record<string, number>[]): Record<string, number> {
  const values = new Map<string, number[]>()
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (!Number.isFinite(value)) continue
      const bucket = values.get(key) ?? []
      bucket.push(value)
      values.set(key, bucket)
    }
  }
  return Object.fromEntries([...values].map(([key, bucket]) => [key, mean(bucket)]))
}

export function countDimensions(rows: readonly (readonly string[])[]): Record<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    for (const key of new Set(row)) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Object.fromEntries(counts)
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function format(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : '0.0000'
}
