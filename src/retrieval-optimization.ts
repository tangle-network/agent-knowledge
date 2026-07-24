import { canonicalJson } from '@tangle-network/agent-eval'
import {
  type CampaignResult,
  campaignMeanComposite,
  costFromLedgerSummary,
  createRunCostLedger,
  fsCampaignStorage,
  type JsonValue,
  type JudgeConfig,
  type OptimizationMethod,
  type OptimizationMethodRunOptions,
  runCampaign,
  surfaceHash,
} from '@tangle-network/agent-eval/campaign'
import {
  jsonObjectCandidateCodec,
  type RunSerializedKnowledgeOptimizationOptions,
  type RunSerializedKnowledgeOptimizationResult,
  runSerializedKnowledgeOptimization,
} from './optimization'
import {
  buildRetrievalEvalDispatch,
  type RetrievalConfig,
  type RetrievalEvalArtifact,
  type RetrievalEvalRetriever,
  type RetrievalEvalScenario,
  type RetrievalMetricWeights,
  retrievalConfigFromSurface,
  retrievalConfigSurface,
  retrievalRecallJudge,
} from './retrieval-eval'
import type { KnowledgeIndex } from './types'

export type RetrievalParameterSearchSpace = Record<string, readonly JsonValue[]>

export interface BuildBoundedRetrievalConfigsOptions {
  baseline: RetrievalConfig
  maxConfigurations?: number
}

export interface BoundedRetrievalConfigMethodOptions {
  name?: string
  configurations?: readonly RetrievalConfig[]
  searchSpace?: RetrievalParameterSearchSpace
  maxConfigurations?: number
  /** Configuration campaigns run in parallel. Default 4. */
  configurationConcurrency?: number
  targetRecall?: number
  runOptions?: OptimizationMethodRunOptions<RetrievalEvalScenario, RetrievalEvalArtifact>
}

type RetrievalOptimizationBaseOptions = Omit<
  RunSerializedKnowledgeOptimizationOptions<
    RetrievalConfig,
    RetrievalEvalScenario,
    RetrievalEvalArtifact
  >,
  | 'baseline'
  | 'method'
  | 'trainScenarios'
  | 'selectionScenarios'
  | 'finalScenarios'
  | 'dispatchCandidate'
  | 'judges'
  | 'codec'
  | 'scenarioFingerprint'
>

export interface RunRetrievalImprovementLoopOptions extends RetrievalOptimizationBaseOptions {
  baseline: RetrievalConfig
  trainScenarios: readonly RetrievalEvalScenario[]
  selectionScenarios: readonly RetrievalEvalScenario[]
  finalScenarios: readonly RetrievalEvalScenario[]
  method?: OptimizationMethod<RetrievalEvalScenario, RetrievalEvalArtifact>
  index?: KnowledgeIndex
  defaultK?: number
  retrieve?: RetrievalEvalRetriever
  configurations?: readonly RetrievalConfig[]
  searchSpace?: RetrievalParameterSearchSpace
  boundedSearch?: Omit<BoundedRetrievalConfigMethodOptions, 'configurations' | 'searchSpace'>
  judges?: readonly JudgeConfig<RetrievalEvalArtifact, RetrievalEvalScenario>[]
  metricWeights?: RetrievalMetricWeights
}

export interface RunRetrievalImprovementLoopResult
  extends RunSerializedKnowledgeOptimizationResult<RetrievalConfig> {
  baselineConfig: RetrievalConfig
  winnerConfig: RetrievalConfig
  trainScenarios: readonly RetrievalEvalScenario[]
  selectionScenarios: readonly RetrievalEvalScenario[]
  finalScenarios: readonly RetrievalEvalScenario[]
  boundedConfigurations?: readonly RetrievalConfig[]
}

export function buildBoundedRetrievalConfigs(
  searchSpace: RetrievalParameterSearchSpace,
  options: BuildBoundedRetrievalConfigsOptions,
): RetrievalConfig[] {
  const maxConfigurations = options.maxConfigurations ?? 128
  if (!Number.isSafeInteger(maxConfigurations) || maxConfigurations <= 0) {
    throw new Error('maxConfigurations must be a positive safe integer')
  }
  const entries = Object.entries(searchSpace).sort(([left], [right]) => left.localeCompare(right))
  if (entries.length === 0) {
    throw new Error('bounded retrieval search requires at least one parameter')
  }
  let total = 1
  for (const [path, values] of entries) {
    assertSafeConfigPath(path)
    if (values.length === 0) {
      throw new Error(`bounded retrieval search parameter '${path}' has no values`)
    }
    total *= values.length
    if (!Number.isSafeInteger(total) || total > maxConfigurations) {
      throw new Error(
        `bounded retrieval search expands to more than ${maxConfigurations} configurations; use an OptimizationMethod for larger spaces`,
      )
    }
  }

  let configurations: RetrievalConfig[] = [structuredClone(options.baseline)]
  for (const [path, values] of entries) {
    configurations = configurations.flatMap((config) =>
      values.map((value) => setConfigPath(config, path, value)),
    )
  }
  const baselineSurface = retrievalConfigSurface(options.baseline)
  const unique = new Map<string, RetrievalConfig>()
  for (const configuration of configurations) {
    const surface = retrievalConfigSurface(configuration)
    if (surface !== baselineSurface) unique.set(surface, configuration)
  }
  return [...unique.values()]
}

/**
 * Exhaustively checks a small, finite retrieval grid through agent-eval.
 * Larger or generative spaces should supply an official OptimizationMethod.
 */
export function boundedRetrievalConfigMethod(
  options: BoundedRetrievalConfigMethodOptions,
): OptimizationMethod<RetrievalEvalScenario, RetrievalEvalArtifact> {
  if (options.configurations && options.searchSpace) {
    throw new Error('bounded retrieval method accepts configurations or searchSpace, not both')
  }
  if (!options.configurations && !options.searchSpace) {
    throw new Error('bounded retrieval method requires configurations or searchSpace')
  }
  const name = options.name ?? 'bounded-retrieval-config-search'
  return {
    name,
    async optimize(input) {
      const baseline = retrievalConfigFromSurface(input.baselineSurface)
      const maxConfigurations = options.maxConfigurations ?? 128
      const configurations = options.configurations
        ? normalizeBoundedConfigurations(options.configurations, baseline, maxConfigurations)
        : buildBoundedRetrievalConfigs(options.searchSpace!, {
            baseline,
            maxConfigurations,
          })
      if (configurations.length === 0) {
        return {
          winnerSurface: input.baselineSurface,
          cost: { totalCostUsd: 0, accountingComplete: true, incompleteReasons: [] },
          durationMs: 0,
        }
      }
      assertTargetRecall(options.targetRecall)
      const concurrency = options.configurationConcurrency ?? 4
      assertConfigurationConcurrency(concurrency)
      const startedAt = Date.now()
      const runOptions = {
        ...input.runOptions,
        ...(options.runOptions ?? {}),
      }
      const storage = runOptions.storage ?? fsCampaignStorage()
      const costLedger = createRunCostLedger({
        storage,
        runDir: `${input.runDir}/bounded-cost`,
        costCeilingUsd: runOptions.costCeiling,
      })
      const surfaces = [
        input.baselineSurface,
        ...configurations.map(retrievalConfigSurface),
      ] as string[]
      let winner: BoundedRetrievalMeasurement | undefined
      for (let offset = 0; offset < surfaces.length; offset += concurrency) {
        const batch = await Promise.all(
          surfaces
            .slice(offset, offset + concurrency)
            .map((surface) =>
              measureBoundedRetrievalSurface(surface, input, runOptions, storage, costLedger),
            ),
        )
        for (const measurement of batch) {
          if (!measurement.complete) continue
          if (!winner || measurement.composite > winner.composite) winner = measurement
        }
        if (
          options.targetRecall !== undefined &&
          winner?.recall !== undefined &&
          winner.recall >= options.targetRecall
        ) {
          break
        }
      }
      if (!winner) {
        throw new Error('bounded retrieval search produced no complete selection measurement')
      }
      return {
        winnerSurface: winner.surface,
        cost: costFromLedgerSummary(costLedger.summary()),
        durationMs: Date.now() - startedAt,
      }
    },
  }
}

export async function runRetrievalImprovementLoop(
  options: RunRetrievalImprovementLoopOptions,
): Promise<RunRetrievalImprovementLoopResult> {
  if (options.method && (options.configurations || options.searchSpace)) {
    throw new Error(
      'runRetrievalImprovementLoop accepts method or bounded configurations, not both',
    )
  }
  const boundedConfigurations = options.method ? undefined : resolveBoundedConfigurations(options)
  const method =
    options.method ??
    boundedRetrievalConfigMethod({
      ...(options.boundedSearch ?? {}),
      ...(options.configurations
        ? { configurations: options.configurations }
        : { searchSpace: options.searchSpace! }),
    })
  const dispatch = buildRetrievalEvalDispatch({
    index: options.index,
    defaultK: options.defaultK,
    retrieve: options.retrieve,
  })
  const {
    baseline,
    trainScenarios,
    selectionScenarios,
    finalScenarios,
    method: _method,
    index: _index,
    defaultK: _defaultK,
    retrieve: _retrieve,
    configurations: _configurations,
    searchSpace: _searchSpace,
    boundedSearch: _boundedSearch,
    judges,
    metricWeights,
    ...runOptions
  } = options
  const result = await runSerializedKnowledgeOptimization({
    ...runOptions,
    baseline,
    method,
    trainScenarios,
    selectionScenarios,
    finalScenarios,
    codec: jsonObjectCandidateCodec<RetrievalConfig>(),
    judges: [...(judges ?? [retrievalRecallJudge({ weights: metricWeights })])],
    scenarioFingerprint: retrievalScenarioFingerprint,
    dispatchCandidate: ({ candidateSurface, scenario, context }) =>
      dispatch(candidateSurface, scenario, context),
  })
  return {
    ...result,
    baselineConfig: result.baseline.value,
    winnerConfig: result.winner.value,
    trainScenarios: [...trainScenarios],
    selectionScenarios: [...selectionScenarios],
    finalScenarios: [...finalScenarios],
    ...(boundedConfigurations ? { boundedConfigurations } : {}),
  }
}

function resolveBoundedConfigurations(
  options: RunRetrievalImprovementLoopOptions,
): RetrievalConfig[] {
  if (options.configurations && options.searchSpace) {
    throw new Error('runRetrievalImprovementLoop accepts configurations or searchSpace, not both')
  }
  if (options.configurations) {
    return normalizeBoundedConfigurations(
      options.configurations,
      options.baseline,
      options.boundedSearch?.maxConfigurations ?? 128,
    )
  }
  if (options.searchSpace) {
    return buildBoundedRetrievalConfigs(options.searchSpace, {
      baseline: options.baseline,
      maxConfigurations: options.boundedSearch?.maxConfigurations,
    })
  }
  throw new Error('runRetrievalImprovementLoop requires method, configurations, or searchSpace')
}

interface BoundedRetrievalMeasurement {
  surface: string
  composite: number
  recall?: number
  complete: boolean
}

async function measureBoundedRetrievalSurface(
  surface: string,
  input: Parameters<
    OptimizationMethod<RetrievalEvalScenario, RetrievalEvalArtifact>['optimize']
  >[0],
  runOptions: OptimizationMethodRunOptions<RetrievalEvalScenario, RetrievalEvalArtifact>,
  storage: ReturnType<typeof fsCampaignStorage>,
  costLedger: ReturnType<typeof createRunCostLedger>,
): Promise<BoundedRetrievalMeasurement> {
  const hash = surfaceHash(surface)
  const campaign = await runCampaign({
    ...runOptions,
    scenarios: [...input.selectionScenarios],
    dispatch: (scenario, context) => input.dispatchWithSurface(surface, scenario, context),
    dispatchRef: `${runOptions.dispatchRef ?? 'bounded-retrieval'}:${hash}`,
    judges: [...input.judges],
    runDir: `${input.runDir}/bounded-candidates/${hash}`,
    seed: input.seed,
    storage,
    costLedger,
    costPhase: `${runOptions.costPhase ?? 'bounded-retrieval'}.${hash}`,
  })
  const recall = campaignDimensionMean(campaign, 'recall')
  return {
    surface,
    composite: campaignMeanComposite(campaign),
    ...(recall !== undefined ? { recall } : {}),
    complete: campaignIsComplete(campaign),
  }
}

function assertTargetRecall(targetRecall: number | undefined): void {
  if (
    targetRecall !== undefined &&
    (!Number.isFinite(targetRecall) || targetRecall < 0 || targetRecall > 1)
  ) {
    throw new Error(`targetRecall must be between 0 and 1, got ${String(targetRecall)}`)
  }
}

function assertConfigurationConcurrency(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('bounded retrieval configurationConcurrency must be a positive safe integer')
  }
}

function campaignIsComplete(
  campaign: CampaignResult<RetrievalEvalArtifact, RetrievalEvalScenario>,
): boolean {
  const expectedCells = campaign.scenarios.length * campaign.reps
  return (
    campaign.cells.length === expectedCells &&
    campaign.cells.every(
      (cell) =>
        !cell.error &&
        Object.values(cell.judgeScores).some(
          (score) => score.composite !== undefined && Number.isFinite(score.composite),
        ),
    )
  )
}

function campaignDimensionMean(
  campaign: CampaignResult<RetrievalEvalArtifact, RetrievalEvalScenario>,
  dimension: string,
): number | undefined {
  const values: number[] = []
  for (const cell of campaign.cells) {
    if (cell.error) continue
    for (const score of Object.values(cell.judgeScores)) {
      const value = score.dimensions[dimension]
      if (value !== undefined && Number.isFinite(value)) values.push(value)
    }
  }
  if (values.length === 0) return undefined
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function normalizeBoundedConfigurations(
  configurations: readonly RetrievalConfig[],
  baseline: RetrievalConfig,
  maxConfigurations: number,
): RetrievalConfig[] {
  if (!Number.isSafeInteger(maxConfigurations) || maxConfigurations <= 0) {
    throw new Error('maxConfigurations must be a positive safe integer')
  }
  if (configurations.length > maxConfigurations) {
    throw new Error(
      `bounded retrieval search received ${configurations.length} configurations, exceeding maxConfigurations=${maxConfigurations}`,
    )
  }
  const baselineSurface = retrievalConfigSurface(baseline)
  const unique = new Map<string, RetrievalConfig>()
  for (const configuration of configurations) {
    const surface = retrievalConfigSurface(configuration)
    if (surface !== baselineSurface) unique.set(surface, structuredClone(configuration))
  }
  return [...unique.values()]
}

function setConfigPath(config: RetrievalConfig, path: string, value: JsonValue): RetrievalConfig {
  assertSafeConfigPath(path)
  const result = structuredClone(config)
  const parts = path.split('.')
  let current: Record<string, JsonValue> = result
  for (const part of parts.slice(0, -1)) {
    const child = current[part]
    if (child !== undefined && !isJsonObject(child)) {
      throw new Error(`retrieval config path '${path}' crosses non-object '${part}'`)
    }
    const next = child ? structuredClone(child) : {}
    current[part] = next
    current = next
  }
  current[parts.at(-1)!] = structuredClone(value)
  return result
}

function assertSafeConfigPath(path: string): void {
  const parts = path.split('.')
  if (
    parts.length === 0 ||
    parts.some(
      (part) =>
        !part ||
        part === '__proto__' ||
        part === 'prototype' ||
        part === 'constructor' ||
        !/^[A-Za-z0-9_-]+$/.test(part),
    )
  ) {
    throw new Error(`unsafe retrieval config path '${path}'`)
  }
}

function retrievalScenarioFingerprint(scenario: RetrievalEvalScenario): string {
  return surfaceHash(
    canonicalJson({
      query: scenario.query,
      expected: scenario.expected,
      k: scenario.k ?? null,
    } as JsonValue),
  )
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
