import {
  type AgentCandidateKnowledgeRef,
  sha256DigestSchema,
} from '@tangle-network/agent-interface'

import {
  type KnowledgeImprovementCandidateRef,
  KnowledgeImprovementCandidateRefSchema,
} from './kb-improvement'

/** Convert a measured knowledge candidate into the shared review and execution identity. */
export function toAgentCandidateKnowledgeRef(
  candidate: KnowledgeImprovementCandidateRef,
): AgentCandidateKnowledgeRef {
  const parsed = KnowledgeImprovementCandidateRefSchema.parse(candidate)
  return {
    ...parsed,
    goalHash: prefixedDigest(parsed.goalHash),
    baseHash: prefixedDigest(parsed.baseHash),
    candidateHash: prefixedDigest(parsed.candidateHash),
    evidenceHash: prefixedDigest(parsed.evidenceHash),
    promotionPlanHash: prefixedDigest(parsed.promotionPlanHash),
  }
}

/** Recover agent-knowledge's candidate identity from the shared contract. */
export function fromAgentCandidateKnowledgeRef(
  candidate: AgentCandidateKnowledgeRef,
): KnowledgeImprovementCandidateRef {
  return KnowledgeImprovementCandidateRefSchema.parse({
    ...candidate,
    goalHash: rawDigest(candidate.goalHash),
    baseHash: rawDigest(candidate.baseHash),
    candidateHash: rawDigest(candidate.candidateHash),
    evidenceHash: rawDigest(candidate.evidenceHash),
    promotionPlanHash: rawDigest(candidate.promotionPlanHash),
  })
}

function prefixedDigest(value: string) {
  return sha256DigestSchema.parse(`sha256:${value}`)
}

function rawDigest(value: string): string {
  return sha256DigestSchema.parse(value).slice('sha256:'.length)
}
