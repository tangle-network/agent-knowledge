import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentImprovementActivation,
  type AgentImprovementActivationResult,
  canonicalCandidateDigest,
  type Sha256Digest,
} from '@tangle-network/agent-interface'
import {
  defineReadinessSpec,
  improveKnowledgeBase as improveKnowledgeBaseRaw,
  initKnowledgeBase,
  type KnowledgeImprovementCandidateRef,
  type KnowledgeImprovementMutationReceipt,
  type KnowledgeImprovementOptions,
  knowledgeImprovementCandidateRef,
  knowledgeImprovementRunDir,
  promoteKnowledgeCandidate,
  sha256,
  stableId,
} from '../../src/index'

export const TEST_KNOWLEDGE_IMPLEMENTATION_REF =
  'sha256:4b6f6866d7f2c1fbb0df2ab91d0f2f8a2da124f3e95640d42c416d2675f9d6ce'

export function improveTestKnowledgeBase(
  options: Omit<KnowledgeImprovementOptions, 'implementationRef'> & {
    implementationRef?: string
  },
) {
  return improveKnowledgeBaseRaw({
    implementationRef: TEST_KNOWLEDGE_IMPLEMENTATION_REF,
    ...options,
  })
}

export async function withKb(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-knowledge-improve-'))
  try {
    await initKnowledgeBase(root)
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export async function withEmptyRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-knowledge-improve-empty-'))
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export function mutableCandidateRoot(
  root: string,
  result: { runId: string; candidate?: { candidateId: string } },
): string {
  if (!result.candidate) throw new Error('knowledge improvement result has no candidate')
  return join(
    knowledgeImprovementRunDir(root, result.runId),
    'candidates',
    result.candidate.candidateId,
    'workspace',
  )
}

export const refundSpec = defineReadinessSpec({
  id: 'refund-policy',
  description: 'Refund policy support knowledge',
  query: 'refund policy customer billing refund',
  requiredFor: ['support-agent'],
  importance: 'blocking',
  minHits: 1,
  minSources: 1,
})

export function refundSource() {
  const text = 'The billing support refund policy allows refunds within 30 days with receipt proof.'
  const uri = 'research://refund-policy'
  return {
    uri,
    text,
    title: 'Refund Policy Source',
    id: stableId('src', `${sha256(text)}:${uri}`),
  }
}

export function refundProposal(sourceId: string, extra = ''): string {
  return [
    '---FILE: knowledge/support/refund-policy.md---',
    '---',
    'id: refund-policy',
    'title: Refund Policy',
    'sources:',
    `  - ${sourceId}`,
    '---',
    '# Refund Policy',
    'Billing support can grant a customer refund within 30 days when receipt proof is present.',
    extra,
    '---END FILE---',
  ].join('\n')
}

export function passingMetric() {
  return {
    score: 1,
    passed: true,
    provenance: {
      evaluator: 'agent-knowledge-test',
      version: '1',
      method: 'deterministic' as const,
    },
  }
}

function candidateDigest(seed: string): Sha256Digest {
  return canonicalCandidateDigest({ seed })
}

function canonicalDocument<T extends Record<string, unknown>>(
  material: T,
): T & { digest: Sha256Digest } {
  return { ...material, digest: canonicalCandidateDigest(material) }
}

export function knowledgeActivation(
  candidate: KnowledgeImprovementCandidateRef,
  intent: AgentImprovementActivation['intent'],
  identity = 'knowledge:test',
): AgentImprovementActivation {
  const expectedBaseHash =
    intent === 'activate-candidate' ? candidate.baseHash : candidate.candidateHash
  return canonicalDocument({
    kind: 'agent-improvement-activation' as const,
    proposalDigest: candidateDigest('proposal'),
    reviewDigest: candidateDigest('review'),
    experimentDigest: candidateDigest('experiment'),
    candidateBundleDigest: candidateDigest('candidate-bundle'),
    intent,
    targets: [
      {
        surface: 'knowledge' as const,
        identity,
        expectedBaseDigest: `sha256:${expectedBaseHash}` as Sha256Digest,
      },
    ] as AgentImprovementActivation['targets'],
    fundingOwner: 'tenant:test',
    authorizedBy: 'reviewer:test',
    authorizedAt: '2026-07-17T00:00:00.000Z',
    expiresAt: '2026-07-18T00:00:00.000Z',
  })
}

export function knowledgeActivationResult(
  activation: AgentImprovementActivation,
  candidate: KnowledgeImprovementCandidateRef,
  mutation: KnowledgeImprovementMutationReceipt,
  attemptedAt: string,
  identity = 'knowledge:test',
): AgentImprovementActivationResult {
  const desiredHash =
    activation.intent === 'activate-candidate' ? candidate.candidateHash : candidate.baseHash
  const outcome: AgentImprovementActivationResult['outcome'] = mutation.changed
    ? {
        status: 'applied',
        transactionId: mutation.transactionId!,
        targets: [
          {
            surface: 'knowledge',
            identity,
            beforeDigest: `sha256:${mutation.beforeHash}`,
            afterDigest: `sha256:${mutation.afterHash}`,
          },
        ],
      }
    : mutation.afterHash === desiredHash
      ? {
          status: 'already-applied',
          targets: [
            {
              surface: 'knowledge',
              identity,
              currentDigest: `sha256:${mutation.afterHash}`,
            },
          ],
        }
      : {
          status: 'conflict',
          targets: [
            {
              surface: 'knowledge',
              identity,
              currentDigest: `sha256:${mutation.afterHash}`,
            },
          ],
        }
  return canonicalDocument({
    kind: 'agent-improvement-activation-result' as const,
    idempotencyKey: activation.digest,
    attemptedAt,
    completedAt: attemptedAt,
    outcome,
  })
}

export async function improveAndPromote(options: Parameters<typeof improveTestKnowledgeBase>[0]) {
  const staged = await improveTestKnowledgeBase(options)
  const promoted = await promoteKnowledgeCandidate({
    root: options.root,
    candidate: knowledgeImprovementCandidateRef(staged),
  })
  return { ...promoted, evaluation: staged.evaluation, lifecycle: staged.lifecycle }
}
