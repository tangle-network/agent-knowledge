import { z } from 'zod'
import {
  assertDeepQuestionIntegrity,
  assertResearchClaimEvidenceIntegrity,
  assertResearchClaimLedgerIntegrity,
  assertTrackedClaimIntegrity,
} from './claim-ledger'
import { KNOWLEDGE_EVENT_TYPES } from './types'

export const SourceAnchorSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  label: z.string().optional(),
  page: z.number().int().positive().optional(),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  charStart: z.number().int().nonnegative().optional(),
  charEnd: z.number().int().nonnegative().optional(),
  timestampMs: z.number().nonnegative().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const SourceRecordSchema = z.object({
  id: z.string().min(1),
  uri: z.string().min(1),
  title: z.string().optional(),
  mediaType: z.string().optional(),
  contentHash: z.string().min(16),
  text: z.string().optional(),
  anchors: z.array(SourceAnchorSchema).optional(),
  validUntil: z.iso.datetime().optional(),
  lastVerifiedAt: z.iso.datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().min(1),
})

export const KnowledgePageInvalidationSchema = z
  .object({
    verdict: z.literal('contradicted'),
    observedAt: z.iso.datetime(),
    reason: z.string().trim().min(1),
    evidencePath: z.string().trim().min(1).optional(),
    grader: z.string().trim().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

export const KnowledgePageSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  title: z.string().min(1),
  text: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  sourceIds: z.array(z.string()),
  tags: z.array(z.string()),
  outLinks: z.array(z.string()),
  cites: z.array(z.string().min(1)).optional(),
  contradicts: z.array(z.string().min(1)).optional(),
  invalidation: KnowledgePageInvalidationSchema.optional(),
})

export const KnowledgeGraphNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  path: z.string(),
  tags: z.array(z.string()),
  sourceIds: z.array(z.string()),
  outDegree: z.number().int().nonnegative(),
  inDegree: z.number().int().nonnegative(),
})

export const KnowledgeGraphEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  weight: z.number(),
  reasons: z.array(z.string()),
})

export const KnowledgeRelationSchema = z.object({
  sourceId: z.string(),
  targetId: z.string(),
  predicate: z.string(),
  weight: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const KnowledgeRelationNodeSchema = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const KnowledgeRelationGraphSchema = z.object({
  nodes: z.array(KnowledgeRelationNodeSchema),
  edges: z.array(KnowledgeRelationSchema),
})

export const KnowledgeIndexSchema = z.object({
  root: z.string(),
  generatedAt: z.string(),
  sources: z.array(SourceRecordSchema),
  pages: z.array(KnowledgePageSchema),
  graph: z.object({
    nodes: z.array(KnowledgeGraphNodeSchema),
    edges: z.array(KnowledgeGraphEdgeSchema),
  }),
})

export const KnowledgeEventSchema = z.object({
  id: z.string().min(1),
  // Derived from the type union's own value list — see KNOWLEDGE_EVENT_TYPES.
  // A hand-restated copy of this enum drifted and silently rejected the one
  // event the research loop emits.
  type: z.enum(KNOWLEDGE_EVENT_TYPES),
  createdAt: z.string().min(1),
  actor: z.string().optional(),
  target: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const DeepQuestionSchema = z
  .object({
    kind: z.enum(['comparative', 'mechanism', 'gap', 'contradiction']),
    text: z.string().min(1),
    id: z.string().min(1),
    claimIds: z.array(z.string().min(1)),
    addressed: z.boolean(),
    raisedRound: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((question, context) => {
    reportIntegrityError(context, () => assertDeepQuestionIntegrity(question))
  })

export const ResearchClaimRecordSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    supportingHosts: z.array(z.string().min(1)),
    supportingUris: z.array(z.string().min(1)),
    contradicts: z.array(z.string().min(1)),
    contested: z.boolean(),
    firstSeenRound: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((claim, context) => {
    reportIntegrityError(context, () => assertTrackedClaimIntegrity(claim))
  })

export const ResearchSourceVersionSchema = z
  .object({
    sourceId: z.string().min(1),
    uri: z.string().min(1),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

export const ResearchClaimEvidenceSchema = z
  .object({
    id: z.string().min(1),
    claimId: z.string().min(1),
    text: z.string().min(1),
    sourceId: z.string().min(1),
    sourceUri: z.string().min(1),
    sourceContentHash: z.string().regex(/^[a-f0-9]{64}$/),
    contradictsClaimId: z.string().min(1).optional(),
    firstSeenRound: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((evidence, context) => {
    reportIntegrityError(context, () => assertResearchClaimEvidenceIntegrity(evidence))
  })

export const ResearchClaimLedgerSchema = z
  .object({
    schemaVersion: z.literal(2),
    id: z.string().min(1),
    goal: z.string().trim().min(1).optional(),
    updatedAt: z.iso.datetime(),
    rounds: z.number().int().nonnegative(),
    preparedRounds: z.number().int().nonnegative().optional(),
    claimEvidence: z.array(ResearchClaimEvidenceSchema),
    registeredSources: z.array(ResearchSourceVersionSchema),
    claims: z.array(ResearchClaimRecordSchema),
    questions: z.array(DeepQuestionSchema),
  })
  .strict()
  .superRefine((ledger, context) => {
    reportIntegrityError(context, () => assertResearchClaimLedgerIntegrity(ledger))
  })

function reportIntegrityError(context: z.core.$RefinementCtx, check: () => void): void {
  try {
    check()
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

export const KnowledgeBaseCandidateSchema = z.object({
  id: z.string().min(1),
  units: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      text: z.string(),
      claims: z
        .array(
          z.object({
            id: z.string().min(1),
            text: z.string().min(1),
            refs: z.array(
              z.object({
                sourceId: z.string().min(1),
                anchorId: z.string().optional(),
                quote: z.string().optional(),
              }),
            ),
            confidence: z.number().min(0).max(1).optional(),
            status: z.enum(['draft', 'active', 'superseded', 'rejected']).optional(),
            metadata: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .optional(),
      relations: z.array(KnowledgeRelationSchema).optional(),
      sourceIds: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      updatedAt: z.string().optional(),
    }),
  ),
  retrievalPolicy: z.string().optional(),
  synthesisPolicy: z.string().optional(),
  questionPolicy: z.string().optional(),
  updatePolicy: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
