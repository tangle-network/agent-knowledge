import { canonicalJson } from '@tangle-network/agent-eval'
import {
  type CompareOptimizationMethodsOptions,
  compareOptimizationMethods,
  type DispatchContext,
  type JsonValue,
  type MutableSurface,
  type OptimizationMethod,
  type OptimizationMethodComparison,
  type Scenario,
  surfaceHash,
} from '@tangle-network/agent-eval/campaign'

export interface SerializedCandidateCodec<TCandidate extends JsonValue> {
  serialize(candidate: TCandidate): string
  parse(surface: string): TCandidate
}

export interface SerializedCandidate<TCandidate extends JsonValue> {
  value: TCandidate
  surface: string
  surfaceHash: string
}

type ComparisonOptions<TScenario extends Scenario, TArtifact> = Omit<
  CompareOptimizationMethodsOptions<TScenario, TArtifact>,
  | 'methods'
  | 'baselineSurface'
  | 'trainScenarios'
  | 'selectionScenarios'
  | 'testScenarios'
  | 'dispatchWithSurface'
>

export interface RunSerializedKnowledgeOptimizationOptions<
  TCandidate extends JsonValue,
  TScenario extends Scenario,
  TArtifact,
> extends ComparisonOptions<TScenario, TArtifact> {
  baseline: TCandidate
  method: OptimizationMethod<TScenario, TArtifact>
  trainScenarios: readonly TScenario[]
  selectionScenarios: readonly TScenario[]
  finalScenarios: readonly TScenario[]
  dispatchCandidate(input: {
    candidate: TCandidate
    candidateSurface: string
    candidateSurfaceHash: string
    scenario: TScenario
    context: DispatchContext
  }): Promise<TArtifact>
  codec?: SerializedCandidateCodec<TCandidate>
  /** Detects duplicated cases whose IDs differ within or across data partitions. */
  scenarioFingerprint?: (scenario: TScenario) => string
}

export interface RunSerializedKnowledgeOptimizationResult<TCandidate extends JsonValue> {
  methodName: string
  baseline: SerializedCandidate<TCandidate>
  winner: SerializedCandidate<TCandidate>
  comparison: OptimizationMethodComparison
}

/**
 * Runs one complete agent-eval method over a serialized knowledge candidate.
 * The method receives train and selection data; agent-eval owns final scoring.
 */
export async function runSerializedKnowledgeOptimization<
  TCandidate extends JsonValue,
  TScenario extends Scenario,
  TArtifact,
>(
  options: RunSerializedKnowledgeOptimizationOptions<TCandidate, TScenario, TArtifact>,
): Promise<RunSerializedKnowledgeOptimizationResult<TCandidate>> {
  const codec = options.codec ?? jsonCandidateCodec<TCandidate>()
  const baseline = normalizeCandidate(options.baseline, codec, 'baseline')
  assertPartitionContent(
    options.trainScenarios,
    options.selectionScenarios,
    options.finalScenarios,
    options.scenarioFingerprint ?? scenarioContentFingerprint,
  )

  const method = canonicalCandidateMethod(options.method, codec)
  const {
    baseline: _baseline,
    method: _method,
    trainScenarios,
    selectionScenarios,
    finalScenarios,
    dispatchCandidate,
    codec: _codec,
    scenarioFingerprint: _scenarioFingerprint,
    ...comparisonOptions
  } = options
  const optimizationRunOptions = {
    ...(comparisonOptions.dispatchRef !== undefined
      ? { dispatchRef: comparisonOptions.dispatchRef }
      : {}),
    ...(comparisonOptions.reps !== undefined ? { reps: comparisonOptions.reps } : {}),
    ...(comparisonOptions.resumable !== undefined
      ? { resumable: comparisonOptions.resumable }
      : {}),
    ...(comparisonOptions.labeledStore !== undefined
      ? { labeledStore: comparisonOptions.labeledStore }
      : {}),
    ...(comparisonOptions.captureSource !== undefined
      ? { captureSource: comparisonOptions.captureSource }
      : {}),
    ...(comparisonOptions.captureSourceVersionHash !== undefined
      ? { captureSourceVersionHash: comparisonOptions.captureSourceVersionHash }
      : {}),
    ...(comparisonOptions.maxConcurrency !== undefined
      ? { maxConcurrency: comparisonOptions.maxConcurrency }
      : {}),
    ...(comparisonOptions.dispatchTimeoutMs !== undefined
      ? { dispatchTimeoutMs: comparisonOptions.dispatchTimeoutMs }
      : {}),
    ...(comparisonOptions.repo !== undefined ? { repo: comparisonOptions.repo } : {}),
    ...(comparisonOptions.tracing !== undefined ? { tracing: comparisonOptions.tracing } : {}),
    ...(comparisonOptions.expectUsage !== undefined
      ? { expectUsage: comparisonOptions.expectUsage }
      : {}),
    ...(comparisonOptions.now !== undefined ? { now: comparisonOptions.now } : {}),
    ...(comparisonOptions.buildTraceWriter !== undefined
      ? { buildTraceWriter: comparisonOptions.buildTraceWriter }
      : {}),
    ...(comparisonOptions.storage !== undefined ? { storage: comparisonOptions.storage } : {}),
    ...(comparisonOptions.cellPlacement !== undefined
      ? { cellPlacement: comparisonOptions.cellPlacement }
      : {}),
    ...(comparisonOptions.optimizationRunOptions ?? {}),
  }
  const comparison = await compareOptimizationMethods<TScenario, TArtifact>({
    ...comparisonOptions,
    optimizationRunOptions,
    methods: [method],
    baselineSurface: baseline.surface,
    trainScenarios: trainScenarios.map((scenario) => structuredClone(scenario)),
    selectionScenarios: selectionScenarios.map((scenario) => structuredClone(scenario)),
    testScenarios: finalScenarios.map((scenario) => structuredClone(scenario)),
    dispatchWithSurface: async (surface, scenario, context) => {
      const candidate = normalizeSurface(surface, codec, 'candidate')
      return dispatchCandidate({
        candidate: structuredClone(candidate.value),
        candidateSurface: candidate.surface,
        candidateSurfaceHash: candidate.surfaceHash,
        scenario,
        context,
      })
    },
  })
  const winner = normalizeSurface(comparison.best.winnerSurface, codec, 'winner')
  return {
    methodName: options.method.name,
    baseline,
    winner,
    comparison,
  }
}

export function jsonCandidateCodec<
  TCandidate extends JsonValue,
>(): SerializedCandidateCodec<TCandidate> {
  return {
    serialize: (candidate) => canonicalJson(candidate),
    parse(surface) {
      let parsed: unknown
      try {
        parsed = JSON.parse(surface)
      } catch (error) {
        throw new Error('serialized knowledge candidate is not valid JSON', { cause: error })
      }
      return parsed as TCandidate
    },
  }
}

export function jsonObjectCandidateCodec<
  TCandidate extends Record<string, JsonValue>,
>(): SerializedCandidateCodec<TCandidate> {
  const codec = jsonCandidateCodec<TCandidate>()
  return {
    serialize: codec.serialize,
    parse(surface) {
      const candidate = codec.parse(surface)
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new Error('serialized knowledge candidate must be a JSON object')
      }
      return candidate
    },
  }
}

export function scenarioContentFingerprint(scenario: Scenario): string {
  const {
    id: _id,
    tags: _tags,
    split: _split,
    splitTag: _splitTag,
    ...content
  } = scenario as Scenario & { split?: unknown; splitTag?: unknown }
  return surfaceHash(canonicalJson(content as JsonValue))
}

function canonicalCandidateMethod<
  TCandidate extends JsonValue,
  TScenario extends Scenario,
  TArtifact,
>(
  method: OptimizationMethod<TScenario, TArtifact>,
  codec: SerializedCandidateCodec<TCandidate>,
): OptimizationMethod<TScenario, TArtifact> {
  return {
    name: method.name,
    async optimize(input) {
      const result = await method.optimize(input)
      const winner = normalizeSurface(result.winnerSurface, codec, `${method.name} winner`)
      return {
        ...result,
        winnerSurface: winner.surface,
      }
    },
  }
}

function normalizeCandidate<TCandidate extends JsonValue>(
  candidate: TCandidate,
  codec: SerializedCandidateCodec<TCandidate>,
  label: string,
): SerializedCandidate<TCandidate> {
  let surface: string
  try {
    surface = codec.serialize(candidate)
  } catch (error) {
    throw new Error(`${label} serializer failed`, { cause: error })
  }
  return normalizeSurface(surface, codec, label)
}

function normalizeSurface<TCandidate extends JsonValue>(
  surface: MutableSurface,
  codec: SerializedCandidateCodec<TCandidate>,
  label: string,
): SerializedCandidate<TCandidate> {
  if (typeof surface !== 'string' || surface.trim().length === 0) {
    throw new Error(`${label} must be a non-empty serialized string`)
  }
  let value: TCandidate
  try {
    value = codec.parse(surface)
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : ''
    throw new Error(`${label} parser failed${detail}`, { cause: error })
  }
  let canonicalSurface: string
  try {
    canonicalSurface = codec.serialize(value)
  } catch (error) {
    throw new Error(`${label} serializer failed after parsing`, { cause: error })
  }
  if (typeof canonicalSurface !== 'string' || canonicalSurface.trim().length === 0) {
    throw new Error(`${label} serializer must return a non-empty string`)
  }
  const roundTrip = codec.serialize(codec.parse(canonicalSurface))
  if (roundTrip !== canonicalSurface) {
    throw new Error(`${label} codec must round-trip to one canonical surface`)
  }
  return {
    value: structuredClone(value),
    surface: canonicalSurface,
    surfaceHash: surfaceHash(canonicalSurface),
  }
}

function assertPartitionContent<TScenario extends Scenario>(
  train: readonly TScenario[],
  selection: readonly TScenario[],
  final: readonly TScenario[],
  fingerprint: ((scenario: TScenario) => string) | undefined,
): void {
  if (!fingerprint) return
  const owner = new Map<string, { partition: string; scenarioId: string }>()
  for (const [name, scenarios] of [
    ['train', train],
    ['selection', selection],
    ['final', final],
  ] as const) {
    for (const scenario of scenarios) {
      const identity = fingerprint(scenario)
      if (typeof identity !== 'string' || identity.trim().length === 0) {
        throw new Error(`scenarioFingerprint returned no identity for '${scenario.id}'`)
      }
      const prior = owner.get(identity)
      if (prior) {
        const scope =
          prior.partition === name
            ? `${name} partition duplicates`
            : `${prior.partition}/${name} partitions duplicate`
        throw new Error(
          `serialized knowledge optimization ${scope} scenario content at '${prior.scenarioId}'/'${scenario.id}'`,
        )
      }
      owner.set(identity, { partition: name, scenarioId: scenario.id })
    }
  }
}
