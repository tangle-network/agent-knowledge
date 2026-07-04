import type { SourceRecord } from '../types'
import type { RetrievalHoldoutConfig } from './holdout'

export type AgentMemoryKind =
  | 'message'
  | 'entity'
  | 'fact'
  | 'preference'
  | 'observation'
  | 'reasoning-trace'

export interface AgentMemoryScope {
  tenantId?: string
  userId?: string
  sessionId?: string
  namespace?: string
  tags?: Record<string, string>
}

export interface AgentMemoryHit {
  id: string
  uri: string
  kind: AgentMemoryKind
  text: string
  title?: string
  score?: number
  normalizedScore?: number
  confidence?: number
  createdAt?: string
  validUntil?: string
  lastVerifiedAt?: string
  metadata?: Record<string, unknown>
}

export interface AgentMemoryContext {
  query: string
  text: string
  hits: AgentMemoryHit[]
  sourceRecords: SourceRecord[]
  metadata?: Record<string, unknown>
}

export interface AgentMemorySearchOptions {
  scope?: AgentMemoryScope
  limit?: number
  minScore?: number
  kinds?: AgentMemoryKind[]
  metadata?: Record<string, unknown>
  /**
   * Opt-in randomized retrieval holdout (epsilon-dropout) for treatment-effect logging.
   * Absent by default; when absent, retrieval behavior is unchanged. See ./holdout.
   */
  holdout?: RetrievalHoldoutConfig
}

export interface AgentMemoryWriteInput {
  kind: AgentMemoryKind
  text: string
  id?: string
  title?: string
  role?: 'system' | 'user' | 'assistant' | 'tool'
  entityName?: string
  entityType?: string
  category?: string
  predicate?: string
  subject?: string
  object?: string
  confidence?: number
  scope?: AgentMemoryScope
  metadata?: Record<string, unknown>
}

export interface AgentMemoryWriteResult {
  accepted: boolean
  id: string
  uri: string
  kind: AgentMemoryKind
  sourceRecord?: SourceRecord
  metadata?: Record<string, unknown>
}

export interface AgentMemoryAdapter {
  readonly id: string
  search(query: string, options?: AgentMemorySearchOptions): Promise<AgentMemoryHit[]>
  getContext(query: string, options?: AgentMemorySearchOptions): Promise<AgentMemoryContext>
  write(input: AgentMemoryWriteInput): Promise<AgentMemoryWriteResult>
  flush?(): Promise<void>
}
