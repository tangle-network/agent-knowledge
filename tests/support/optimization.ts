import { createHash } from 'node:crypto'
import type { OptimizationMethod, Scenario } from '@tangle-network/agent-eval/campaign'

export function testExecutionRef(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export function fixedOptimizationMethod<TScenario extends Scenario, TArtifact>(
  winnerSurface: string,
  name = 'fixture-fixed',
): OptimizationMethod<TScenario, TArtifact> {
  return {
    name,
    async optimize() {
      return {
        winnerSurface,
        cost: {
          totalCostUsd: 0,
          costProvenance: { kind: 'observed', usd: 0 },
          accountingComplete: true,
          incompleteReasons: [],
        },
      }
    },
  }
}
