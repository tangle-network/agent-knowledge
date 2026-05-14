import { z } from 'zod'

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
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().min(1),
})

export const KnowledgePageSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  title: z.string().min(1),
  text: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  sourceIds: z.array(z.string()),
  tags: z.array(z.string()),
  outLinks: z.array(z.string()),
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
  type: z.enum([
    'source.added',
    'proposal.applied',
    'index.built',
    'lint.run',
    'optimization.run',
    'release.promoted',
    'release.rejected',
  ]),
  createdAt: z.string().min(1),
  actor: z.string().optional(),
  target: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

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
      relations: z
        .array(
          z.object({
            sourceId: z.string(),
            targetId: z.string(),
            predicate: z.string(),
            weight: z.number().optional(),
            metadata: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .optional(),
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
