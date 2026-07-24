import type { JsonValue } from '@tangle-network/agent-eval/campaign'
import { assertImmutableRef } from '../../immutable-ref'
import type { AgentMemorySequence } from '../experiment'
import { memorySequenceFingerprint } from './identity'
import { DEFAULT_CRITICAL_DIMENSIONS, type RunAgentMemoryImprovementOptions } from './types'

export function assertMemoryImprovementOptions<TConfig extends JsonValue>(
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
  assertImmutableRef(options.improvementRef, 'memory improvement improvementRef')
  if (
    !options.method ||
    typeof options.method.name !== 'string' ||
    !options.method.name.trim() ||
    typeof options.method.optimize !== 'function'
  ) {
    throw new Error('memory improvement method must be a complete OptimizationMethod')
  }
  if (typeof options.createCandidate !== 'function') {
    throw new Error('memory improvement createCandidate must be a function')
  }
  if (options.activation !== undefined) {
    assertImmutableRef(options.activation.ref, 'memory improvement activation.ref')
    if (typeof options.activation.readCurrent !== 'function') {
      throw new Error('memory improvement activation.readCurrent must be a function')
    }
    if (typeof options.activation.compareAndSet !== 'function') {
      throw new Error('memory improvement activation.compareAndSet must be a function')
    }
  }
  if (options.executeStep) {
    assertImmutableRef(options.executeStepRef, 'memory improvement executeStepRef')
  }
  if (options.serializeConfig !== undefined && typeof options.serializeConfig !== 'function') {
    throw new Error('memory improvement serializeConfig must be a function')
  }
  if (options.parseConfig !== undefined && typeof options.parseConfig !== 'function') {
    throw new Error('memory improvement parseConfig must be a function')
  }
  for (const [name, value] of [
    ['sequenceConcurrency', options.sequenceConcurrency],
    ['reps', options.reps],
    ['maxRecoveryAttempts', options.maxRecoveryAttempts],
    ['maxRecoveryRetriesPerAttempt', options.maxRecoveryRetriesPerAttempt],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`memory improvement ${name} must be a positive safe integer`)
    }
  }
  for (const [name, value] of [
    ['maxOptimizationCostUsd', options.maxOptimizationCostUsd],
    ['maxFinalCostUsd', options.maxFinalCostUsd],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`memory improvement ${name} must be a non-negative finite number`)
    }
  }
  if (
    options.maximumEvaluationCostUsd !== undefined &&
    (!Number.isFinite(options.maximumEvaluationCostUsd) || options.maximumEvaluationCostUsd <= 0)
  ) {
    throw new Error('memory improvement maximumEvaluationCostUsd must be a positive finite number')
  }
  if (
    ((options.maxOptimizationCostUsd ?? 0) > 0 || (options.maxFinalCostUsd ?? 0) > 0) &&
    options.maximumEvaluationCostUsd === undefined
  ) {
    throw new Error(
      'memory improvement maximumEvaluationCostUsd is required when a spend limit is configured',
    )
  }
  if (
    options.allowIncompleteCostAccounting !== undefined &&
    typeof options.allowIncompleteCostAccounting !== 'boolean'
  ) {
    throw new Error('memory improvement allowIncompleteCostAccounting must be boolean')
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
  const minimum = options.minFinalScore
  if (minimum !== undefined && (!Number.isFinite(minimum) || minimum < 0 || minimum > 1)) {
    throw new Error('memory improvement minFinalScore must be between 0 and 1')
  }
  const dimensions = options.criticalDimensions ?? DEFAULT_CRITICAL_DIMENSIONS
  if (dimensions.some((dimension) => typeof dimension !== 'string' || !dimension.trim())) {
    throw new Error('memory improvement criticalDimensions must contain non-empty names')
  }
  if (new Set(dimensions).size !== dimensions.length) {
    throw new Error('memory improvement criticalDimensions must be unique')
  }
  assertIndependentSequences(
    options.trainSequences,
    options.selectionSequences,
    options.finalSequences,
  )
}

function assertIndependentSequences(
  train: readonly AgentMemorySequence[],
  selection: readonly AgentMemorySequence[],
  final: readonly AgentMemorySequence[],
): void {
  if (train.length === 0) throw new Error('memory improvement requires training sequences')
  if (selection.length === 0) throw new Error('memory improvement requires selection sequences')
  if (final.length < 2) {
    throw new Error('memory improvement requires at least 2 final sequences')
  }
  const ids = new Map<string, string>()
  const content = new Map<string, { split: string; sequenceId: string }>()
  for (const [split, sequences] of [
    ['train', train],
    ['selection', selection],
    ['final', final],
  ] as const) {
    for (const sequence of sequences) {
      const priorId = ids.get(sequence.id)
      if (priorId) {
        throw new Error(
          `memory improvement ${priorId}/${split} sequences share id '${sequence.id}'`,
        )
      }
      ids.set(sequence.id, split)
      const fingerprint = memorySequenceFingerprint(sequence)
      const priorContent = content.get(fingerprint)
      if (priorContent) {
        throw new Error(
          `memory improvement ${priorContent.split}/${split} histories duplicate content at '${priorContent.sequenceId}'/'${sequence.id}'`,
        )
      }
      content.set(fingerprint, { split, sequenceId: sequence.id })
    }
  }
}
