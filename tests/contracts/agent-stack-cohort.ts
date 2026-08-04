import type { ExternalOptimizerModelCall } from '@tangle-network/agent-eval/campaign'
import type { AgentCandidateKnowledgeRef } from '@tangle-network/agent-interface'

import { fromAgentCandidateKnowledgeRef, toAgentCandidateKnowledgeRef } from '../../src/index'

/** The public bridge consumes and returns the canonical Interface candidate type. */
export function roundTripCanonicalKnowledgeCandidate(
  candidate: AgentCandidateKnowledgeRef,
): AgentCandidateKnowledgeRef {
  return toAgentCandidateKnowledgeRef(fromAgentCandidateKnowledgeRef(candidate))
}

/** The installed Eval cohort exposes the caller-owned official optimizer model callback. */
export function acceptExternalOptimizerModelCall(
  call: ExternalOptimizerModelCall,
): ExternalOptimizerModelCall {
  return call
}
