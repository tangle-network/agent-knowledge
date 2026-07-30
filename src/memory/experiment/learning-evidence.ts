import { canonicalJson } from '@tangle-network/agent-eval'
import { type CampaignStorage, canonicalDigest } from '@tangle-network/agent-eval/campaign'
import { countDimensions, mean, meanDimensions } from './metrics'
import { type AgentMemoryProbeScoringEvidence, scoreAgentMemoryProbe } from './probe-evaluation'
import type {
  AgentMemorySequence,
  AgentMemorySequenceArtifact,
  AgentMemorySequenceProbe,
  AgentMemorySequenceProbeResult,
  AgentMemorySequenceStep,
  RunAgentMemoryExperimentResult,
} from './types'

interface ProbeDefinition {
  step: AgentMemorySequenceStep
  stepOrdinal: number
  probe: AgentMemorySequenceProbe
}

export function assertStoredAgentMemoryEvidence(
  storage: CampaignStorage,
  result: RunAgentMemoryExperimentResult,
  sequences: readonly AgentMemorySequence[],
): void {
  const sequenceById = new Map(sequences.map((sequence) => [sequence.id, sequence]))
  for (const cell of result.campaign.cells) {
    if (cell.error || !cell.artifact) {
      throw new Error(
        `memory learning cell '${cell.cellId}' has no valid artifact${cell.error ? `: ${cell.error}` : ''}`,
      )
    }
    const sequence = sequenceById.get(cell.artifact.sequenceId)
    if (!sequence) {
      throw new Error(
        `memory learning cell '${cell.cellId}' references unknown sequence '${cell.artifact.sequenceId}'`,
      )
    }
    assertStoredCellEvidence(storage, cell.cellId, cell.artifact, sequence)
  }
}

function assertStoredCellEvidence(
  storage: CampaignStorage,
  cellId: string,
  artifact: AgentMemorySequenceArtifact,
  sequence: AgentMemorySequence,
): void {
  const definitions = indexProbeDefinitions(sequence)
  if (artifact.probes.length !== definitions.size) {
    throw new Error(
      `memory learning cell '${cellId}' has ${artifact.probes.length} probes; expected ${definitions.size}`,
    )
  }
  const seen = new Set<string>()
  for (const probe of artifact.probes) {
    const key = probeKey(probe.stepOrdinal, probe.stepId, probe.id)
    const definition = definitions.get(key)
    if (!definition || seen.has(key)) {
      throw new Error(`memory learning cell '${cellId}' has unexpected probe '${key}'`)
    }
    seen.add(key)
    assertStoredProbeEvidence(storage, cellId, probe, definition, sequence)
  }
  const expectedScore = mean(artifact.probes.map((probe) => probe.score))
  const expectedPassed =
    artifact.probes.length > 0 && artifact.probes.every((probe) => probe.passed)
  const expectedDimensions = meanDimensions(artifact.probes.map((probe) => probe.dimensions))
  const expectedCounts = countDimensions(artifact.probes.map((probe) => probe.applicableDimensions))
  if (
    artifact.score !== expectedScore ||
    artifact.passed !== expectedPassed ||
    canonicalJson(artifact.dimensions) !== canonicalJson(expectedDimensions) ||
    canonicalJson(artifact.dimensionSampleCounts) !== canonicalJson(expectedCounts)
  ) {
    throw new Error(`memory learning cell '${cellId}' aggregate does not match its probes`)
  }
}

function assertStoredProbeEvidence(
  storage: CampaignStorage,
  cellId: string,
  observed: AgentMemorySequenceProbeResult,
  definition: ProbeDefinition,
  sequence: AgentMemorySequence,
): void {
  const { probe, step } = definition
  if (
    observed.query !== probe.query ||
    observed.retentionKey !== probe.retentionKey ||
    observed.transferKey !== probe.transferKey
  ) {
    throw new Error(`memory learning cell '${cellId}' probe '${observed.id}' changed definition`)
  }
  const raw = storage.read(observed.evidencePath)
  if (raw === undefined) {
    throw new Error(`memory learning probe evidence is missing at '${observed.evidencePath}'`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`memory learning probe evidence is malformed at '${observed.evidencePath}'`, {
      cause: error,
    })
  }
  if (canonicalDigest(parsed) !== observed.evidenceRef) {
    throw new Error(
      `memory learning probe evidence hash does not match at '${observed.evidencePath}'`,
    )
  }
  const evidence = parseProbeEvidence(parsed, observed.evidencePath)
  const expected = scoreAgentMemoryProbe(sequence, step, probe, evidence)
  const observedEvaluation = {
    score: observed.score,
    passed: observed.passed,
    dimensions: observed.dimensions,
    applicableDimensions: observed.applicableDimensions,
    notes: observed.notes,
  }
  const expectedEvaluation = {
    score: expected.score,
    passed: expected.passed,
    dimensions: expected.dimensions,
    applicableDimensions: expected.applicableDimensions ?? Object.keys(expected.dimensions),
    notes: expected.notes,
  }
  if (canonicalJson(observedEvaluation) !== canonicalJson(expectedEvaluation)) {
    throw new Error(
      `memory learning probe score does not match saved evidence at '${observed.evidencePath}'`,
    )
  }
  if (canonicalJson(observed.hitIds) !== canonicalJson(evidence.usedMemoryIds)) {
    throw new Error(
      `memory learning probe hits do not match saved evidence at '${observed.evidencePath}'`,
    )
  }
}

function indexProbeDefinitions(sequence: AgentMemorySequence): Map<string, ProbeDefinition> {
  const definitions = new Map<string, ProbeDefinition>()
  for (const [stepOrdinal, step] of sequence.steps.entries()) {
    for (const probe of step.probes ?? []) {
      definitions.set(probeKey(stepOrdinal, step.id, probe.id), { step, stepOrdinal, probe })
    }
  }
  return definitions
}

function probeKey(stepOrdinal: number, stepId: string, probeId: string): string {
  return JSON.stringify([stepOrdinal, stepId, probeId])
}

function parseProbeEvidence(value: unknown, path: string): AgentMemoryProbeScoringEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`memory learning probe evidence has invalid shape at '${path}'`)
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.answer !== 'string' ||
    !isStringArray(record.rememberedFacts) ||
    !isStringArray(record.citedEventIds) ||
    !isStringArray(record.usedMemoryIds) ||
    !isStringArray(record.actorIds)
  ) {
    throw new Error(`memory learning probe evidence has invalid shape at '${path}'`)
  }
  return {
    answer: record.answer,
    rememberedFacts: record.rememberedFacts,
    citedEventIds: record.citedEventIds,
    usedMemoryIds: record.usedMemoryIds,
    actorIds: record.actorIds,
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}
