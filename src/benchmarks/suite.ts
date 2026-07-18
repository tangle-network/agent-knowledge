import { join } from 'node:path'

import { canonicalJson } from '@tangle-network/agent-eval'

import {
  fsCampaignStorage,
  type JudgeConfig,
  type RunCampaignOptions,
  runCampaign,
} from '@tangle-network/agent-eval/campaign'

import { stableId } from '../ids'

import { renderSliceTable, summarizeKnowledgeBenchmarkCampaign } from './metrics'

import { scoreKnowledgeBenchmarkArtifact } from './scoring'

import type {
  KnowledgeBenchmarkArtifact,
  KnowledgeBenchmarkCase,
  KnowledgeBenchmarkReport,
  KnowledgeBenchmarkScenario,
  KnowledgeBenchmarkSplit,
  RunKnowledgeBenchmarkSuiteOptions,
  RunKnowledgeBenchmarkSuiteResult,
} from './types'

import { compactObject, formatNumber, unique } from './utils'

import { assertKnowledgeBenchmarkCases, assertNonEmptyBenchmarkString } from './validation'

const KNOWLEDGE_BENCHMARK_IMPLEMENTATION_REF = 'agent-knowledge:benchmark-suite:v2'

export async function runKnowledgeBenchmarkSuite<TArtifact = KnowledgeBenchmarkArtifact>(
  options: RunKnowledgeBenchmarkSuiteOptions<TArtifact>,
): Promise<RunKnowledgeBenchmarkSuiteResult<TArtifact>> {
  assertKnowledgeBenchmarkCases(options.cases)
  if (options.respondRef !== undefined) {
    assertNonEmptyBenchmarkString(options.respondRef, 'knowledge benchmark respondRef')
  } else if (options.resumable !== false) {
    throw new Error('knowledge benchmark respondRef is required when resumable is enabled')
  }
  const storage = options.storage ?? fsCampaignStorage()
  const costCeiling = options.costCeiling ?? options.costLedger?.costCeilingUsd ?? 0
  if (options.costLedger && options.costLedger.costCeilingUsd !== costCeiling) {
    throw new Error('knowledge benchmark costCeiling must match the shared cost ledger ceiling')
  }
  const scenarios = buildKnowledgeBenchmarkScenarios(options.cases, options.splits)
  const dispatch: RunCampaignOptions<KnowledgeBenchmarkScenario, TArtifact>['dispatch'] = async (
    scenario,
    context,
  ) => {
    const artifact = await options.respond({ case: scenario.case, scenario, context })
    return artifact
  }
  const campaign = await runCampaign<KnowledgeBenchmarkScenario, TArtifact>({
    scenarios,
    dispatch,
    dispatchRef: stableId(
      'knowledge_benchmark',
      canonicalJson({
        implementationRef: KNOWLEDGE_BENCHMARK_IMPLEMENTATION_REF,
        respondRef: options.respondRef ?? 'non-resumable',
      }),
    ),
    judges: [knowledgeBenchmarkJudge<TArtifact>()],
    runDir: options.runDir,
    repo: options.repo,
    seed: options.seed,
    reps: options.reps,
    resumable: options.resumable,
    costCeiling,
    costLedger: options.costLedger,
    costPhase: options.costPhase,
    maxConcurrency: options.maxConcurrency,
    dispatchTimeoutMs: options.dispatchTimeoutMs,
    expectUsage: options.expectUsage ?? 'off',
    storage,
    now: options.now,
  })
  const report = summarizeKnowledgeBenchmarkCampaign({ scenarios, campaign })
  const reportJsonPath = join(campaign.runDir, 'knowledge-benchmark-report.json')
  const reportMarkdownPath = join(campaign.runDir, 'knowledge-benchmark-report.md')
  storage.write(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`)
  storage.write(reportMarkdownPath, renderKnowledgeBenchmarkReportMarkdown(report))
  return {
    scenarios,
    campaign,
    report,
    reportJsonPath,
    reportMarkdownPath,
  }
}

export function renderKnowledgeBenchmarkReportMarkdown(report: KnowledgeBenchmarkReport): string {
  return [
    '# Knowledge Benchmark Report',
    '',
    `- cases: ${report.totalCases}`,
    `- cells: ${report.totalCells} total, ${report.cellsFailed} failed, ${report.cellsCached} cached`,
    `- cost: $${formatNumber(report.totalCostUsd)}`,
    `- score: mean ${formatNumber(report.score.mean)}, median ${formatNumber(report.score.median)}, p90 ${formatNumber(report.score.p90)}, n=${report.score.n}`,
    '',
    '## Task Kinds',
    '',
    renderSliceTable(report.byTaskKind),
    '',
    '## Splits',
    '',
    renderSliceTable(report.bySplit),
    '',
    '## Dimensions',
    '',
    '| dimension | n | mean | p90 |',
    '| --- | ---: | ---: | ---: |',
    ...Object.entries(report.dimensions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([key, dist]) =>
          `| ${key} | ${dist.n} | ${formatNumber(dist.mean)} | ${formatNumber(dist.p90)} |`,
      ),
    '',
  ].join('\n')
}

export function buildKnowledgeBenchmarkScenarios(
  cases: readonly KnowledgeBenchmarkCase[],
  splits?: readonly KnowledgeBenchmarkSplit[],
): KnowledgeBenchmarkScenario[] {
  const splitSet = splits ? new Set(splits) : null
  return cases.flatMap((testCase) => {
    const splitTag = testCase.split ?? 'dev'
    if (splitSet && !splitSet.has(splitTag)) return []
    return [
      compactObject({
        id: testCase.id,
        kind: 'knowledge-benchmark' as const,
        family: testCase.family,
        taskKind: testCase.taskKind,
        splitTag,
        tags: unique([splitTag, ...(testCase.tags ?? [])]),
        case: compactObject(testCase),
      }) as KnowledgeBenchmarkScenario,
    ]
  })
}

export function knowledgeBenchmarkJudge<TArtifact = KnowledgeBenchmarkArtifact>(): JudgeConfig<
  TArtifact,
  KnowledgeBenchmarkScenario
> {
  return {
    name: 'knowledge-benchmark',
    judgeVersion: 'agent-knowledge:knowledge-benchmark:v2',
    dimensions: [
      { key: 'score', description: 'primary knowledge benchmark score' },
      { key: 'passed', description: '1 when the benchmark case passes' },
      { key: 'claim_recall', description: 'required claim coverage' },
      { key: 'citation_recall', description: 'expected citation/source coverage' },
      { key: 'hallucination_safe', description: '1 when no forbidden claim appears' },
      { key: 'memory_fact_recall', description: 'current memory fact coverage' },
      { key: 'memory_event_recall', description: 'expected memory event/source coverage' },
      { key: 'memory_stale_safe', description: '1 when obsolete memory is not reused' },
      { key: 'memory_actor_recall', description: 'expected speaker/user attribution coverage' },
    ],
    appliesTo: (scenario) => scenario.kind === 'knowledge-benchmark',
    score({ artifact, scenario }) {
      const evaluation = scoreKnowledgeBenchmarkArtifact(scenario.case, artifact)
      return {
        dimensions: {
          score: evaluation.score,
          passed: evaluation.passed ? 1 : 0,
          ...evaluation.dimensions,
        },
        composite: evaluation.score,
        notes: evaluation.notes,
      }
    },
  }
}
