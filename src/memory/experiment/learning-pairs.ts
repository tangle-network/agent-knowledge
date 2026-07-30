import {
  assertCampaignSplitIdentity,
  type CampaignCellResult,
  canonicalDigest,
} from '@tangle-network/agent-eval/campaign'
import { stableId } from '../../ids'
import { assertImmutableRef } from '../../immutable-ref'
import { assertAgentMemoryExperimentComparisonRef } from './comparison-ref'
import { mean } from './metrics'
import type {
  AgentMemoryEvidenceRef,
  AgentMemorySequenceArtifact,
  AgentMemorySequenceProbeResult,
  CompareAgentMemoryLearningOptions,
  RunAgentMemoryExperimentResult,
} from './types'

export interface IndexedMemoryLearningCell {
  cell: CampaignCellResult<AgentMemorySequenceArtifact>
  artifact: AgentMemorySequenceArtifact
  artifactRef: AgentMemoryEvidenceRef
}

export interface PairedMemoryLearningProbe {
  stateful: AgentMemorySequenceProbeResult
  stateless: AgentMemorySequenceProbeResult
}

export interface PairedMemoryLearningCell {
  stateful: IndexedMemoryLearningCell
  stateless: IndexedMemoryLearningCell
  probes: PairedMemoryLearningProbe[]
}

export function pairAgentMemoryLearningRuns(
  options: CompareAgentMemoryLearningOptions,
): PairedMemoryLearningCell[] {
  assertComparableDesign(options.stateful, options.stateless)
  const statefulCells = indexCompleteCells('stateful', options.stateful)
  const statelessCells = indexCompleteCells('stateless', options.stateless)
  assertSameKeys(statefulCells, statelessCells, 'experiment cell')

  return [...statefulCells.entries()]
    .map(([key, stateful]): PairedMemoryLearningCell => {
      const stateless = statelessCells.get(key)
      if (!stateless) {
        throw new Error(`cannot compare memory learning: missing stateless cell ${key}`)
      }
      if (stateful.cell.cellId !== stateless.cell.cellId) {
        throw new Error(
          `cannot compare memory learning: cell identity differs for ${key} (${stateful.cell.cellId} vs ${stateless.cell.cellId})`,
        )
      }
      return { stateful, stateless, probes: pairProbes(stateful, stateless) }
    })
    .sort(comparePairedCells)
}

function assertComparableDesign(
  stateful: RunAgentMemoryExperimentResult,
  stateless: RunAgentMemoryExperimentResult,
): void {
  if (stateful.memoryMode !== 'stateful') {
    throw new Error(
      `cannot compare memory learning: stateful arm is labeled ${String(stateful.memoryMode)}`,
    )
  }
  if (stateless.memoryMode !== 'stateless') {
    throw new Error(
      `cannot compare memory learning: stateless arm is labeled ${String(stateless.memoryMode)}`,
    )
  }
  assertAgentMemoryExperimentComparisonRef(
    stateful.comparisonRef,
    'cannot compare memory learning: stateful comparisonRef',
  )
  assertAgentMemoryExperimentComparisonRef(
    stateless.comparisonRef,
    'cannot compare memory learning: stateless comparisonRef',
  )
  if (stateful.comparisonRef !== stateless.comparisonRef) {
    throw new Error(
      `cannot compare memory learning: experimental conditions differ (${stateful.comparisonRef} vs ${stateless.comparisonRef})`,
    )
  }
  if (stateful.campaign.manifestHash === stateless.campaign.manifestHash) {
    throw new Error(
      'cannot compare memory learning: campaign cache identity does not distinguish memoryMode',
    )
  }
  assertRunSplitIdentity('stateful', stateful)
  assertRunSplitIdentity('stateless', stateless)
  if (stateful.campaign.splitDigest !== stateless.campaign.splitDigest) {
    throw new Error('cannot compare memory learning: stateful and stateless task identities differ')
  }
  if (stateful.campaign.reps !== stateless.campaign.reps) {
    throw new Error(
      `cannot compare memory learning: repetitions differ (${stateful.campaign.reps} vs ${stateless.campaign.reps})`,
    )
  }
  if (stateful.campaign.seed !== stateless.campaign.seed) {
    throw new Error(
      `cannot compare memory learning: campaign seeds differ (${stateful.campaign.seed} vs ${stateless.campaign.seed})`,
    )
  }
  if (
    JSON.stringify(stateful.candidateRefs) !== JSON.stringify(stateless.candidateRefs) ||
    stateful.candidateRefs.length === 0
  ) {
    throw new Error('cannot compare memory learning: candidate references differ between arms')
  }
  const candidateIds = new Set<string>()
  for (const candidate of stateful.candidateRefs) {
    assertNonEmpty(candidate.id, 'candidate reference id')
    if (candidateIds.has(candidate.id)) {
      throw new Error(
        `cannot compare memory learning: duplicate candidate reference ${candidate.id}`,
      )
    }
    candidateIds.add(candidate.id)
    try {
      assertImmutableRef(candidate.ref, `${candidate.id}: candidate reference`)
    } catch (error) {
      throw new Error(
        `cannot compare memory learning: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (stateful.executionRef !== stateless.executionRef) {
    throw new Error('cannot compare memory learning: executor references differ between arms')
  }
  if (stateful.executionRef !== 'fixtures') {
    try {
      assertImmutableRef(stateful.executionRef, 'memory learning executor reference')
    } catch (error) {
      throw new Error(
        `cannot compare memory learning: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

function assertRunSplitIdentity(
  arm: 'stateful' | 'stateless',
  result: RunAgentMemoryExperimentResult,
): void {
  try {
    assertCampaignSplitIdentity(
      result.campaign.scenarios,
      result.campaign.reps,
      result.campaign.splitDigest,
    )
  } catch (error) {
    throw new Error(
      `cannot compare memory learning: ${arm} run has invalid task identity: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function indexCompleteCells(
  arm: 'stateful' | 'stateless',
  result: RunAgentMemoryExperimentResult,
): Map<string, IndexedMemoryLearningCell> {
  const expectedCellIds = new Set(
    result.campaign.scenarios.flatMap((scenario) =>
      Array.from({ length: result.campaign.reps }, (_, rep) => `${scenario.id}:${rep}`),
    ),
  )
  const byIdentity = new Map<string, IndexedMemoryLearningCell>()
  const seenCellIds = new Set<string>()
  for (const cell of result.campaign.cells) {
    if (!expectedCellIds.has(cell.cellId)) {
      throw new Error(
        `cannot compare memory learning: ${arm} run has unexpected cell ${cell.cellId}`,
      )
    }
    if (seenCellIds.has(cell.cellId)) {
      throw new Error(`cannot compare memory learning: ${arm} run duplicates cell ${cell.cellId}`)
    }
    seenCellIds.add(cell.cellId)
    if (cell.cellId !== `${cell.scenarioId}:${cell.rep}`) {
      throw new Error(
        `cannot compare memory learning: ${arm} cell ${cell.cellId} does not match its scenario and repetition`,
      )
    }
    if (cell.manifestHash !== result.campaign.manifestHash) {
      throw new Error(
        `cannot compare memory learning: ${arm} cell ${cell.cellId} manifest differs from its campaign`,
      )
    }
    if (cell.error) {
      throw new Error(
        `cannot compare memory learning: ${arm} cell ${cell.cellId} failed: ${cell.error}`,
      )
    }
    const artifact = cell.artifact as AgentMemorySequenceArtifact | null | undefined
    if (!artifact) {
      throw new Error(`cannot compare memory learning: ${arm} cell ${cell.cellId} has no artifact`)
    }
    assertArtifactIdentity(arm, result, cell, artifact)
    if (!Number.isSafeInteger(cell.rep) || cell.rep < 0 || cell.rep >= result.campaign.reps) {
      throw new Error(`cannot compare memory learning: ${arm} cell ${cell.cellId} has invalid rep`)
    }
    if (!Number.isSafeInteger(cell.seed)) {
      throw new Error(`cannot compare memory learning: ${arm} cell ${cell.cellId} has invalid seed`)
    }
    assertReward(artifact.score, `${arm} cell ${cell.cellId} reward`)
    if (artifact.probes.length === 0) {
      throw new Error(`cannot compare memory learning: ${arm} cell ${cell.cellId} has no probes`)
    }
    for (const probe of artifact.probes) assertProbe(arm, cell.cellId, probe)
    const probeMean = mean(artifact.probes.map((probe) => probe.score))
    if (Math.abs(probeMean - artifact.score) > 1e-12) {
      throw new Error(
        `cannot compare memory learning: ${arm} cell ${cell.cellId} reward does not equal its probe mean`,
      )
    }
    const identity = cellIdentity(artifact, cell.rep, cell.seed)
    if (byIdentity.has(identity)) {
      throw new Error(`cannot compare memory learning: ${arm} run duplicates identity ${identity}`)
    }
    byIdentity.set(identity, { cell, artifact, artifactRef: canonicalDigest(artifact) })
  }
  const missing = [...expectedCellIds].filter((cellId) => !seenCellIds.has(cellId))
  if (missing.length > 0) {
    throw new Error(
      `cannot compare memory learning: ${arm} run is missing cells ${missing.sort().join(', ')}`,
    )
  }
  return byIdentity
}

function assertArtifactIdentity(
  arm: 'stateful' | 'stateless',
  result: RunAgentMemoryExperimentResult,
  cell: CampaignCellResult<AgentMemorySequenceArtifact>,
  artifact: AgentMemorySequenceArtifact,
): void {
  assertNonEmpty(artifact.candidateId, `${arm} cell ${cell.cellId} candidateId`)
  assertNonEmpty(artifact.sequenceId, `${arm} cell ${cell.cellId} sequenceId`)
  if (!result.candidateRefs.some((candidate) => candidate.id === artifact.candidateId)) {
    throw new Error(
      `cannot compare memory learning: ${arm} cell ${cell.cellId} uses an undeclared candidate`,
    )
  }
  if (artifact.memoryMode !== arm) {
    throw new Error(
      `cannot compare memory learning: ${arm} cell ${cell.cellId} artifact is labeled ${String(artifact.memoryMode)}`,
    )
  }
  if (artifact.comparisonRef !== result.comparisonRef) {
    throw new Error(
      `cannot compare memory learning: ${arm} cell ${cell.cellId} comparisonRef differs from its run`,
    )
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(artifact.branchDigest)) {
    throw new Error(
      `cannot compare memory learning: ${arm} cell ${cell.cellId} has invalid branch evidence`,
    )
  }
  const expectedScenarioId = `${stableId('candidate', artifact.candidateId)}:${artifact.sequenceId}`
  if (cell.scenarioId !== expectedScenarioId) {
    throw new Error(
      `cannot compare memory learning: ${arm} cell ${cell.cellId} artifact identity does not match its scenario`,
    )
  }
}

function pairProbes(
  stateful: IndexedMemoryLearningCell,
  stateless: IndexedMemoryLearningCell,
): PairedMemoryLearningProbe[] {
  const statefulProbes = indexProbes('stateful', stateful)
  const statelessProbes = indexProbes('stateless', stateless)
  assertSameKeys(statefulProbes, statelessProbes, `probe in cell ${stateful.cell.cellId}`)
  return [...statefulProbes.entries()]
    .map(([key, statefulProbe]): PairedMemoryLearningProbe => {
      const statelessProbe = statelessProbes.get(key)
      if (!statelessProbe) {
        throw new Error(
          `cannot compare memory learning: missing stateless probe ${key} in ${stateful.cell.cellId}`,
        )
      }
      if (statefulProbe.query !== statelessProbe.query) {
        throw new Error(
          `cannot compare memory learning: probe query differs for ${key} in ${stateful.cell.cellId}`,
        )
      }
      if (statefulProbe.retentionKey !== statelessProbe.retentionKey) {
        throw new Error(
          `cannot compare memory learning: retention identity differs for ${key} in ${stateful.cell.cellId}`,
        )
      }
      if (statefulProbe.transferKey !== statelessProbe.transferKey) {
        throw new Error(
          `cannot compare memory learning: transfer identity differs for ${key} in ${stateful.cell.cellId}`,
        )
      }
      if (
        sortedUnique(statefulProbe.applicableDimensions).join('\0') !==
        sortedUnique(statelessProbe.applicableDimensions).join('\0')
      ) {
        throw new Error(
          `cannot compare memory learning: measured dimensions differ for ${key} in ${stateful.cell.cellId}`,
        )
      }
      return { stateful: statefulProbe, stateless: statelessProbe }
    })
    .sort((left, right) =>
      left.stateful.stepOrdinal !== right.stateful.stepOrdinal
        ? left.stateful.stepOrdinal - right.stateful.stepOrdinal
        : left.stateful.id.localeCompare(right.stateful.id),
    )
}

function indexProbes(
  arm: 'stateful' | 'stateless',
  indexed: IndexedMemoryLearningCell,
): Map<string, AgentMemorySequenceProbeResult> {
  const probes = new Map<string, AgentMemorySequenceProbeResult>()
  for (const probe of indexed.artifact.probes) {
    const key = probeIdentity(probe)
    if (probes.has(key)) {
      throw new Error(
        `cannot compare memory learning: ${arm} cell ${indexed.cell.cellId} duplicates probe ${key}`,
      )
    }
    probes.set(key, probe)
  }
  return probes
}

function assertProbe(
  arm: 'stateful' | 'stateless',
  cellId: string,
  probe: AgentMemorySequenceProbeResult,
): void {
  assertNonEmpty(probe.id, `${arm} cell ${cellId} probe id`)
  assertNonEmpty(probe.stepId, `${arm} cell ${cellId} probe ${probe.id} stepId`)
  assertNonEmpty(probe.query, `${arm} cell ${cellId} probe ${probe.id} query`)
  if (!Number.isSafeInteger(probe.stepOrdinal) || probe.stepOrdinal < 0) {
    throw new Error(
      `cannot compare memory learning: ${arm} cell ${cellId} probe ${probe.id} has invalid stepOrdinal`,
    )
  }
  if (probe.retentionKey !== undefined) {
    assertNonEmpty(probe.retentionKey, `${arm} cell ${cellId} probe ${probe.id} retentionKey`)
    if (probe.retentionKey !== probe.retentionKey.trim()) {
      throw new Error(
        `cannot compare memory learning: ${arm} cell ${cellId} probe ${probe.id} retentionKey has surrounding whitespace`,
      )
    }
  }
  if (probe.transferKey !== undefined) {
    assertNonEmpty(probe.transferKey, `${arm} cell ${cellId} probe ${probe.id} transferKey`)
    if (probe.transferKey !== probe.transferKey.trim()) {
      throw new Error(
        `cannot compare memory learning: ${arm} cell ${cellId} probe ${probe.id} transferKey has surrounding whitespace`,
      )
    }
    if (probe.retentionKey !== undefined || probe.stepOrdinal === 0) {
      throw new Error(
        `cannot compare memory learning: ${arm} cell ${cellId} probe ${probe.id} has invalid transfer placement`,
      )
    }
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(probe.evidenceRef)) {
    throw new Error(
      `cannot compare memory learning: ${arm} cell ${cellId} probe ${probe.id} has invalid evidence`,
    )
  }
  const expectedEvidenceSuffix = `/memory-evidence/${probe.evidenceRef.slice(7)}.json`
  if (!probe.evidencePath.endsWith(expectedEvidenceSuffix)) {
    throw new Error(
      `cannot compare memory learning: ${arm} cell ${cellId} probe ${probe.id} evidence is missing`,
    )
  }
  assertReward(probe.score, `${arm} cell ${cellId} probe ${probe.id} reward`)
}

function assertReward(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`cannot compare memory learning: ${label} must be finite and between 0 and 1`)
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`cannot compare memory learning: ${label} must be a non-empty string`)
  }
}

function assertSameKeys<T>(left: Map<string, T>, right: Map<string, T>, label: string): void {
  const missingRight = [...left.keys()].filter((key) => !right.has(key))
  const missingLeft = [...right.keys()].filter((key) => !left.has(key))
  if (missingRight.length === 0 && missingLeft.length === 0) return
  throw new Error(
    `cannot compare memory learning: unmatched ${label} identities; stateful-only=${missingRight.sort().join(', ') || 'none'}; stateless-only=${missingLeft.sort().join(', ') || 'none'}`,
  )
}

function cellIdentity(artifact: AgentMemorySequenceArtifact, rep: number, seed: number): string {
  return JSON.stringify([artifact.candidateId, artifact.sequenceId, rep, seed])
}

function probeIdentity(probe: AgentMemorySequenceProbeResult): string {
  return JSON.stringify([probe.stepOrdinal, probe.stepId, probe.id])
}

function comparePairedCells(
  left: PairedMemoryLearningCell,
  right: PairedMemoryLearningCell,
): number {
  return (
    left.stateful.artifact.candidateId.localeCompare(right.stateful.artifact.candidateId) ||
    left.stateful.artifact.sequenceId.localeCompare(right.stateful.artifact.sequenceId) ||
    left.stateful.cell.rep - right.stateful.cell.rep ||
    left.stateful.cell.seed - right.stateful.cell.seed
  )
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}
