import { join } from 'node:path'
import { canonicalJson } from '@tangle-network/agent-eval'
import {
  type CampaignStorage,
  type JsonValue,
  surfaceHash,
} from '@tangle-network/agent-eval/campaign'
import type { AgentMemorySequence } from '../experiment'
import { normalizedPromotionPolicy } from './promotion'
import {
  MEMORY_IMPROVEMENT_IMPLEMENTATION_REF,
  type RunAgentMemoryImprovementOptions,
} from './types'

export function assertMemoryImprovementIdentity<TConfig extends JsonValue>(
  options: RunAgentMemoryImprovementOptions<TConfig>,
  storage: CampaignStorage,
  runDir: string,
  serialize: (config: TConfig) => string,
): void {
  const path = join(runDir, 'memory-improvement-manifest.json')
  const identity = {
    schema: 7,
    implementationRef: MEMORY_IMPROVEMENT_IMPLEMENTATION_REF,
    experimentId: options.experimentId,
    improvementRef: options.improvementRef,
    method: options.method.name,
    activationRef: options.activation?.ref ?? null,
    baselineConfig: serialize(options.baselineConfig),
    executeStepRef: options.executeStepRef ?? null,
    cleanupBranches: options.cleanupBranches ?? true,
    promotionPolicy: normalizedPromotionPolicy(options),
    seed: options.seed ?? 42,
    reps: options.reps ?? 1,
    maxOptimizationCostUsd: options.maxOptimizationCostUsd ?? null,
    maxFinalCostUsd: options.maxFinalCostUsd ?? null,
    maximumEvaluationCostUsd: options.maximumEvaluationCostUsd ?? null,
    allowIncompleteCostAccounting: options.allowIncompleteCostAccounting ?? false,
    trainSequences: options.trainSequences,
    selectionSequences: options.selectionSequences,
    finalSequences: options.finalSequences,
  }
  const identityHash = surfaceHash(canonicalJson(identity))
  const stored = storage.read(path)
  if (stored === undefined) {
    if (storage.exists(path)) throw new Error(`cannot read memory improvement manifest '${path}'`)
    if (storage.exists(join(runDir, 'memory-improvement-result.json'))) {
      throw new Error(`memory improvement run '${runDir}' has state without an identity manifest`)
    }
    storage.write(path, `${JSON.stringify({ identityHash, identity }, null, 2)}\n`)
    return
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(stored)
  } catch (error) {
    throw new Error(`invalid memory improvement manifest '${path}'`, { cause: error })
  }
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    (manifest as Record<string, unknown>).identityHash !== identityHash ||
    canonicalJson((manifest as Record<string, unknown>).identity) !== canonicalJson(identity)
  ) {
    throw new Error(
      `memory improvement run '${runDir}' does not match its persisted inputs or improvementRef`,
    )
  }
}

export function serializeMemoryConfig<TConfig extends JsonValue>(
  serialize: (config: TConfig) => string,
  config: TConfig,
): string {
  let surface: unknown
  try {
    surface = serialize(config)
  } catch (error) {
    throw new Error('memory config serializer failed', { cause: error })
  }
  if (typeof surface !== 'string' || surface.trim().length === 0) {
    throw new Error('memory config serializer must return a non-empty string')
  }
  return surface
}

export function parseMemoryConfig<TConfig extends JsonValue>(
  parse: (surface: string) => TConfig,
  surface: string,
): TConfig {
  try {
    const config = parse(surface)
    if (config === undefined) throw new Error('parser returned undefined')
    return config
  } catch (error) {
    throw new Error('memory config surface could not be parsed', { cause: error })
  }
}

export function assertMemoryConfigRoundTrip<TConfig extends JsonValue>(
  config: TConfig,
  serialize: (config: TConfig) => string,
  parse: (surface: string) => TConfig,
): void {
  const first = serialize(config)
  const second = serialize(parse(first))
  if (first !== second) {
    throw new Error('memory config serializer and parser must round-trip exactly')
  }
}

export function memorySequenceFingerprint(sequence: AgentMemorySequence): string {
  const { id: _id, split: _split, tags: _tags, ...content } = sequence
  return surfaceHash(canonicalJson(content))
}
