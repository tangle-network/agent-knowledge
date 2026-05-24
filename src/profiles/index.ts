/**
 * @experimental
 *
 * Pre-built `AgentRunSpec` + output adapter + validator bundles for
 * knowledge-focused agent roles. Each preset bundles a sandbox-SDK
 * `AgentProfile`, a task-to-prompt formatter, an output adapter, and a
 * per-task validator constructor — all of the pieces `runLoop` needs to
 * drive a topology around `@tangle-network/agent-runtime/loops`.
 */

export type {
  KnowledgeItem,
  KnowledgeUpdate,
  MultiHarnessResearcherFanoutOptions,
  ResearcherProfileOptions,
  ResearchOutput,
  ResearchSource,
  ResearchTask,
} from './researcher'
export {
  createResearcherValidator,
  multiHarnessResearcherFanout,
  researcherProfile,
} from './researcher'
