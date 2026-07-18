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
    return {
      passed: findings.length === 0,
      metrics,
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
