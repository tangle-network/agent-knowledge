/** The measured facts that decide where a candidate places against its peers. */
export interface RankedCandidateFacts {
  candidateId: string
  scoreMean: number
  passRate: number
  cellsFailed: number
  totalCostUsd: number
}

/**
 * Round a US-dollar amount to the precision a cost ledger records.
 *
 * Costs are accumulated by addition, so two runs that spent the same amount
 * can differ in the last bits of the float. Ranking breaks a tie on cost, and
 * without a common precision that float noise decides the order.
 */
export function normalizeUsd(value: number): number {
  return Number(value.toFixed(12))
}

/**
 * Order candidates best-first and stamp each row with the rank it earned.
 *
 * A candidate with a failed cell measured less than it claims to have
 * measured, so it places below every candidate that completed. Among those,
 * the higher mean score wins, then the higher pass rate, then the lower cost.
 * The candidate id breaks the final tie, so ranking the same results twice
 * gives the same order.
 */
export function rankCandidates<Row extends RankedCandidateFacts>(
  rows: readonly Row[],
): (Row & { rank: number })[] {
  return [...rows]
    .sort(
      (a, b) =>
        Number(a.cellsFailed > 0) - Number(b.cellsFailed > 0) ||
        b.scoreMean - a.scoreMean ||
        b.passRate - a.passRate ||
        a.totalCostUsd - b.totalCostUsd ||
        a.candidateId.localeCompare(b.candidateId),
    )
    .map((row, index) => ({ ...row, rank: index + 1 }))
}
