import type { AgentMemorySequence } from '../experiment'
import { memorySequenceFingerprint } from './identity'
import { DEFAULT_CRITICAL_DIMENSIONS, type RunAgentMemoryImprovementOptions } from './types'

export function assertMemoryImprovementOptions<TConfig>(
  options: RunAgentMemoryImprovementOptions<TConfig>,
): void {
  for (const [name, value] of [
    ['experimentId', options.experimentId],
    ['runDir', options.runDir],
  ] as const) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`memory improvement ${name} must be a non-empty string`)
    }
  }
  if (typeof options.proposer?.kind !== 'string' || !options.proposer.kind.trim()) {
    throw new Error('memory improvement proposer.kind must be a non-empty string')
  }
  if (typeof options.proposer?.propose !== 'function') {
    throw new Error('memory improvement proposer.propose must be a function')
  }
  if (options.governor !== undefined && typeof options.governor.decide !== 'function') {
    throw new Error('memory improvement governor.decide must be a function')
  }
  if (options.activation !== undefined) {
    if (typeof options.activation.ref !== 'string' || !options.activation.ref.trim()) {
      throw new Error('memory improvement activation.ref must be a non-empty string')
    }
    if (typeof options.activation.readCurrent !== 'function') {
      throw new Error('memory improvement activation.readCurrent must be a function')
    }
    if (typeof options.activation.compareAndSet !== 'function') {
      throw new Error('memory improvement activation.compareAndSet must be a function')
    }
  }
  for (const [name, proposer] of Object.entries(options.proposers ?? {})) {
    if (!name.trim()) throw new Error('memory improvement proposer labels must be non-empty')
    if (
      !proposer ||
      typeof proposer.kind !== 'string' ||
      !proposer.kind.trim() ||
      typeof proposer.propose !== 'function'
    ) {
      throw new Error(`memory improvement proposer '${name}' is invalid`)
    }
  }
  if (options.serializeConfig !== undefined && typeof options.serializeConfig !== 'function') {
    throw new Error('memory improvement serializeConfig must be a function')
  }
  if (options.parseConfig !== undefined && typeof options.parseConfig !== 'function') {
    throw new Error('memory improvement parseConfig must be a function')
  }
  if (!Number.isSafeInteger(options.budget.maxSteps) || options.budget.maxSteps < 0) {
    throw new Error('memory improvement budget.maxSteps must be a non-negative safe integer')
  }
  for (const [name, value] of [
    ['populationSize', options.populationSize],
    ['candidateConcurrency', options.candidateConcurrency],
    ['sequenceConcurrency', options.sequenceConcurrency],
    ['reps', options.reps],
    ['maxRecoveryAttempts', options.maxRecoveryAttempts],
    ['maxRecoveryRetriesPerAttempt', options.maxRecoveryRetriesPerAttempt],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`memory improvement ${name} must be a positive safe integer`)
    }
  }
  if (
    options.maxTotalCostUsd !== undefined &&
    (!Number.isFinite(options.maxTotalCostUsd) || options.maxTotalCostUsd < 0)
  ) {
    throw new Error('memory improvement maxTotalCostUsd must be a non-negative finite number')
  }
  if (
    options.activationTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.activationTimeoutMs) || options.activationTimeoutMs <= 0)
  ) {
    throw new Error('memory improvement activationTimeoutMs must be a positive safe integer')
  }
  const tolerance = options.criticalDimensionTolerance
  if (tolerance !== undefined && (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1)) {
    throw new Error('memory improvement criticalDimensionTolerance must be between 0 and 1')
  }
  const minimum = options.minHoldoutScore
  if (minimum !== undefined && (!Number.isFinite(minimum) || minimum < 0 || minimum > 1)) {
    throw new Error('memory improvement minHoldoutScore must be between 0 and 1')
  }
  for (const seed of options.seeds) {
    if (
      typeof seed.track !== 'string' ||
      !seed.track.trim() ||
      typeof seed.proposer !== 'string' ||
      !seed.proposer.trim()
    ) {
      throw new Error('memory improvement seeds require non-empty track and proposer values')
    }
    if (seed.vision !== undefined && (typeof seed.vision !== 'string' || !seed.vision.trim())) {
      throw new Error('memory improvement seed vision must be a non-empty string when provided')
    }
  }
  const dimensions = options.criticalDimensions ?? DEFAULT_CRITICAL_DIMENSIONS
  if (dimensions.some((dimension) => typeof dimension !== 'string' || !dimension.trim())) {
    throw new Error('memory improvement criticalDimensions must contain non-empty names')
  }
  if (new Set(dimensions).size !== dimensions.length) {
    throw new Error('memory improvement criticalDimensions must be unique')
  }
  assertDistinctSequenceContent(options.trainSequences, 'train')
  assertDistinctSequenceContent(options.holdoutSequences, 'holdout')
}

function assertDistinctSequenceContent(
  sequences: readonly AgentMemorySequence[],
  split: string,
): void {
  const idsByFingerprint = new Map<string, string>()
  for (const sequence of sequences) {
    const fingerprint = memorySequenceFingerprint(sequence)
    const prior = idsByFingerprint.get(fingerprint)
    if (prior) {
      throw new Error(
        `memory improvement ${split} histories duplicate content: ${prior}/${sequence.id}`,
      )
    }
    idsByFingerprint.set(fingerprint, sequence.id)
  }
}
