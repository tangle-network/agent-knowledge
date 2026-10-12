import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHubVectorSearchProvider, HubVectorSearchError } from './hub-vector-search-provider'
import type { RetrievedKnowledgeHit } from './retrieval-eval'

const baseOptions = {
  hubUrl: 'https://id.tangle.tools',
  apiKey: 'sk-tan-test',
  connectionId: 'conn_pinecone_1',
  provider: 'pinecone' as const,
  indexName: 'docs',
  embed: async () => [0.1, 0.2, 0.3],
}

function mockFetch(body: unknown, init: { status?: number } = {}) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('HubVectorSearchProvider', () => {
  it('routes pinecone search through /v1/hub/exec with bearer auth and the connection id', async () => {
    const fetchMock = mockFetch({
      success: true,
      data: {
        result: {
          matches: [
            { id: 'vec-1', score: 0.92, metadata: { text: 'How to branch', title: 'Branching' } },
            { id: 'vec-2', score: 0.46, metadata: { text: 'Other doc' } },
          ],
        },
      },
    })
    const provider = createHubVectorSearchProvider({ ...baseOptions, namespace: 'kb' })
    const hits = await provider.search('how do I branch safely?')

    const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const url = new URL(calledUrl)
    expect(url.origin).toBe('https://id.tangle.tools')
    expect(url.pathname).toBe('/v1/hub/exec')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-tan-test')
    const body = JSON.parse(String(init.body))
    expect(body).toEqual({
      path: 'pinecone.vectors.query',
      connectionId: 'conn_pinecone_1',
      input: {
        vector: [0.1, 0.2, 0.3],
        top_k: 5,
        include_metadata: true,
        namespace: 'kb',
      },
    })

    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({
      pageId: 'vec-1',
      path: 'pinecone://docs/vec-1',
      title: 'Branching',
      rank: 1,
      score: 0.92,
      normalizedScore: 1,
      snippet: 'How to branch',
    })
    // Provenance receipt: which database, which connection, which action.
    expect(hits[0]?.metadata).toMatchObject({
      provider: 'pinecone',
      connectionId: 'conn_pinecone_1',
      indexName: 'docs',
      action: 'pinecone.vectors.query'.split('.').slice(1).join('.'),
      hubOrigin: 'https://id.tangle.tools',
    })
    expect(hits[1]?.normalizedScore).toBeCloseTo(0.46 / 0.92, 5)
  })

  it('routes qdrant search through the points.search action with collection and payload', async () => {
    const fetchMock = mockFetch({
      success: true,
      data: {
        result: {
          result: [{ id: 42, score: 0.75, payload: { text: 'Restore branch data' } }],
        },
      },
    })
    const provider = createHubVectorSearchProvider({
      ...baseOptions,
      provider: 'qdrant',
      connectionId: 'conn_qdrant_1',
      indexName: 'chunks',
    })
    const hits = await provider.search('restore', { limit: 3 })

    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    )
    expect(body.path).toBe('qdrant.points.search')
    expect(body.connectionId).toBe('conn_qdrant_1')
    expect(body.input).toEqual({
      collection_name: 'chunks',
      vector: [0.1, 0.2, 0.3],
      limit: 3,
      with_payload: true,
    })

    expect(hits[0]).toMatchObject({
      pageId: '42',
      path: 'qdrant://chunks/42',
      rank: 1,
      snippet: 'Restore branch data',
    })
  })

  it('builds a weaviate nearVector GraphQL query and maps distance to a monotone score', async () => {
    const fetchMock = mockFetch({
      success: true,
      data: {
        result: {
          data: {
            Get: {
              Doc: [
                { _additional: { id: 'uuid-1', distance: 0 }, title: 'Exact match' },
                { _additional: { id: 'uuid-2', distance: 1 }, title: 'Near match' },
              ],
            },
          },
        },
      },
    })
    const provider = createHubVectorSearchProvider({
      ...baseOptions,
      provider: 'weaviate',
      connectionId: 'conn_weaviate_1',
      indexName: 'Doc',
      properties: ['title'],
    })
    const hits = await provider.search('exact')

    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    )
    expect(body.path).toBe('weaviate.graphql.query')
    expect(body.input.query).toBe(
      '{ Get { Doc(nearVector: {vector: [0.1,0.2,0.3]}, limit: 5) { _additional { id distance } title } } }',
    )

    expect(hits[0]?.pageId).toBe('uuid-1')
    expect(hits[0]?.title).toBe('Exact match')
    expect(hits[0]?.score).toBe(1)
    expect(hits[0]?.normalizedScore).toBe(1)
    expect(hits[1]?.score).toBeCloseTo(0.5, 6)
    expect(hits[1]?.normalizedScore).toBeCloseTo(0.5, 6)
  })

  it('surfaces a hub policy denial as a clear error carrying the code', async () => {
    mockFetch(
      {
        success: false,
        error: {
          code: 'POLICY_DENIED',
          message: 'Action vectors.query is not allowed for this connection',
        },
      },
      { status: 403 },
    )
    const provider = createHubVectorSearchProvider(baseOptions)

    await expect(provider.search('anything')).rejects.toMatchObject({
      name: 'HubVectorSearchError',
      status: 403,
      code: 'POLICY_DENIED',
      message: expect.stringContaining('not allowed'),
    } satisfies Partial<HubVectorSearchError>)
  })

  it('rejects a malformed success envelope instead of returning fabricated hits', async () => {
    mockFetch({ success: true, data: {} })
    const provider = createHubVectorSearchProvider(baseOptions)
    await expect(provider.search('anything')).rejects.toThrow(HubVectorSearchError)
  })

  it('uses a caller-supplied vector and skips the embed call', async () => {
    const embed = vi.fn(async () => [9, 9, 9])
    const fetchMock = mockFetch({ success: true, data: { result: { matches: [] } } })
    const provider = createHubVectorSearchProvider({ ...baseOptions, embed })

    expect(await provider.search('query', { vector: [0.5, 0.5] })).toEqual([])
    expect(embed).not.toHaveBeenCalled()
    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    )
    expect(body.input.vector).toEqual([0.5, 0.5])
    expect(body.input.top_k).toBe(5)
  })

  it('returns the filesystem provider hit shape (rank 1-based, top hit normalized to 1)', async () => {
    mockFetch({
      success: true,
      data: { result: { matches: [{ id: 'only', score: 0.3, metadata: { text: 'only hit' } }] } },
    })
    const provider = createHubVectorSearchProvider(baseOptions)
    const hits: RetrievedKnowledgeHit[] = await provider.retrieve('only')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.rank).toBe(1)
    expect(hits[0]?.normalizedScore).toBe(1)
    expect(typeof hits[0]?.metadata?.retrievedAt).toBe('string')
  })

  it('exposes provenance for retrieval receipts without running a search', () => {
    const provider = createHubVectorSearchProvider(baseOptions)
    expect(provider.provenance).toEqual({
      provider: 'pinecone',
      connectionId: 'conn_pinecone_1',
      indexName: 'docs',
      hubOrigin: 'https://id.tangle.tools',
      action: 'vectors.query',
    })
  })
})
