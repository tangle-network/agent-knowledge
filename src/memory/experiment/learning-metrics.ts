import { comparePairedArms, type PairedBootstrapResult } from '@tangle-network/agent-eval'
import type { PairedMemoryLearningCell, PairedMemoryLearningProbe } from './learning-pairs'
import { mean } from './metrics'
import type {
  AgentMemoryEvidenceRef,
  AgentMemoryForgettingComparison,
  AgentMemoryLearningCandidateSummary,
  AgentMemoryLearningCellComparison,
  AgentMemoryLearningComparison,
  AgentMemoryTransferCellComparison,
  AgentMemoryTransferStepSummary,
  RunAgentMemoryExperimentResult,
} from './types'

export function measureAgentMemoryLearning(
  paired: readonly PairedMemoryLearningCell[],
  stateful: RunAgentMemoryExperimentResult,
  stateless: RunAgentMemoryExperimentResult,
): AgentMemoryLearningComparison {
  const cells = paired.map(toCellComparison)
  const transferCells = paired.flatMap(toTransferCells)
  const forgettingProbes = paired.flatMap(toForgettingComparisons)
  const gainUnits = collapseLearningCells(cells)
  const forgetting = summarizeForgetting(forgettingProbes, stateful.campaign.seed)
  const preTreatment = measurePreTreatment(paired, stateful.campaign.seed)
  const first = paired[0]
  if (!first) throw new Error('cannot compare memory learning: no paired cells')

  return {
    comparisonRef: stateful.comparisonRef,
    evidence: {
      splitRef: evidenceRef(stateful.campaign.splitDigest, 'task split'),
      statefulManifestRef: evidenceRef(
        stateful.campaign.manifestHash,
        'stateful campaign manifest',
      ),
      statelessManifestRef: evidenceRef(
        stateless.campaign.manifestHash,
        'stateless campaign manifest',
      ),
      statefulRunDir: stateful.campaign.runDir,
      statelessRunDir: stateless.campaign.runDir,
      candidateRefs: stateful.candidateRefs.map((candidate) => ({ ...candidate })),
      executionRef: stateful.executionRef,
    },
    cells,
    preTreatment,
    gain: comparePairedRewards(gainUnits, stateful.campaign.seed, 'overall gain'),
    gainByCandidate: summarizeCandidateGain(cells, stateful.campaign.seed),
    transfer: {
      definition: 'explicit-transfer-probes',
      cells: transferCells,
      byStep: summarizeTransfer(transferCells, stateful.campaign.seed),
    },
    forgetting: {
      definition: 'prior-peak-minus-final',
      probes: forgettingProbes,
      ...forgetting,
    },
  }
}

function measurePreTreatment(
  paired: readonly PairedMemoryLearningCell[],
  seed: number,
): AgentMemoryLearningComparison['preTreatment'] {
  const cells = paired.flatMap((pair) => {
    const probes = pair.probes.filter((probe) => probe.stateful.stepOrdinal === 0)
    if (probes.length === 0) return []
    return [
      {
        sequenceId: pair.stateful.artifact.sequenceId,
        statefulReward: mean(probes.map((probe) => probe.stateful.score)),
        statelessReward: mean(probes.map((probe) => probe.stateless.score)),
        exact: probes.every((probe) => probe.stateful.score === probe.stateless.score),
      },
    ]
  })
  const bySequence = new Map<
    string,
    {
      statefulRewards: number[]
      statelessRewards: number[]
      exact: boolean
    }
  >()
  for (const cell of cells) {
    const unit = bySequence.get(cell.sequenceId) ?? {
      statefulRewards: [],
      statelessRewards: [],
      exact: true,
    }
    unit.statefulRewards.push(cell.statefulReward)
    unit.statelessRewards.push(cell.statelessReward)
    unit.exact &&= cell.exact
    bySequence.set(cell.sequenceId, unit)
  }
  const units = [...bySequence.entries()].map(([sequenceId, unit]) => ({
    pairKey: sequenceId,
    statefulReward: mean(unit.statefulRewards),
    statelessReward: mean(unit.statelessRewards),
    exact: unit.exact,
  }))
  return {
    definition: 'first-step-probes',
    cells: cells.length,
    n: units.length,
    exactMatchRate: units.length === 0 ? null : mean(units.map((unit) => (unit.exact ? 1 : 0))),
    difference:
      units.length === 0 ? null : comparePairedRewards(units, seed, 'pre-treatment difference'),
  }
}

function toCellComparison(pair: PairedMemoryLearningCell): AgentMemoryLearningCellComparison {
  const probes = pair.probes.filter((probe) => probe.stateful.stepOrdinal > 0)
  if (probes.length === 0) {
    throw new Error(
      `cannot compare memory learning: cell ${pair.stateful.cell.cellId} has no probe after the first step`,
    )
  }
  const statefulReward = mean(probes.map((probe) => probe.stateful.score))
  const statelessReward = mean(probes.map((probe) => probe.stateless.score))
  return {
    cellId: pair.stateful.cell.cellId,
    candidateId: pair.stateful.artifact.candidateId,
    sequenceId: pair.stateful.artifact.sequenceId,
    rep: pair.stateful.cell.rep,
    seed: pair.stateful.cell.seed,
    statefulArtifactRef: pair.stateful.artifactRef,
    statelessArtifactRef: pair.stateless.artifactRef,
    probeCount: probes.length,
    statefulReward,
    statelessReward,
    gain: difference(statefulReward, statelessReward),
  }
}

function toTransferCells(pair: PairedMemoryLearningCell): AgentMemoryTransferCellComparison[] {
  const groups = new Map<
    string,
    { stepOrdinal: number; transferKey: string; probes: PairedMemoryLearningProbe[] }
  >()
  for (const probe of pair.probes) {
    const transferKey = probe.stateful.transferKey
    if (transferKey === undefined) continue
    const key = JSON.stringify([probe.stateful.stepOrdinal, transferKey])
    const group = groups.get(key) ?? {
      stepOrdinal: probe.stateful.stepOrdinal,
      transferKey,
      probes: [],
    }
    group.probes.push(probe)
    groups.set(key, group)
  }
  return [...groups.values()]
    .map(({ stepOrdinal, transferKey, probes }) => {
      const stepIds = sortedUnique(probes.map((probe) => probe.stateful.stepId))
      if (stepIds.length !== 1) {
        throw new Error(
          `cannot compare memory learning: step ordinal ${stepOrdinal} maps to multiple step ids in ${pair.stateful.cell.cellId}`,
        )
      }
      const statefulReward = mean(probes.map((probe) => probe.stateful.score))
      const statelessReward = mean(probes.map((probe) => probe.stateless.score))
      return {
        cellId: pair.stateful.cell.cellId,
        candidateId: pair.stateful.artifact.candidateId,
        sequenceId: pair.stateful.artifact.sequenceId,
        rep: pair.stateful.cell.rep,
        seed: pair.stateful.cell.seed,
        stepId: stepIds[0]!,
        stepOrdinal,
        transferKey,
        probeCount: probes.length,
        statefulArtifactRef: pair.stateful.artifactRef,
        statelessArtifactRef: pair.stateless.artifactRef,
        statefulReward,
        statelessReward,
        gain: difference(statefulReward, statelessReward),
      }
    })
    .sort(
      (left, right) =>
        left.stepOrdinal - right.stepOrdinal || left.transferKey.localeCompare(right.transferKey),
    )
}

function toForgettingComparisons(
  pair: PairedMemoryLearningCell,
): AgentMemoryForgettingComparison[] {
  const byRetentionKey = new Map<string, PairedMemoryLearningProbe[]>()
  for (const probe of pair.probes) {
    const retentionKey = probe.stateful.retentionKey
    if (retentionKey === undefined) continue
    const probes = byRetentionKey.get(retentionKey) ?? []
    probes.push(probe)
    byRetentionKey.set(retentionKey, probes)
  }
  return [...byRetentionKey.entries()]
    .map(([retentionKey, observations]) => {
      observations.sort((left, right) => left.stateful.stepOrdinal - right.stateful.stepOrdinal)
      if (observations.length < 2) {
        throw new Error(
          `cannot compare memory learning: retention key ${retentionKey} in ${pair.stateful.cell.cellId} has fewer than two observations`,
        )
      }
      const ordinals = observations.map((probe) => probe.stateful.stepOrdinal)
      if (new Set(ordinals).size !== ordinals.length) {
        throw new Error(
          `cannot compare memory learning: retention key ${retentionKey} in ${pair.stateful.cell.cellId} repeats within one step`,
        )
      }
      const final = observations[observations.length - 1]!
      const prior = observations.slice(0, -1)
      const statefulPeak = maxProbe(prior, (probe) => probe.stateful.score)
      const statelessPeak = maxProbe(prior, (probe) => probe.stateless.score)
      const statefulForgetting = difference(statefulPeak.reward, final.stateful.score)
      const statelessForgetting = difference(statelessPeak.reward, final.stateless.score)
      return {
        cellId: pair.stateful.cell.cellId,
        candidateId: pair.stateful.artifact.candidateId,
        sequenceId: pair.stateful.artifact.sequenceId,
        rep: pair.stateful.cell.rep,
        seed: pair.stateful.cell.seed,
        retentionKey,
        observations: observations.length,
        firstStepOrdinal: observations[0]!.stateful.stepOrdinal,
        finalStepOrdinal: final.stateful.stepOrdinal,
        statefulArtifactRef: pair.stateful.artifactRef,
        statelessArtifactRef: pair.stateless.artifactRef,
        statefulPriorPeakReward: statefulPeak.reward,
        statefulPriorPeakStepOrdinal: statefulPeak.stepOrdinal,
        statefulFinalReward: final.stateful.score,
        statefulForgetting,
        statelessPriorPeakReward: statelessPeak.reward,
        statelessPriorPeakStepOrdinal: statelessPeak.stepOrdinal,
        statelessFinalReward: final.stateless.score,
        statelessForgetting,
        excessForgetting: difference(statefulForgetting, statelessForgetting),
      }
    })
    .sort(
      (left, right) =>
        left.retentionKey.localeCompare(right.retentionKey) ||
        left.sequenceId.localeCompare(right.sequenceId) ||
        left.rep - right.rep ||
        left.seed - right.seed,
    )
}

function summarizeCandidateGain(
  cells: readonly AgentMemoryLearningCellComparison[],
  seed: number,
): AgentMemoryLearningCandidateSummary[] {
  return sortedUnique(cells.map((cell) => cell.candidateId)).map((candidateId) => {
    const units = collapseLearningCells(cells.filter((cell) => cell.candidateId === candidateId))
    return {
      candidateId,
      cells: cells.filter((cell) => cell.candidateId === candidateId).length,
      gain: comparePairedRewards(units, seed, `candidate ${candidateId} gain`),
    }
  })
}

function summarizeTransfer(
  cells: readonly AgentMemoryTransferCellComparison[],
  seed: number,
): AgentMemoryTransferStepSummary[] {
  const groups = new Map<
    string,
    {
      candidateId: string
      transferKey: string
      stepOrdinal: number
      rewardsBySequence: Map<string, { stateful: number[]; stateless: number[] }>
    }
  >()
  for (const cell of cells) {
    const key = JSON.stringify([cell.candidateId, cell.transferKey, cell.stepOrdinal])
    const group = groups.get(key) ?? {
      candidateId: cell.candidateId,
      transferKey: cell.transferKey,
      stepOrdinal: cell.stepOrdinal,
      rewardsBySequence: new Map<
        string,
        {
          stateful: number[]
          stateless: number[]
        }
      >(),
    }
    const rewards = group.rewardsBySequence.get(cell.sequenceId) ?? {
      stateful: [],
      stateless: [],
    }
    rewards.stateful.push(cell.statefulReward)
    rewards.stateless.push(cell.statelessReward)
    group.rewardsBySequence.set(cell.sequenceId, rewards)
    groups.set(key, group)
  }
  return [...groups.values()]
    .sort(
      (left, right) =>
        left.candidateId.localeCompare(right.candidateId) ||
        left.transferKey.localeCompare(right.transferKey) ||
        left.stepOrdinal - right.stepOrdinal,
    )
    .map(({ candidateId, transferKey, stepOrdinal, rewardsBySequence }) => {
      const sequenceRewards = [...rewardsBySequence.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([sequenceId, rewards]) => ({
          pairKey: sequenceId,
          statefulReward: mean(rewards.stateful),
          statelessReward: mean(rewards.stateless),
        }))
      return {
        candidateId,
        transferKey,
        stepOrdinal,
        gain: comparePairedRewards(
          sequenceRewards,
          seed,
          `transfer ${candidateId}:${transferKey}:${stepOrdinal}`,
        ),
      }
    })
}

function collapseLearningCells(
  cells: readonly AgentMemoryLearningCellComparison[],
): Array<{ pairKey: string; statefulReward: number; statelessReward: number }> {
  const bySequence = new Map<string, { statefulRewards: number[]; statelessRewards: number[] }>()
  for (const cell of cells) {
    const unit = bySequence.get(cell.sequenceId) ?? {
      statefulRewards: [],
      statelessRewards: [],
    }
    unit.statefulRewards.push(cell.statefulReward)
    unit.statelessRewards.push(cell.statelessReward)
    bySequence.set(cell.sequenceId, unit)
  }
  return [...bySequence.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sequenceId, unit]) => ({
      pairKey: sequenceId,
      statefulReward: mean(unit.statefulRewards),
      statelessReward: mean(unit.statelessRewards),
    }))
}

function summarizeForgetting(
  probes: readonly AgentMemoryForgettingComparison[],
  seed: number,
): {
  n: number
  meanStatefulForgetting: number | null
  meanStatelessForgetting: number | null
  meanExcessForgetting: number | null
  excess: PairedBootstrapResult | null
} {
  const byTarget = new Map<
    string,
    {
      stateful: number[]
      stateless: number[]
      excess: number[]
    }
  >()
  for (const probe of probes) {
    const key = JSON.stringify([probe.sequenceId, probe.retentionKey])
    const unit = byTarget.get(key) ?? { stateful: [], stateless: [], excess: [] }
    unit.stateful.push(probe.statefulForgetting)
    unit.stateless.push(probe.statelessForgetting)
    unit.excess.push(probe.excessForgetting)
    byTarget.set(key, unit)
  }
  const units = [...byTarget.entries()].map(([pairKey, unit]) => ({
    pairKey,
    statefulReward: mean(unit.stateful),
    statelessReward: mean(unit.stateless),
    excess: mean(unit.excess),
  }))
  return {
    n: units.length,
    meanStatefulForgetting: optionalMean(units.map((unit) => unit.statefulReward)),
    meanStatelessForgetting: optionalMean(units.map((unit) => unit.statelessReward)),
    meanExcessForgetting: optionalMean(units.map((unit) => unit.excess)),
    excess: units.length === 0 ? null : comparePairedRewards(units, seed, 'excess forgetting'),
  }
}

function comparePairedRewards(
  units: readonly {
    pairKey: string
    statefulReward: number
    statelessReward: number
  }[],
  seed: number,
  label: string,
): PairedBootstrapResult {
  const comparison = comparePairedArms(
    units.flatMap((unit) => [
      {
        pairKey: unit.pairKey,
        arm: 'stateless',
        metrics: { reward: unit.statelessReward },
      },
      {
        pairKey: unit.pairKey,
        arm: 'stateful',
        metrics: { reward: unit.statefulReward },
      },
    ]),
    {
      baselineArm: 'stateless',
      treatmentArm: 'stateful',
      metricNames: ['reward'],
      bootstrap: { statistic: 'mean', seed },
    },
  )
  const metric = comparison.metricDeltas[0]
  if (
    comparison.nPairs !== units.length ||
    comparison.nUnpairedBaseline !== 0 ||
    comparison.nUnpairedTreatment !== 0 ||
    !metric ||
    metric.n !== units.length ||
    metric.nMissing !== 0 ||
    !metric.bootstrapCi
  ) {
    throw new Error(`cannot compare memory learning: incomplete paired ${label}`)
  }
  return metric.bootstrapCi
}

function maxProbe(
  probes: readonly PairedMemoryLearningProbe[],
  reward: (probe: PairedMemoryLearningProbe) => number,
): { reward: number; stepOrdinal: number } {
  let best = probes[0]!
  for (const probe of probes.slice(1)) {
    if (reward(probe) > reward(best)) best = probe
  }
  return { reward: reward(best), stepOrdinal: best.stateful.stepOrdinal }
}

function optionalMean(values: readonly number[]): number | null {
  return values.length === 0 ? null : mean(values)
}

function difference(left: number, right: number): number {
  const value = left - right
  return Object.is(value, -0) ? 0 : value
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function evidenceRef(value: unknown, label: string): AgentMemoryEvidenceRef {
  if (typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)) {
    return value as AgentMemoryEvidenceRef
  }
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(
      `cannot compare memory learning: ${label} must be a full lowercase sha256 digest; received ${String(value)}`,
    )
  }
  return `sha256:${value}`
}
