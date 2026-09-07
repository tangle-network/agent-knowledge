import { z } from 'zod'
import { normalizePagesDirectory } from './pages-directory'

/** Authoritative local state included in a KB improvement candidate. */
export interface KnowledgeStateScope {
  /** Root-relative Markdown pages directory. Defaults to `knowledge`. */
  pagesDirectory?: string
  /** Include claim ledgers and research events. Excludes indexes, locks, and receipt artifacts. */
  researchState?: boolean
}

export const knowledgeStateScopeSchema = z
  .object({
    pagesDirectory: z
      .string()
      .transform((value) => normalizePagesDirectory(value))
      .optional(),
    researchState: z.boolean().optional(),
  })
  .strict()

export function normalizeKnowledgeStateScope(scope: KnowledgeStateScope = {}) {
  const parsed = knowledgeStateScopeSchema.parse(scope)
  return {
    pagesDirectory: normalizePagesDirectory(parsed.pagesDirectory),
    researchState: parsed.researchState ?? false,
  }
}

export const KNOWLEDGE_RESEARCH_STATE_PATHS = [
  '.agent-knowledge/claim-ledgers',
  '.agent-knowledge/events.json',
] as const
