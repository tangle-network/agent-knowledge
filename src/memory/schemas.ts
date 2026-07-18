import { z } from 'zod'

export const AgentMemoryKindSchema = z.enum([
  'message',
  'entity',
  'fact',
  'preference',
  'observation',
  'reasoning-trace',
])

export const AgentMemoryScopeSchema = z.object({
  tenantId: z.string().optional(),
  userId: z.string().optional(),
  agentId: z.string().optional(),
  teamId: z.string().optional(),
  runId: z.string().optional(),
  sessionId: z.string().optional(),
  namespace: z.string().optional(),
  tags: z.record(z.string(), z.string()).optional(),
})

export const AgentMemoryHitSchema = z.object({
  id: z.string().min(1),
  uri: z.string().min(1),
  kind: AgentMemoryKindSchema,
  text: z.string().min(1),
  title: z.string().optional(),
  score: z.number().optional(),
  normalizedScore: z.number().optional(),
  confidence: z.number().optional(),
  createdAt: z.string().optional(),
  validUntil: z.string().optional(),
  lastVerifiedAt: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const AgentMemoryWriteInputSchema = z.object({
  kind: AgentMemoryKindSchema,
  text: z.string().min(1),
  id: z.string().optional(),
  title: z.string().optional(),
  role: z.enum(['system', 'user', 'assistant', 'tool']).optional(),
  entityName: z.string().optional(),
  entityType: z.string().optional(),
  category: z.string().optional(),
  predicate: z.string().optional(),
  subject: z.string().optional(),
  object: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  scope: AgentMemoryScopeSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
