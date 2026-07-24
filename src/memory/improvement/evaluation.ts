import { dirname, join } from 'node:path'
import { canonicalJson } from '@tangle-network/agent-eval'
import {
  type CampaignCostMeter,
  type CampaignStorage,
  type JsonValue,
  surfaceHash,
} from '@tangle-network/agent-eval/campaign'
import { stableId } from '../../ids'
import type { SerializedCandidateCodec } from '../../optimization'
import {
  type AgentMemorySequence,
  type AgentMemorySequenceArtifact,
  runAgentMemoryExperiment,
} from '../experiment'
import { buildCandidate, experimentOptions } from './candidate'
import { memorySequenceFingerprint, parseMemoryConfig, serializeMemoryConfig } from './identity'
import type {
  AgentMemoryFinalEvaluation,
  AgentMemoryFinalPair,
  MemoryConfigScenario,
  OwnedRunLease,
  RunAgentMemoryImprovementOptions,
} from './types'

interface StoredMemoryArtifact {
  surfaceHash: string
  sequenceFingerprint: string
  sequenceId: string
  rep: number
  seed: number
  artifact: AgentMemorySequenceArtifact
}

export function memoryConfigCodec<TConfig extends JsonValue>(
  options: RunAgentMemoryImprovementOptions<TConfig>,
): SerializedCandidateCodec<TConfig> {
  const serializeRaw = options.serializeConfig ?? ((config: TConfig) => canonicalJson(config))
  const parseRaw = options.parseConfig ?? ((surface: string) => JSON.parse(surface) as TConfig)
  return {
    serialize: (config) => serializeMemoryConfig(serializeRaw, config),
    parse: (surface) => parseMemoryConfig(parseRaw, surface),
  }
}

export function memoryConfigScenarios(
  sequences: readonly AgentMemorySequence[],
): MemoryConfigScenario[] {
  return sequences.map(memoryConfigScenario)
}

export async function evaluateMemoryCandidate<TConfig extends JsonValue>(input: {
  options: RunAgentMemoryImprovementOptions<TConfig>
  storage: CampaignStorage
  runDir: string
  lease: OwnedRunLease
  config: TConfig
  surfaceHash: string
  scenario: MemoryConfigScenario
  rep: number
  seed: number
  final: boolean
  cost: CampaignCostMeter
  signal: AbortSignal
}): Promise<AgentMemorySequenceArtifact> {
  await input.lease.assertOwned()
  const artifactPath = memoryArtifactPath(
    input.runDir,
    input.surfaceHash,
    input.scenario,
    input.rep,
    input.seed,
  )
  const stored = readStoredMemoryArtifact(input.storage, artifactPath, {
    surfaceHash: input.surfaceHash,
    scenario: input.scenario,
    rep: input.rep,
    seed: input.seed,
  })
  if (stored) {
    if (input.final) {
      writeStoredMemoryArtifact(
        input.storage,
        memoryFinalArtifactPath(input.runDir, input.surfaceHash, input.scenario, input.rep),
        storedMemoryArtifactRecord(input, stored),
      )
    }
    return stored
  }

  const candidate = await buildCandidate(input.options, input.config, input.surfaceHash)
  const evaluationCostLimit = input.options.maximumEvaluationCostUsd ?? 0
  const evaluationId = stableId(
    'memory_eval',
    canonicalJson({
      surfaceHash: input.surfaceHash,
      sequence: memorySequenceFingerprint(input.scenario.sequence),
      rep: input.rep,
      seed: input.seed,
    }),
  )
  const paid = await input.cost.runPaidCall({
    actor: 'agent-knowledge:memory-config-evaluation',
    model: candidate.ref,
    signal: input.signal,
    maximumCharge: {
      externallyEnforcedMaximumUsd: evaluationCostLimit,
    },
    execute: async () => {
      const experiment = await runAgentMemoryExperiment({
        ...experimentOptions(input.options, input.storage, input.lease),
        experimentId: `${input.options.experimentId}:${evaluationId}`,
        experimentRunId: evaluationId,
        sequences: [input.scenario.sequence],
        candidates: [candidate],
        runDir: join(input.runDir, 'evaluations', evaluationId),
        seed: input.seed,
        reps: 1,
        maxConcurrency: 1,
        costCeiling: evaluationCostLimit,
        costPhase: `memory.config.${input.surfaceHash}`,
      })
      const cell = experiment.campaign.cells[0]
      if (!cell || cell.error || cell.artifact.candidateId !== candidate.id) {
        throw new Error(
          `${input.surfaceHash}/${input.scenario.sequenceId}: memory config evaluation did not complete`,
        )
      }
      const cost = experiment.campaign.aggregates.cost
      return {
        artifact: cell.artifact,
        costUsd: cell.cached ? 0 : experiment.totalCostUsd,
        cost,
      }
    },
    receipt: (value) => ({
      model: candidate.ref,
      inputTokens: value.cost.inputTokens,
      outputTokens: value.cost.outputTokens,
      ...(value.cost.reasoningTokens !== undefined
        ? { reasoningTokens: value.cost.reasoningTokens }
        : {}),
      cachedTokens: value.cost.cachedTokens,
      ...(value.cost.cacheWriteTokens !== undefined
        ? { cacheWriteTokens: value.cost.cacheWriteTokens }
        : {}),
      actualCostUsd: value.costUsd,
      costUnknown: !value.cost.accountingComplete,
      usageUnknown: !value.cost.usageComplete,
    }),
  })
  if (!paid.succeeded) throw paid.error
  await input.lease.assertOwned()
  const record = storedMemoryArtifactRecord(input, paid.value.artifact)
  writeStoredMemoryArtifact(input.storage, artifactPath, record)
  if (input.final) {
    writeStoredMemoryArtifact(
      input.storage,
      memoryFinalArtifactPath(input.runDir, input.surfaceHash, input.scenario, input.rep),
      record,
    )
  }
  return paid.value.artifact
}

export function loadFinalEvaluation<TConfig extends JsonValue>(input: {
  options: RunAgentMemoryImprovementOptions<TConfig>
  storage: CampaignStorage
  runDir: string
  baselineSurfaceHash: string
  winnerSurfaceHash: string
}): AgentMemoryFinalEvaluation {
  const pairs: AgentMemoryFinalPair[] = []
  const reps = input.options.reps ?? 1
  for (const sequence of input.options.finalSequences) {
    const scenario = memoryConfigScenario(sequence)
    for (let rep = 0; rep < reps; rep += 1) {
      const baseline = readStoredMemoryArtifact(
        input.storage,
        memoryFinalArtifactPath(input.runDir, input.baselineSurfaceHash, scenario, rep),
        { surfaceHash: input.baselineSurfaceHash, scenario, rep },
      )
      const winner = readStoredMemoryArtifact(
        input.storage,
        memoryFinalArtifactPath(input.runDir, input.winnerSurfaceHash, scenario, rep),
        { surfaceHash: input.winnerSurfaceHash, scenario, rep },
      )
      if (!baseline || !winner) {
        throw new Error(
          `memory final artifact is missing for sequence '${sequence.id}' repetition ${rep}`,
        )
      }
      pairs.push({ sequenceId: sequence.id, rep, baseline, winner })
    }
  }
  return {
    manifestHash: surfaceHash(
      canonicalJson({
        baselineSurfaceHash: input.baselineSurfaceHash,
        winnerSurfaceHash: input.winnerSurfaceHash,
        pairs,
      }),
    ),
    pairs,
  }
}

export function memoryArtifactPath(
  runDir: string,
  candidateSurfaceHash: string,
  scenario: MemoryConfigScenario,
  rep: number,
  seed: number,
): string {
  return join(
    runDir,
    'memory-config-artifacts',
    candidateSurfaceHash,
    stableId('sequence', scenario.sequenceId),
    `rep-${rep}-${stableId('seed', String(seed))}.json`,
  )
}

function memoryFinalArtifactPath(
  runDir: string,
  candidateSurfaceHash: string,
  scenario: MemoryConfigScenario,
  rep: number,
): string {
  return join(
    runDir,
    'memory-final-artifacts',
    candidateSurfaceHash,
    stableId('sequence', scenario.sequenceId),
    `rep-${rep}.json`,
  )
}

function memoryConfigScenario(sequence: AgentMemorySequence): MemoryConfigScenario {
  return {
    id: sequence.id,
    kind: 'agent-memory-config-search',
    sequenceId: sequence.id,
    sequence,
  }
}

function readStoredMemoryArtifact(
  storage: CampaignStorage,
  path: string,
  expected: {
    surfaceHash: string
    scenario: MemoryConfigScenario
    rep: number
    seed?: number
  },
): AgentMemorySequenceArtifact | undefined {
  const stored = storage.read(path)
  if (stored === undefined) {
    if (storage.exists(path)) throw new Error(`cannot read memory config artifact '${path}'`)
    return undefined
  }
  let record: unknown
  try {
    record = JSON.parse(stored)
  } catch (error) {
    throw new Error(`invalid memory config artifact '${path}'`, { cause: error })
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`invalid memory config artifact '${path}'`)
  }
  const value = record as Partial<StoredMemoryArtifact>
  if (
    !hasExactKeys(record, [
      'surfaceHash',
      'sequenceFingerprint',
      'sequenceId',
      'rep',
      'seed',
      'artifact',
    ]) ||
    value.surfaceHash !== expected.surfaceHash ||
    value.sequenceFingerprint !== memorySequenceFingerprint(expected.scenario.sequence) ||
    value.sequenceId !== expected.scenario.sequenceId ||
    value.rep !== expected.rep ||
    !Number.isSafeInteger(value.seed) ||
    (expected.seed !== undefined && value.seed !== expected.seed)
  ) {
    throw new Error(`memory config artifact '${path}' does not match its evaluation cell`)
  }
  return parseMemoryArtifact(
    value.artifact,
    `memory-config-${expected.surfaceHash}`,
    expected.scenario.sequenceId,
    path,
  )
}

function writeStoredMemoryArtifact(
  storage: CampaignStorage,
  path: string,
  record: StoredMemoryArtifact,
): void {
  const serialized = `${JSON.stringify(record, null, 2)}\n`
  const existing = storage.read(path)
  if (existing !== undefined) {
    if (canonicalJson(JSON.parse(existing)) !== canonicalJson(record)) {
      throw new Error(`memory config artifact '${path}' conflicts with durable content`)
    }
    return
  }
  if (storage.exists(path)) throw new Error(`cannot read memory config artifact '${path}'`)
  storage.ensureDir(dirname(path))
  storage.write(path, serialized)
}

function storedMemoryArtifactRecord(
  input: {
    surfaceHash: string
    scenario: MemoryConfigScenario
    rep: number
    seed: number
  },
  artifact: AgentMemorySequenceArtifact,
): StoredMemoryArtifact {
  return {
    surfaceHash: input.surfaceHash,
    sequenceFingerprint: memorySequenceFingerprint(input.scenario.sequence),
    sequenceId: input.scenario.sequenceId,
    rep: input.rep,
    seed: input.seed,
    artifact,
  }
}

function parseMemoryArtifact(
  value: unknown,
  candidateId: string,
  sequenceId: string,
  path: string,
): AgentMemorySequenceArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`memory config artifact '${path}' has no artifact`)
  }
  const artifact = value as Partial<AgentMemorySequenceArtifact>
  if (
    artifact.candidateId !== candidateId ||
    artifact.sequenceId !== sequenceId ||
    typeof artifact.score !== 'number' ||
    !Number.isFinite(artifact.score) ||
    artifact.score < 0 ||
    artifact.score > 1 ||
    typeof artifact.passed !== 'boolean' ||
    !isFiniteNumberRecord(artifact.dimensions) ||
    !isNonnegativeIntegerRecord(artifact.dimensionSampleCounts) ||
    !Array.isArray(artifact.probes) ||
    typeof artifact.branchDigest !== 'string' ||
    !artifact.branchDigest ||
    typeof artifact.journalEntries !== 'number' ||
    !Number.isSafeInteger(artifact.journalEntries) ||
    artifact.journalEntries < 0 ||
    typeof artifact.durationMs !== 'number' ||
    !Number.isFinite(artifact.durationMs) ||
    artifact.durationMs < 0
  ) {
    throw new Error(`memory config artifact '${path}' is malformed`)
  }
  return artifact as AgentMemorySequenceArtifact
}

function isFiniteNumberRecord(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every((entry) => typeof entry === 'number' && Number.isFinite(entry))
}

function isNonnegativeIntegerRecord(value: unknown): value is Record<string, number> {
  return (
    isFiniteNumberRecord(value) &&
    Object.values(value).every((entry) => Number.isSafeInteger(entry) && entry >= 0)
  )
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && keys.every((key) => expected.includes(key))
}
