import type { CampaignStorage } from '@tangle-network/agent-eval/campaign'
import type { RunAgentMemoryImprovementResult } from './types'

export function writeMemoryImprovementResult<TConfig>(
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
        activation: result.activation,
        totalCostUsd: result.totalCostUsd,
        lineage: result.lineage.toGraph(),
      },
      null,
      2,
    )}\n`,
  )
}
