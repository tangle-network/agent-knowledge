import type { DispatchContext } from '@tangle-network/agent-eval/campaign'

/** The model a free retrieval's receipt names: no model ran. */
const FREE_RETRIEVAL_MODEL = 'agent-knowledge:local-search'

/**
 * Run a retrieval that cannot spend money, such as an in-process or local
 * filesystem search, as a known $0 call on the cell's ledger, so the campaign
 * reports its cost as an observed zero instead of unknown.
 */
export async function recordFreeRetrieval<T>(
  context: DispatchContext,
  actor: string,
  retrieve: () => T | Promise<T>,
): Promise<T> {
  const call = await context.cost.runPaidCall({
    actor,
    model: FREE_RETRIEVAL_MODEL,
    maximumCharge: { externallyEnforcedMaximumUsd: 0 },
    execute: async () => retrieve(),
    receipt: () => ({
      model: FREE_RETRIEVAL_MODEL,
      inputTokens: 0,
      outputTokens: 0,
      actualCostUsd: 0,
    }),
  })
  if (!call.succeeded) throw call.error
  return call.value
}
