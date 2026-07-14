import {
  type AgentCandidateKnowledgeRef,
  agentCandidateKnowledgeSchema,
} from '@tangle-network/agent-interface'
import { describe, expect, it } from 'vitest'

import {
  fromAgentCandidateKnowledgeRef,
  toAgentCandidateKnowledgeRef,
} from '../src/agent-candidate'
import type { KnowledgeImprovementCandidateRef } from '../src/kb-improvement'

const candidate: KnowledgeImprovementCandidateRef = {
  schemaVersion: 1,
  kind: 'knowledge-improvement-candidate',
  runId: 'knowledge-run',
  candidateId: 'candidate-1',
  goalHash: '1'.repeat(64),
  baseHash: '2'.repeat(64),
  candidateHash: '3'.repeat(64),
  evidenceHash: '4'.repeat(64),
  promotionPlanHash: '5'.repeat(64),
}

const sharedCandidate: AgentCandidateKnowledgeRef = {
  schemaVersion: 1,
  kind: 'knowledge-improvement-candidate',
  runId: 'knowledge-run',
  candidateId: 'candidate-1',
  goalHash: `sha256:${'1'.repeat(64)}`,
  baseHash: `sha256:${'2'.repeat(64)}`,
  candidateHash: `sha256:${'3'.repeat(64)}`,
  evidenceHash: `sha256:${'4'.repeat(64)}`,
  promotionPlanHash: `sha256:${'5'.repeat(64)}`,
}

describe('agent candidate knowledge references', () => {
  it('converts every hash into an independently validated shared reference', () => {
    const shared = toAgentCandidateKnowledgeRef(candidate)

    expect(shared).toEqual(sharedCandidate)
    expect(agentCandidateKnowledgeSchema.shape.candidate.parse(shared)).toEqual(sharedCandidate)
  })

  it('recovers the exact knowledge candidate from an independent shared reference', () => {
    expect(fromAgentCandidateKnowledgeRef(sharedCandidate)).toEqual(candidate)
  })

  it('rejects malformed shared hashes', () => {
    const shared = toAgentCandidateKnowledgeRef(candidate)
    expect(() =>
      fromAgentCandidateKnowledgeRef({ ...shared, candidateHash: 'sha256:bad' }),
    ).toThrow()
  })
})
