/**
 * Provider-neutral knowledge tools.
 *
 * Knowledge owns what each tool does; a runtime only transports the definitions
 * and the calls. The shape is `ToolDefinition` from `@tangle-network/agent-interface`,
 * so no provider vocabulary reaches this package and no knowledge behavior
 * reaches a provider adapter.
 *
 * Every search mints a retrieval receipt, so what an actor was shown is
 * recorded by the infrastructure rather than claimed by the run.
 */
import type { ToolDefinition } from '@tangle-network/agent-interface'
import { z } from 'zod'
import {
  parseKnowledgeCitationReference,
  resolveKnowledgeCitation,
  resolveRunScopedCitations,
} from './citation-resolution'
import { buildKnowledgeBrief, type KnowledgeBriefOptions } from './knowledge-brief'
import {
  createKnowledgeRetrievalReceipt,
  createKnowledgeVisibilitySnapshot,
  type KnowledgeRetrievalReceipt,
} from './knowledge-use-receipts'
import { applyKnowledgeWriteBlocks, type KnowledgeWriteIntakeRequest } from './proposals'
import type { OriginatedPage, RunScopedStores } from './run-scoped'

export interface CreateKnowledgeToolsOptions {
  readonly stores: RunScopedStores
  /** The run whose store is written and whose chain is read. */
  readonly runId: string
  /**
   * Version of this package the host is running. A bundled build cannot read
   * its own manifest, and a receipt that guessed the version would be a
   * receipt that lies about what ranked the results.
   */
  readonly retrieverVersion: string
  readonly actorId?: string
  readonly pagesDirectory?: string
  /** Intake settings for `knowledge_record`. Absent leaves the write ungated. */
  readonly intake?: Omit<KnowledgeWriteIntakeRequest, 'inheritedPages'>
  /** Brief settings for `knowledge_search`, overridden per call by the tool input. */
  readonly brief?: Omit<KnowledgeBriefOptions, 'limit'>
  /** Durable sink for every minted retrieval receipt. */
  readonly recordRetrieval?: (receipt: KnowledgeRetrievalReceipt) => Promise<void> | void
  readonly now?: () => Date
}

const searchInput = z.object({
  question: z.string().min(1),
  limit: z.int().min(1).max(50).optional(),
})
const readInput = z.object({ pageId: z.string().min(1) })
const recordInput = z.object({ proposal: z.string().min(1) })
const resolveInput = z.object({ references: z.array(z.string().min(1)).min(1) })

/**
 * The four tools an agent needs to use a knowledge store: search, read, record,
 * resolve.
 */
export function createKnowledgeTools(options: CreateKnowledgeToolsOptions): ToolDefinition[] {
  const { stores, runId } = options
  if (!stores || typeof stores.loadChain !== 'function') {
    throw new TypeError('knowledge tools require run-scoped stores')
  }
  if (typeof runId !== 'string' || runId.trim().length === 0) {
    throw new TypeError('knowledge tools require a runId')
  }
  if (typeof options.retrieverVersion !== 'string' || options.retrieverVersion.trim() === '') {
    throw new TypeError('knowledge tools require the running retrieverVersion')
  }
  const pages =
    options.pagesDirectory === undefined ? {} : { pagesDirectory: options.pagesDirectory }

  return [
    tool(
      'knowledge_search',
      'Search the knowledge this run can see and return a brief with the ids to cite.',
      searchInput,
      async (input) => {
        const chain = await stores.loadChain(runId)
        const brief = buildKnowledgeBrief(chain, input.question, {
          ...options.brief,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        })
        const receipt = createKnowledgeRetrievalReceipt({
          runId,
          ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
          query: brief.question,
          retriever: {
            id: brief.retrieverId,
            version: options.retrieverVersion,
            configDigest: brief.retrieverConfigDigest,
          },
          visibility: createKnowledgeVisibilitySnapshot(chain),
          results: brief.results,
          createdAt: options.now?.(),
        })
        await options.recordRetrieval?.(receipt)
        return {
          text: brief.text,
          citationIds: brief.citationIds,
          retrievalReceiptDigest: receipt.receiptDigest,
          receipt,
        }
      },
    ),

    tool(
      'knowledge_read',
      'Read one page by its id, optionally qualified with here::, shared:: or inherited:<runId>::.',
      readInput,
      async (input) => {
        const resolution = resolveKnowledgeCitation(
          await stores.loadChain(runId),
          parseKnowledgeCitationReference(input.pageId),
        )
        return {
          status: resolution.status,
          page:
            resolution.resolved === undefined
              ? null
              : {
                  pageId: resolution.resolved.page.id,
                  origin: resolution.resolved.origin,
                  path: resolution.resolved.page.path,
                  title: resolution.resolved.page.title,
                  text: resolution.resolved.page.text,
                },
          candidates: resolution.candidates.map((candidate) => ({
            pageId: candidate.pageId,
            origin: candidate.origin,
            path: candidate.page.path,
          })),
        }
      },
    ),

    tool(
      'knowledge_record',
      'Write pages into the store of this run from ---FILE: ...--- blocks.',
      recordInput,
      async (input) => {
        const intake = options.intake
        return applyKnowledgeWriteBlocks(stores.storePath(runId), input.proposal, {
          ...pages,
          ...(intake === undefined
            ? {}
            : { intake: { ...intake, inheritedPages: await inheritedOf(stores, runId) } }),
        })
      },
    ),

    tool(
      'knowledge_resolve',
      'Resolve page ids against everything this run can see, without hiding an ambiguity.',
      resolveInput,
      async (input) => ({
        resolutions: (
          await resolveRunScopedCitations(
            stores,
            runId,
            input.references.map((reference) => parseKnowledgeCitationReference(reference)),
          )
        ).map((resolution) => ({
          pageId: resolution.reference.pageId,
          ...(resolution.reference.origin === undefined
            ? {}
            : { origin: resolution.reference.origin }),
          status: resolution.status,
          candidates: resolution.candidates.map((candidate) => ({
            pageId: candidate.pageId,
            origin: candidate.origin,
            path: candidate.page.path,
          })),
        })),
      }),
    ),
  ]
}

/** Everything the run can see except what it wrote, which the write path reads itself. */
async function inheritedOf(
  stores: RunScopedStores,
  runId: string,
): Promise<readonly OriginatedPage[]> {
  return (await stores.loadChain(runId)).filter((entry) => entry.origin !== 'here')
}

function tool<Schema extends z.ZodType>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (input: z.infer<Schema>) => Promise<unknown>,
): ToolDefinition {
  return {
    name,
    description,
    inputSchema,
    inputSchemaJson: z.toJSONSchema(inputSchema) as Record<string, unknown>,
    handler: (input: unknown) => handler(inputSchema.parse(input)),
  }
}
