import type { AgentCandidateJsonValue as JsonValue } from '@tangle-network/agent-interface'
import { z } from 'zod'
import type { RetrievalEvalRetriever, RetrievedKnowledgeHit } from './retrieval-eval'

/**
 * Hub-backed vector retrieval over a user-connected vector database.
 *
 * `FileSystemSearchProvider` (and the QMD snapshot provider) prove the shape
 * of a search backend; this is the third backend: similarity search against a
 * vector database the user already connected through the Tangle Platform Hub
 * (Pinecone, Qdrant, or Weaviate). The provider never talks to the vector DB
 * directly — every query routes through `POST /v1/hub/exec`, so the Hub's
 * per-user connection, per-action policy, approval, and audit pipeline remain
 * the ONLY access path. The Hub's audit trail is the provenance record: every
 * hit carries `provider`, `connectionId`, `indexName`, and the exec action in
 * its metadata, so a retrieval receipt can name exactly which database was
 * queried under which connection.
 *
 * Embeddings are host-owned. `embed` turns the query string into the vector —
 * the same discipline as the QMD provider's vector mode (invoking the host's
 * embedding model is an explicit decision, never implicit).
 *
 * Scores: `score` carries the provider-native score where higher is better
 * (Pinecone similarity, Qdrant similarity); Weaviate distances (lower is
 * better) are mapped through `1/(1+max(0,distance))` so ordering stays
 * monotone. `normalizedScore` is within-set (top hit = 1), the same contract
 * as the filesystem provider — never compare it across queries.
 */

/** Vector databases with a Hub adapter and a similarity-search action. */
export type HubVectorProviderKind = 'pinecone' | 'qdrant' | 'weaviate'

/** The host-owned query embedding: text in, finite float vector out. */
export type HubVectorEmbed = (query: string) => Promise<readonly number[]>

export interface HubVectorSearchProviderOptions {
  /** Platform base URL, e.g. `https://id.tangle.tools`. */
  readonly hubUrl: string
  /** Bearer credential for the Hub (the agent's user or service key). */
  readonly apiKey: string
  /** The Hub connection that owns the vector database credential. */
  readonly connectionId: string
  /** Which connected vector database provider to search. */
  readonly provider: HubVectorProviderKind
  /**
   * Index / collection / class being searched. For Qdrant and Weaviate this
   * targets the query; for Pinecone the data plane is bound by the
   * connection's index host, so the name is provenance on every hit.
   */
  readonly indexName: string
  /** Turns the query string into a vector. Required: embedding is host-owned. */
  readonly embed: HubVectorEmbed
  /** Pinecone namespace within the index. Defaults to the default namespace. */
  readonly namespace?: string
  /** Weaviate properties returned per object (in addition to id + distance). */
  readonly properties?: readonly string[]
  /** Default result count for `search()`. Defaults to 5. */
  readonly defaultLimit?: number
  /** Override fetch (tests + non-Node runtimes). */
  readonly fetchImpl?: typeof fetch
}

export interface HubVectorSearchOptions {
  /** Result count. Defaults to the provider's `defaultLimit`. */
  readonly limit?: number
  /** Precomputed query vector — skips `embed`. Same space as the index. */
  readonly vector?: readonly number[]
  /** Provider-native metadata filter (Pinecone/Qdrant filter object). */
  readonly filter?: Record<string, unknown>
}

/** A hub exec or upstream-provider failure, carrying the hub's status/code. */
export class HubVectorSearchError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | undefined,
  ) {
    super(message)
    this.name = 'HubVectorSearchError'
  }
}

const vectorSchema = z.array(z.number().finite()).min(1).max(20_000)
const searchOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(50).optional(),
    vector: vectorSchema.optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
const queryTextSchema = z.string().trim().min(1).max(16_000)
const providerKindSchema = z.enum(['pinecone', 'qdrant', 'weaviate'])
const graphQlNameSchema = /^[A-Za-z_][A-Za-z0-9_]*$/

const pineconeResultSchema = z
  .object({
    matches: z
      .array(
        z
          .object({
            id: z.union([z.string(), z.number()]),
            score: z.number().optional(),
            metadata: z.record(z.string(), z.unknown()).optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough()

const qdrantResultSchema = z
  .object({
    result: z
      .array(
        z
          .object({
            id: z.union([z.string(), z.number()]),
            score: z.number().optional(),
            payload: z.record(z.string(), z.unknown()).optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough()

const weaviateResultSchema = z
  .object({
    data: z
      .object({
        Get: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).optional(),
      })
      .passthrough(),
    errors: z.array(z.unknown()).optional(),
  })
  .passthrough()

/** Keys commonly carrying human-readable text in vector payloads. */
const TEXT_KEYS = ['text', 'content', 'chunk', 'body', 'snippet', 'pageContent', 'summary'] as const
const TITLE_KEYS = ['title', 'name', 'heading'] as const
const SNIPPET_MAX_CHARS = 400

/** Provider payloads arrive JSON-parsed; the round-trip narrows `unknown` to
 * JSON values for RetrievedKnowledgeHit.metadata without re-validating shape. */
function jsonSafe(
  value: Record<string, unknown> | undefined,
): { [key: string]: JsonValue } | undefined {
  if (!value) return undefined
  return JSON.parse(JSON.stringify(value)) as { [key: string]: JsonValue }
}

function textFromRecord(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined
  for (const key of TEXT_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function titleFromRecord(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined
  for (const key of TITLE_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function snippetFromRecord(record: Record<string, unknown> | undefined): string | undefined {
  const text = textFromRecord(record)
  if (text) return text.length > SNIPPET_MAX_CHARS ? `${text.slice(0, SNIPPET_MAX_CHARS)}…` : text
  if (!record || Object.keys(record).length === 0) return undefined
  const serialized = JSON.stringify(record)
  return serialized.length > SNIPPET_MAX_CHARS
    ? `${serialized.slice(0, SNIPPET_MAX_CHARS)}…`
    : serialized
}

/** Provenance stamped on every hit — the retrieval-receipt fields. */
export interface HubVectorProvenance {
  readonly provider: HubVectorProviderKind
  readonly connectionId: string
  readonly indexName: string
  readonly hubOrigin: string
  readonly action: string
}

/** One hub exec call: bearer-authenticated, envelope-checked, result-unwrapped. */
async function hubExec(
  options: HubVectorSearchProviderOptions,
  path: string,
  input: unknown,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch
  let origin: string
  try {
    origin = new URL(options.hubUrl).origin
  } catch {
    throw new HubVectorSearchError(`invalid hubUrl: ${options.hubUrl}`, 0, 'INVALID_HUB_URL')
  }
  let response: Response
  try {
    response = await fetchImpl(`${origin}/v1/hub/exec`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ path, input, connectionId: options.connectionId }),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new HubVectorSearchError(`hub exec request failed: ${reason}`, 0, 'HUB_UNREACHABLE')
  }
  const text = await response.text()
  let parsed: { success?: boolean; data?: { result?: unknown }; error?: unknown } | null = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      // fall through: a non-JSON body is handled below
    }
  }
  if (!response.ok || parsed?.success === false) {
    const errorBody = parsed?.error
    const code =
      errorBody && typeof errorBody === 'object' && 'code' in errorBody
        ? String((errorBody as { code: unknown }).code)
        : undefined
    const message =
      (errorBody && typeof errorBody === 'object' && 'message' in errorBody
        ? String((errorBody as { message: unknown }).message)
        : typeof errorBody === 'string'
          ? errorBody
          : undefined) ?? `hub exec failed (${response.status})`
    throw new HubVectorSearchError(message, response.status, code)
  }
  if (!parsed || parsed.data === undefined || parsed.data.result === undefined) {
    throw new HubVectorSearchError(
      'hub exec response envelope missing `data.result`',
      response.status,
      'HUB_INVALID_ENVELOPE',
    )
  }
  return parsed.data.result
}

interface RawHit {
  id: string
  score: number | undefined
  record: Record<string, unknown> | undefined
}

export class HubVectorSearchProvider {
  readonly provider: HubVectorProviderKind
  readonly connectionId: string
  readonly indexName: string
  private readonly options: HubVectorSearchProviderOptions
  private readonly defaultLimit: number
  private readonly hubOrigin: string

  constructor(options: HubVectorSearchProviderOptions) {
    this.options = options
    this.provider = providerKindSchema.parse(options.provider)
    this.connectionId = z.string().trim().min(1).parse(options.connectionId)
    this.indexName = z.string().trim().min(1).parse(options.indexName)
    if (this.provider === 'weaviate') {
      if (!graphQlNameSchema.test(this.indexName)) {
        throw new TypeError('Weaviate class name must be a GraphQL identifier')
      }
      for (const property of options.properties ?? []) {
        if (!graphQlNameSchema.test(property)) {
          throw new TypeError(`Weaviate property '${property}' must be a GraphQL identifier`)
        }
      }
    }
    this.defaultLimit = options.defaultLimit ?? 5
    this.hubOrigin = new URL(options.hubUrl).origin
  }

  /** The provenance record a retrieval receipt should carry. */
  get provenance(): HubVectorProvenance {
    return {
      provider: this.provider,
      connectionId: this.connectionId,
      indexName: this.indexName,
      hubOrigin: this.hubOrigin,
      action: this.searchAction(),
    }
  }

  async search(
    query: string,
    searchOptions: HubVectorSearchOptions = {},
  ): Promise<RetrievedKnowledgeHit[]> {
    const text = queryTextSchema.parse(query)
    const options = searchOptionsSchema.parse(searchOptions)
    const vector = vectorSchema.parse(options.vector ?? (await this.options.embed(text)))
    const limit = options.limit ?? this.defaultLimit
    const raw = await this.searchRaw(vector, limit, options.filter)
    return this.hitsFromRaw(raw, limit)
  }

  /** Alias kept for parity with `FileSystemSearchProvider.retrieve`. */
  async retrieve(
    query: string,
    options: HubVectorSearchOptions = {},
  ): Promise<RetrievedKnowledgeHit[]> {
    return this.search(query, options)
  }

  asRetrievalEvalRetriever(): RetrievalEvalRetriever {
    return async ({ scenario, k }) => ({
      hits: await this.search(scenario.query, { limit: k }),
    })
  }

  private searchAction(): string {
    if (this.provider === 'pinecone') return 'vectors.query'
    if (this.provider === 'qdrant') return 'points.search'
    return 'graphql.query'
  }

  private async searchRaw(
    vector: readonly number[],
    limit: number,
    filter: Record<string, unknown> | undefined,
  ): Promise<RawHit[]> {
    if (this.provider === 'pinecone') {
      const result = pineconeResultSchema.parse(
        await hubExec(this.options, 'pinecone.vectors.query', {
          vector: [...vector],
          top_k: limit,
          include_metadata: true,
          ...(this.options.namespace ? { namespace: this.options.namespace } : {}),
          ...(filter ? { filter } : {}),
        }),
      )
      return result.matches.map((match) => ({
        id: String(match.id),
        score: match.score,
        record: match.metadata,
      }))
    }
    if (this.provider === 'qdrant') {
      const result = qdrantResultSchema.parse(
        await hubExec(this.options, 'qdrant.points.search', {
          collection_name: this.indexName,
          vector: [...vector],
          limit,
          with_payload: true,
          ...(filter ? { filter } : {}),
        }),
      )
      return result.result.map((point) => ({
        id: String(point.id),
        score: point.score,
        record: point.payload,
      }))
    }
    const properties = this.options.properties ?? []
    const propertyFields = properties.map((property) => ` ${property}`).join('')
    const graphQl = `{ Get { ${this.indexName}(nearVector: {vector: ${JSON.stringify([...vector])}}, limit: ${limit}) { _additional { id distance }${propertyFields} } } }`
    const result = weaviateResultSchema.parse(
      await hubExec(this.options, 'weaviate.graphql.query', { query: graphQl }),
    )
    if (result.errors && result.errors.length > 0) {
      throw new HubVectorSearchError(
        `weaviate graphql errors: ${JSON.stringify(result.errors).slice(0, SNIPPET_MAX_CHARS)}`,
        200,
        'PROVIDER_GRAPHQL_ERROR',
      )
    }
    const objects = result.data.Get?.[this.indexName] ?? []
    return objects.map((object) => {
      const additional = (object._additional ?? {}) as Record<string, unknown>
      const distance = additional.distance
      return {
        id: String(additional.id ?? ''),
        score:
          typeof distance === 'number' && Number.isFinite(distance)
            ? 1 / (1 + Math.max(0, distance))
            : undefined,
        record: Object.fromEntries(Object.entries(object).filter(([key]) => key !== '_additional')),
      }
    })
  }

  private hitsFromRaw(raw: readonly RawHit[], limit: number): RetrievedKnowledgeHit[] {
    const topScore = raw.reduce(
      (top, hit) => (hit.score !== undefined && hit.score > top ? hit.score : top),
      0,
    )
    return raw.slice(0, limit).map((hit, index) => ({
      pageId: hit.id,
      path: `${this.provider}://${this.indexName}/${hit.id}`,
      ...(titleFromRecord(hit.record) !== undefined ? { title: titleFromRecord(hit.record) } : {}),
      rank: index + 1,
      ...(hit.score !== undefined ? { score: hit.score } : {}),
      ...(topScore > 0 && hit.score !== undefined
        ? { normalizedScore: Math.min(1, Math.max(0, hit.score / topScore)) }
        : {}),
      ...(snippetFromRecord(hit.record) !== undefined
        ? { snippet: snippetFromRecord(hit.record) }
        : {}),
      metadata: {
        provider: this.provider,
        connectionId: this.connectionId,
        indexName: this.indexName,
        hubOrigin: this.hubOrigin,
        action: this.searchAction(),
        retrievedAt: new Date().toISOString(),
        ...(hit.record ? { payload: jsonSafe(hit.record) } : {}),
      },
    }))
  }
}

export function createHubVectorSearchProvider(
  options: HubVectorSearchProviderOptions,
): HubVectorSearchProvider {
  return new HubVectorSearchProvider(options)
}
