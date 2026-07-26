import type { CampaignResult } from '@tangle-network/agent-eval/campaign'

import type {
  KnowledgeBenchmarkDistribution,
  KnowledgeBenchmarkReport,
  KnowledgeBenchmarkScenario,
  KnowledgeBenchmarkSliceSummary,
} from './types'

import { formatNumber, mean } from './utils'

export function summarizeKnowledgeBenchmarkCampaign<TArtifact>(input: {
  scenarios: readonly KnowledgeBenchmarkScenario[]
  campaign: CampaignResult<TArtifact, KnowledgeBenchmarkScenario>
}): KnowledgeBenchmarkReport {
  const scenariosById = new Map(input.scenarios.map((scenario) => [scenario.id, scenario]))
  const rows = input.campaign.cells.map((cell) => {
    const score = Object.values(cell.judgeScores)[0]
    const scenario = scenariosById.get(cell.scenarioId)
    return {
      cell,
      scenario,
      composite: score?.composite ?? 0,
      passed: (score?.dimensions.passed ?? 0) >= 1,
      dimensions: score?.dimensions ?? {},
    }
  })
  const successful = rows.filter((row) => !row.cell.error)
  return {
    totalCases: input.scenarios.length,
    totalCells: input.campaign.cells.length,
    cellsFailed: input.campaign.aggregates.cellsFailed,
    cellsCached: input.campaign.aggregates.cellsCached,
    totalCostUsd: input.campaign.aggregates.cost.totalCostUsd,
    bySplit: summarizeSlices(successful, (row) => row.scenario?.splitTag ?? 'unknown'),
    byFamily: summarizeSlices(successful, (row) => row.scenario?.family ?? 'unknown'),
    byTaskKind: summarizeSlices(successful, (row) => row.scenario?.taskKind ?? 'unknown'),
    dimensions: summarizeDimensions(successful.map((row) => row.dimensions)),
    score: distribution(successful.map((row) => row.composite)),
  }
}

function summarizeDimensions(
  rows: Array<Record<string, number>>,
): Record<string, KnowledgeBenchmarkDistribution> {
  const values = new Map<string, number[]>()
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (!Number.isFinite(value)) continue
      const list = values.get(key) ?? []
      list.push(value)
      values.set(key, list)
    }
  }
  return Object.fromEntries([...values.entries()].map(([key, vals]) => [key, distribution(vals)]))
}

function summarizeSlices<T>(
  rows: T[],
  keyOf: (row: T) => string,
): Record<string, KnowledgeBenchmarkSliceSummary> {
  const grouped = new Map<string, T[]>()
  for (const row of rows) {
    const key = keyOf(row)
    const list = grouped.get(key) ?? []
    list.push(row)
    grouped.set(key, list)
  }
  return Object.fromEntries(
    [...grouped.entries()].map(([key, list]) => {
      const withShape = list as Array<{ composite: number; passed: boolean }>
      return [
        key,
        {
          n: list.length,
          meanScore: mean(withShape.map((row) => row.composite)),
          passRate: mean(withShape.map((row) => (row.passed ? 1 : 0))),
          score: distribution(withShape.map((row) => row.composite)),
        },
      ]
    }),
  )
}

function distribution(values: readonly number[]): KnowledgeBenchmarkDistribution {
  const finite = [...values].filter(Number.isFinite).sort((a, b) => a - b)
  if (finite.length === 0) return { n: 0, min: 0, mean: 0, median: 0, p90: 0, max: 0 }
  return {
    n: finite.length,
    min: finite[0]!,
    mean: mean(finite),
    median: percentile(finite, 0.5),
    p90: percentile(finite, 0.9),
    max: finite[finite.length - 1]!,
  }
}

function percentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) return 0
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(p * sortedValues.length) - 1),
  )
  return sortedValues[index]!
}

export function renderSliceTable(slices: Record<string, KnowledgeBenchmarkSliceSummary>): string {
  const rows = Object.entries(slices).map(
    ([key, slice]) =>
      `| ${key} | ${slice.n} | ${formatNumber(slice.meanScore)} | ${formatNumber(slice.passRate)} | ${formatNumber(slice.score.p90)} |`,
  )
  return [
    '| slice | n | mean score | pass rate | score p90 |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...(rows.length ? rows : ['| none | 0 | 0 | 0 | 0 |']),
  ].join('\n')
}
