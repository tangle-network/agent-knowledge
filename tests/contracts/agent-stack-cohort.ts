import type { AgentCandidateKnowledgeRef } from '@tangle-network/agent-interface'

import { fromAgentCandidateKnowledgeRef, toAgentCandidateKnowledgeRef } from '../../src/index'

/** The public bridge consumes and returns the canonical Interface candidate type. */
export function roundTripCanonicalKnowledgeCandidate(
  candidate: AgentCandidateKnowledgeRef,
): AgentCandidateKnowledgeRef {
  return toAgentCandidateKnowledgeRef(fromAgentCandidateKnowledgeRef(candidate))
}
