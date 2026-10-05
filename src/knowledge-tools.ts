/**
 * Provider-neutral knowledge tools.
 *
 * Knowledge owns what each tool does; a runtime only transports the definitions
 * and the calls. The shape is `ToolDefinition` from `@tangle-network/agent-interface`,
 * so no provider vocabulary reaches this package and no knowledge behavior
 * reaches a provider adapter.
 *
 * Every search mints a retrieval receipt. Configured receipt capture also
 * persists the exact visibility snapshot before delivering the receipt.
 *
 * Every result carries `timing` in milliseconds: `viewMs` to obtain the current
 * page view, `visibilityMs` to persist a search's snapshot, and for a write
 * `lockWaitMs` and `lockHoldMs` of the store lock.
 */

import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sha256DigestSchema, type ToolDefinition } from '@tangle-network/agent-interface'
import { z } from 'zod'
import {
  parseKnowledgeCitationReference,
  resolveKnowledgeCitation,
  resolveKnowledgeCitations,
} from './citation-resolution'
import { isMissingFile, readRegularFileWithinRoot, writeFileDurableWithinRoot } from './durable-fs'
import { type KnowledgeBriefOptions, prepareKnowledgeBrief } from './knowledge-brief'
import {
  createKnowledgeRetrievalReceipt,
  createKnowledgeVisibilitySnapshot,
  encodeKnowledgeVisibilitySnapshot,
  type KnowledgeRetrievalReceipt,
  knowledgeVisibilityArtifactRef,
} from './knowledge-use-receipts'
import {
  immutablePageDigest,
  knowledgePageDigest,
  snapshotImmutableVisibility,
} from './knowledge-visibility'
import { measureKnowledgeMutation } from './mutation-lock'
import { normalizePagesDirectory } from './pages-directory'
import { applyKnowledgeWriteBlocks, type KnowledgeWriteIntakeRequest } from './proposals'
import {
  isKnowledgeToolChain,
  loadKnowledgeToolChain,
  type OriginatedPage,
  type RunScopedStores,
} from './run-scoped'
import { parseKnowledgeWriteBlocks } from './write-protocol'

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
  /** Retain prior and new bytes for every completed knowledge_record transaction. */
  readonly retainHistory?: boolean
  /** Brief settings for `knowledge_search`, overridden per call by the tool input. */
  readonly brief?: Omit<KnowledgeBriefOptions, 'limit'>
  /** Receipt sink. Exact visibility bytes are persisted in the run store before this is called. */
  readonly recordRetrieval?: (receipt: KnowledgeRetrievalReceipt) => Promise<void> | void
  readonly now?: () => Date
}

// Weak keys release derived indexes when the bounded store cache replaces a view.
const preparedViews = new WeakMap<
  readonly OriginatedPage[],
  {
    brief: ReturnType<typeof prepareKnowledgeBrief>
    visibility: ReturnType<typeof createKnowledgeVisibilitySnapshot>
    bytes: Uint8Array
  }
>()

function prepareView(chain: readonly OriginatedPage[]) {
  const reusable = isKnowledgeToolChain(chain)
  const previous = reusable ? preparedViews.get(chain) : undefined
  if (previous) return previous
  const visibility = reusable
    ? snapshotImmutableVisibility(chain)
    : createKnowledgeVisibilitySnapshot(chain)
  const prepared = {
    brief: prepareKnowledgeBrief(chain),
    visibility,
    bytes: encodeKnowledgeVisibilitySnapshot(visibility),
  }
  if (reusable) preparedViews.set(chain, prepared)
  return prepared
}

const searchInput = z.object({
  question: z.string().min(1),
  limit: z.int().min(1).max(50).optional(),
  excludeInvalidated: z
    .boolean()
    .optional()
    .describe('False includes refuted pages for historical research.'),
  tags: z.array(z.string()).optional(),
  kinds: z.array(z.string()).optional(),
})
const readInput = z.object({ pageId: z.string().min(1) })
const recordInput = z.object({
  expectedPageDigests: z
    .record(z.string().min(1), sha256DigestSchema.nullable())
    .optional()
    .describe(
      'For each existing page, pass its path and pageDigest from knowledge_read. Null requires a new page. Missing entries permit new pages only.',
    ),
  proposal: z
    .string()
    .min(1)
    .describe(
      'One or more complete FILE blocks. Each begins with ---FILE: <page-path>--- and ends with ---END FILE---, each on its own line. Put the page content between them. Every block must be valid; malformed or empty proposals write nothing and return an error.',
    ),
})
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
  const pagesDirectory = normalizePagesDirectory(options.pagesDirectory)

  return [
    tool(
      'knowledge_search',
      'Search visible knowledge with unambiguous citation handles. Optionally include refuted history or filter tags and kinds.',
      searchInput,
      async (input) => {
        const started = performance.now()
        const chain = await loadKnowledgeToolChain(stores, runId)
        const prepared = prepareView(chain)
        const viewMs = elapsedSince(started)
        const brief = prepared.brief(input.question, {
          ...options.brief,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.excludeInvalidated === undefined
            ? {}
            : { excludeInvalidated: input.excludeInvalidated }),
          ...(input.tags === undefined ? {} : { tags: input.tags }),
          ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
        })
        const visibility = prepared.visibility
        const persisting = performance.now()
        const visibilityArtifact = options.recordRetrieval
          ? await persistVisibility(stores.storePath(runId), visibility, prepared.bytes)
          : undefined
        const visibilityMs = elapsedSince(persisting)
        const receipt = createKnowledgeRetrievalReceipt({
          runId,
          ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
          query: brief.question,
          retriever: {
            id: brief.retrieverId,
            version: options.retrieverVersion,
            configDigest: brief.retrieverConfigDigest,
          },
          visibility,
          ...(visibilityArtifact ? { visibilityArtifact } : {}),
          results: brief.results,
          createdAt: options.now?.(),
        })
        await options.recordRetrieval?.(receipt)
        return {
          text: brief.text,
          citationIds: brief.citationIds,
          retrievalReceiptDigest: receipt.receiptDigest,
          receipt,
          timing: { viewMs, visibilityMs },
        }
      },
    ),

    tool(
      'knowledge_read',
      'Read one page by its id, optionally qualified with here::, shared:: or inherited:<runId>::.',
      readInput,
      async (input) => {
        const started = performance.now()
        const chain = await loadKnowledgeToolChain(stores, runId)
        const viewMs = elapsedSince(started)
        const resolution = resolveKnowledgeCitation(
          chain,
          parseKnowledgeCitationReference(input.pageId),
        )
        const digestOf = isKnowledgeToolChain(chain) ? immutablePageDigest : knowledgePageDigest
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
                  pageDigest: digestOf(resolution.resolved.page),
                  text: resolution.resolved.page.text,
                },
          candidates: resolution.candidates.map((candidate) => ({
            pageId: candidate.pageId,
            origin: candidate.origin,
            path: candidate.page.path,
          })),
          timing: { viewMs },
        }
      },
    ),

    tool(
      'knowledge_record',
      `Write pages into this run's store. Use complete blocks exactly like:\n---FILE: ${pagesDirectory}/example.md---\n# Example\nPage content.\n---END FILE---\nUse paths under ${pagesDirectory}/. Both delimiters must be on their own lines. To update a page, first knowledge_read it and pass expectedPageDigests[path] = pageDigest. Stale edits and malformed, unsafe, or empty proposals are rejected before writing any pages.`,
      recordInput,
      async (input) => {
        const parsed = parseKnowledgeWriteBlocks(input.proposal, [`${pagesDirectory}/`])
        // Tool success must mean the complete proposal was admitted, not a silent partial write.
        if (parsed.blocks.length === 0 || parsed.warnings.length > 0) {
          throw new Error(
            `knowledge_record rejected the proposal without writing any pages. Use ---FILE: ${pagesDirectory}/example.md--- followed by content and ---END FILE---, each delimiter on its own line. ${parsed.warnings.join(' ')}`,
          )
        }
        const intake = options.intake
        const inheritedPages = intake === undefined ? [] : await inheritedOf(stores, runId)
        const { value, timing } = await measureKnowledgeMutation(() =>
          applyKnowledgeWriteBlocks(stores.storePath(runId), input.proposal, {
            ...pages,
            actorId: options.actorId,
            runId,
            expectedPageDigests: input.expectedPageDigests ?? {},
            retainHistory: options.retainHistory ?? true,
            ...(intake === undefined ? {} : { intake: { ...intake, inheritedPages } }),
          }),
        )
        return { ...value, timing: timing ?? { lockWaitMs: 0, lockHoldMs: 0 } }
      },
    ),

    tool(
      'knowledge_resolve',
      'Resolve page ids against everything this run can see, without hiding an ambiguity.',
      resolveInput,
      async (input) => {
        const started = performance.now()
        const chain = await loadKnowledgeToolChain(stores, runId)
        const viewMs = elapsedSince(started)
        return {
          resolutions: resolveKnowledgeCitations(
            chain,
            input.references.map((reference) => parseKnowledgeCitationReference(reference)),
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
          timing: { viewMs },
        }
      },
    ),
  ]
}

function elapsedSince(started: number): number {
  return Math.round(performance.now() - started)
}

/** Everything the run can see except what it wrote, which the write path reads itself. */
async function inheritedOf(
  stores: RunScopedStores,
  runId: string,
): Promise<readonly OriginatedPage[]> {
  return (await loadKnowledgeToolChain(stores, runId)).filter((entry) => entry.origin !== 'here')
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

/**
 * Snapshot artifacts are immutable, content-addressed evidence, separate from authoritative KB
 * state. They are written without the store lock and without moving the mutation epoch: equal
 * names always carry equal bytes, so concurrent writers converge and a search never blocks a
 * writer or restarts a reader. Stored bytes are compared before reuse; this process skips the
 * comparison only while the file keeps the identity it had when last compared.
 */
const verifiedArtifacts = new Map<string, string>()
const persisting = new Map<string, Promise<void>>()
const MAX_VERIFIED_ARTIFACTS = 1024

async function persistVisibility(
  root: string,
  snapshot: ReturnType<typeof createKnowledgeVisibilitySnapshot>,
  bytes: Uint8Array,
) {
  const path = `.agent-knowledge/retrieval-visibility/${snapshot.snapshotDigest.replace('sha256:', '')}.json`
  const absolute = join(root, path)
  const identity = await fileIdentity(absolute)
  if (identity === undefined || verifiedArtifacts.get(absolute) !== identity) {
    let pending = persisting.get(absolute)
    if (!pending) {
      pending = ensureArtifact(root, path, absolute, bytes).finally(() =>
        persisting.delete(absolute),
      )
      persisting.set(absolute, pending)
    }
    await pending
  }
  return knowledgeVisibilityArtifactRef({ uri: pathToFileURL(absolute).href, bytes })
}

async function ensureArtifact(root: string, path: string, absolute: string, bytes: Uint8Array) {
  const identity = await fileIdentity(absolute)
  if (identity !== undefined && verifiedArtifacts.get(absolute) === identity) return
  try {
    const existing = await readRegularFileWithinRoot(root, path)
    if (!existing.bytes.equals(bytes)) {
      throw new Error('stored knowledge visibility artifact does not match its content identity')
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error
    await writeFileDurableWithinRoot(root, path, Buffer.from(bytes))
  }
  const verified = await fileIdentity(absolute)
  if (verified === undefined) return
  verifiedArtifacts.delete(absolute)
  verifiedArtifacts.set(absolute, verified)
  if (verifiedArtifacts.size > MAX_VERIFIED_ARTIFACTS) {
    verifiedArtifacts.delete(verifiedArtifacts.keys().next().value!)
  }
}

async function fileIdentity(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path, { bigint: true })
    if (!stat.isFile()) return undefined
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
}
