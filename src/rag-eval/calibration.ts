import { contentHash } from '@tangle-network/agent-eval'
import { assertImmutableRef } from '../immutable-ref'
import type { RagAnswerQualityResult, RagGapFinding } from '../rag-improvement-loop'
import type {
  RagAnswerMetricSummary,
  RagAnswerQualityHookOptions,
  RagCalibrationOptions,
  RagCalibrationResult,
} from './contracts'
import { aggregateRagAnswerMetrics, ragAnswerQualityJudge, scoreRagAnswerArtifact } from './scoring'

export function createRagAnswerQualityHook(
  options: RagAnswerQualityHookOptions,
): () => Promise<RagAnswerQualityResult> {
  assertImmutableRef(options.evaluatorRef, 'RAG answer evaluatorRef')
  const finalScenarioIds = options.scenarios.map((scenario) => scenario.id)
  if (
    finalScenarioIds.length < 2 ||
    new Set(finalScenarioIds).size !== finalScenarioIds.length ||
    finalScenarioIds.some((id) => !id.trim())
  ) {
    throw new Error('RAG answer quality requires at least 2 unique final scenarios')
  }
  const datasetRef = `sha256:${contentHash(options.scenarios)}`
  return async () => {
    const summaries: RagAnswerMetricSummary[] = []
    const findings: RagGapFinding[] = []
    for (const scenario of options.scenarios) {
      const initialArtifact = await options.run(scenario)
      const external = await options.externalEvaluator?.({ scenario, artifact: initialArtifact })
      const artifact = external
        ? {
            ...initialArtifact,
            externalScores: [
              ...(initialArtifact.externalScores ?? []),
              ...(Array.isArray(external) ? external : [external]),
            ],
          }
        : initialArtifact
      const summary = scoreRagAnswerArtifact(artifact, scenario, {
        thresholds: options.thresholds,
        weights: options.weights,
      })
      summaries.push(summary)
      findings.push(...summary.findings)
    }
    const metrics = aggregateRagAnswerMetrics(summaries)
    const cost =
      typeof options.cost === 'function' ? await options.cost() : structuredClone(options.cost)
    return {
      passed: findings.length === 0,
      metrics,
      finalScenarioIds,
      datasetRef,
      evaluatorRef: options.evaluatorRef,
      cost,
      findings,
      metadata: { scenarioCount: options.scenarios.length },
    }
  }
}

export async function calibrateRagAnswerJudge(
  options: RagCalibrationOptions,
): Promise<RagCalibrationResult> {
  const judge = options.judge ?? ragAnswerQualityJudge()
  const strong = await judge.score({
    artifact: options.strong,
    scenario: options.scenario,
    signal: options.signal ?? new AbortController().signal,
  })
  const weak = await judge.score({
    artifact: options.weak,
    scenario: options.scenario,
    signal: options.signal ?? new AbortController().signal,
  })
  const strongScore = strong.composite
  const weakScore = weak.composite
  const minStrongScore = options.minStrongScore ?? 0.7
  const maxWeakScore = options.maxWeakScore ?? 0.3
  return {
    passed: strongScore >= minStrongScore && weakScore <= maxWeakScore,
    strongScore,
    weakScore,
    gap: strongScore - weakScore,
  }
}
