import type { OptimizationMethod, Scenario } from '@tangle-network/agent-eval/campaign'

export function fixedOptimizationMethod<TScenario extends Scenario, TArtifact>(
  winnerSurface: string,
  name = 'fixture-fixed',
): OptimizationMethod<TScenario, TArtifact> {
  return {
    name,
    async optimize() {
      return {
        winnerSurface,
        cost: { totalCostUsd: 0, accountingComplete: true, incompleteReasons: [] },
      }
    },
  }
}
