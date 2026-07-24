export interface AgentMemoryCostReceipt {
  model: string
  inputTokens: 0
  outputTokens: 0
  actualCostUsd?: number
  costUnknown?: boolean
}

export interface AgentMemoryCostRecorder {
  record(actualCostUsd: number): void
  receipt(externalCallAttempted: boolean): AgentMemoryCostReceipt
}

export function createAgentMemoryCostRecorder(input: {
  candidateRef: string
  maximumCostUsd: number
  operation: string
}): AgentMemoryCostRecorder {
  let observedCostUsd = 0
  let receiptCount = 0

  return {
    record(actualCostUsd) {
      if (!Number.isFinite(actualCostUsd) || actualCostUsd < 0) {
        throw new Error(
          `${input.operation}: observed external cost must be non-negative and finite`,
        )
      }
      const next = observedCostUsd + actualCostUsd
      if (exceedsMaximum(next, input.maximumCostUsd)) {
        throw new Error(
          `${input.operation}: observed external cost ${next} exceeds declared maximum ${input.maximumCostUsd}`,
        )
      }
      observedCostUsd = next
      receiptCount += 1
    },
    receipt(externalCallAttempted) {
      const base = {
        model: input.candidateRef,
        inputTokens: 0 as const,
        outputTokens: 0 as const,
      }
      if (input.maximumCostUsd === 0 || !externalCallAttempted) {
        return { ...base, actualCostUsd: 0 }
      }
      if (receiptCount === 0) {
        return { ...base, costUnknown: true }
      }
      return { ...base, actualCostUsd: observedCostUsd }
    },
  }
}

function exceedsMaximum(actual: number, maximum: number): boolean {
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(maximum)) * 8
  return actual - maximum > tolerance
}
