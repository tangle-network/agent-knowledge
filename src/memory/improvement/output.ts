import type { CampaignStorage } from '@tangle-network/agent-eval/campaign'
import type { AgentCandidateJsonValue as JsonValue } from '@tangle-network/agent-interface'
import type { RunAgentMemoryImprovementResult } from './types'

export function writeMemoryImprovementResult<TConfig extends JsonValue>(
  storage: CampaignStorage,
  experimentId: string,
  result: RunAgentMemoryImprovementResult<TConfig>,
): void {
  storage.write(
    result.resultJsonPath,
    `${JSON.stringify(
      {
        experimentId,
        baselineSurfaceHash: result.baselineSurfaceHash,
        winnerSurfaceHash: result.winnerSurfaceHash,
        baselineSurface: result.baselineSurface,
        winnerSurface: result.winnerSurface,
        decision: result.decision,
        method: result.optimization.methodName,
        comparison: result.optimization.comparison,
        finalEvaluation: result.finalEvaluation,
        activation: result.activation,
        totalCostUsd: result.totalCostUsd,
      },
      null,
      2,
    )}\n`,
  )
}
