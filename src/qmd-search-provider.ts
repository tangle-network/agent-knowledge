import { canonicalCandidateDigest, type ToolDefinition } from '@tangle-network/agent-interface'
import { z } from 'zod'
import { sha256 } from './ids'
import { SourceRecordSchema } from './schemas'
import type { SourceRecord } from './types'

/** The public QMD SDK subset; the host owns installation, indexing, and model selection. */
export interface QmdSearchClient {
  searchLex(query: string, options: { collection: string; limit: number }): Promise<unknown>
  searchVector?(query: string, options: { collection: string; limit: number }): Promise<unknown>
  get(path: string, options: { includeBody: true }): Promise<unknown>
}

export interface QmdSourceDocument {
  readonly qmdPath: string
  readonly source: SourceRecord
}

export interface QmdSearchProviderOptions {
  readonly client: QmdSearchClient
  readonly scopeId: string
  readonly revision: string
  readonly collection: string
  /** Declared by the index owner after a successful update; absent means unknown. */
  readonly indexedAt?: string
  readonly documents: readonly QmdSourceDocument[]
  /** Vector mode is explicit because it invokes the host's embedding model. */
  readonly mode?: 'lexical' | 'vector'
}

const indexedDocument = z.object({
  filepath: z.string(),
  collectionName: z.string(),
  body: z.string(),
})
const searchResults = z.array(z.object({ filepath: z.string(), score: z.number().finite() }))
const querySchema = z
  .object({
    query: z.string().trim().min(1).max(16_000),
    limit: z.number().int().min(1).max(50).default(5),
  })
  .strict()
const readSchema = z
  .object({
    sourceId: z.string().min(1),
    fromLine: z.number().int().min(1).default(1),
    maxLines: z.number().int().min(1).max(200).default(80),
  })
  .strict()

/**
 * A fixed source snapshot, not an authorization decision. The trusted host supplies
 * one authorized corpus; agents cannot select a collection, bank, or arbitrary path.
 * QMD's index is derived: its bytes must agree with the authoritative source hash.
 */
export function createQmdSearchProvider(options: QmdSearchProviderOptions) {
  const { client } = options
  const scopeId = z.string().trim().min(1).parse(options.scopeId)
  const revision = z.string().trim().min(1).parse(options.revision)
  const collection = z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .parse(options.collection)
  const mode = z.enum(['lexical', 'vector']).parse(options.mode ?? 'lexical')
  const indexedAt =
    options.indexedAt === undefined ? null : z.iso.datetime().parse(options.indexedAt)
  if (mode === 'vector' && !client.searchVector) throw new Error('QMD vector search is unavailable')
  const byId = new Map<string, QmdSourceDocument>()
  const byPath = new Map<string, QmdSourceDocument>()
  for (const entry of options.documents) {
    const source = SourceRecordSchema.parse(structuredClone(entry.source))
    if (!/^[a-f0-9]{64}$/.test(source.contentHash)) {
      throw new TypeError('QMD sources require an exact SHA-256 contentHash')
    }
    if (source.text !== undefined && sha256(source.text) !== source.contentHash) {
      throw new Error('QMD source text does not match its contentHash')
    }
    const prefix = `qmd://${collection}/`
    const path = entry.qmdPath.slice(prefix.length)
    if (
      !entry.qmdPath.startsWith(prefix) ||
      !path ||
      path
        .split('/')
        .some((part) => !part || part === '.' || part === '..' || /[\\\u0000-\u001f?#%]/.test(part))
    )
      throw new TypeError('QMD document path must be within the bound collection')
    if (byId.has(source.id) || byPath.has(entry.qmdPath)) {
      throw new Error('QMD snapshot contains duplicate source ids or paths')
    }
    const document = { qmdPath: entry.qmdPath, source }
    byId.set(source.id, document)
    byPath.set(entry.qmdPath, document)
  }
  const snapshotDigest = canonicalCandidateDigest({
    scopeId,
    revision,
    collection,
    documents: [...byPath.values()]
      .map(({ qmdPath, source }) => ({
        qmdPath,
        id: source.id,
        uri: source.uri,
        contentHash: source.contentHash,
      }))
      .sort((a, b) => (a.qmdPath < b.qmdPath ? -1 : a.qmdPath > b.qmdPath ? 1 : 0)),
  })
  const identity = Object.freeze({
    scopeId,
    revision,
    snapshotDigest,
    indexedAt,
    mode,
    documentCount: byId.size,
  })
  const verifiedRead = async (document: QmdSourceDocument): Promise<QmdSourceDocument> => {
    const parsed = indexedDocument.safeParse(
      await client.get(document.qmdPath, { includeBody: true }),
    )
    if (!parsed.success)
      throw new Error('QMD snapshot document is unavailable or malformed; rebuild the scoped index')
    const indexed = parsed.data
    if (indexed.filepath !== document.qmdPath || indexed.collectionName !== collection) {
      throw new Error('QMD returned a document outside the bound snapshot')
    }
    if (sha256(indexed.body) !== document.source.contentHash) {
      throw new Error('QMD index is stale for this source revision; rebuild the scoped index')
    }
    return {
      qmdPath: document.qmdPath,
      source: { ...structuredClone(document.source), text: indexed.body },
    }
  }
  return {
    ...identity,
    async search(query: string, searchOptions: { limit?: number } = {}) {
      const request = querySchema.parse({ query, ...searchOptions })
      const search = mode === 'vector' ? client.searchVector! : client.searchLex
      const results = searchResults.parse(
        await search.call(client, request.query, { collection, limit: request.limit }),
      )
      const seen = new Set<string>()
      // Validate the complete returned set before reading any content.
      for (const hit of results) {
        if (!byPath.has(hit.filepath))
          throw new Error('QMD returned a search result outside the bound snapshot')
        if (seen.has(hit.filepath)) throw new Error('QMD returned duplicate search results')
        seen.add(hit.filepath)
      }
      const hits = await Promise.all(
        results.slice(0, request.limit).map(async (hit) => ({
          ...(await verifiedRead(byPath.get(hit.filepath)!)),
          score: hit.score,
        })),
      )
      return { ...identity, hits }
    },
    async read(sourceId: string) {
      const document = byId.get(sourceId)
      if (!document) throw new Error('Source is not in the bound QMD snapshot')
      return { ...identity, document: await verifiedRead(document) }
    },
  }
}

export type QmdSearchProvider = ReturnType<typeof createQmdSearchProvider>

/** Same source-checked functions used by a human reader and exact-profile tool grants. */
export function createQmdKnowledgeTools(options: {
  readonly provider: QmdSearchProvider
  readonly namePrefix?: string
}): ToolDefinition[] {
  const prefix = options.namePrefix ?? ''
  if (!/^[a-zA-Z0-9_]*$/.test(prefix)) throw new TypeError('Invalid QMD tool name prefix')
  return [
    {
      name: `${prefix}qmd_search`,
      description:
        'Search this bound source snapshot. Results carry original source ids, URIs and hashes; use qmd_read for full source lines.',
      inputSchema: querySchema,
      inputSchemaJson: z.toJSONSchema(querySchema) as Record<string, unknown>,
      async handler(input: unknown) {
        const request = querySchema.parse(input)
        const result = await options.provider.search(request.query, { limit: request.limit })
        return {
          ...result,
          hits: result.hits.map(({ source, ...hit }) => {
            const { text, ...reference } = source
            return {
              ...hit,
              source: reference,
              excerpt: text?.slice(0, 2_000),
              excerptTruncated: (text?.length ?? 0) > 2_000,
            }
          }),
        }
      },
    },
    {
      name: `${prefix}qmd_read`,
      description:
        'Read exact source lines by a source id returned from this snapshot. Other play sources are unavailable.',
      inputSchema: readSchema,
      inputSchemaJson: z.toJSONSchema(readSchema) as Record<string, unknown>,
      async handler(input: unknown) {
        const request = readSchema.parse(input)
        const result = await options.provider.read(request.sourceId)
        const { text = '', ...source } = result.document.source
        const lines = text.split('\n')
        const selected = lines.slice(request.fromLine - 1, request.fromLine - 1 + request.maxLines)
        const rendered = selected
          .map((line, index) => `${request.fromLine + index}: ${line}`)
          .join('\n')
        return {
          ...result,
          document: {
            ...result.document,
            source,
            text: rendered.slice(0, 32_000),
            fromLine: request.fromLine,
            totalLines: lines.length,
            truncated:
              rendered.length > 32_000 || request.fromLine - 1 + selected.length < lines.length,
          },
        }
      },
    },
  ]
}
