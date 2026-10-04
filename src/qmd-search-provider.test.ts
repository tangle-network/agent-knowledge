import { describe, expect, it } from 'vitest'
import { sha256 } from './ids'
import {
  createQmdKnowledgeTools,
  createQmdSearchProvider,
  type QmdSearchClient,
} from './qmd-search-provider'

function fixture() {
  const body = '# Checked finding\nHydrogen throughput was not independently measured.\n'
  const document = {
    qmdPath: 'qmd://play-a/finding.md',
    source: {
      id: 'finding',
      uri: 'https://example.test/revisions/a/finding',
      title: 'Finding',
      contentHash: sha256(body),
      createdAt: '2026-10-04T00:00:00Z',
    },
  }
  const calls: unknown[] = []
  const state = { body, paths: [document.qmdPath], collection: 'play-a' }
  const client: QmdSearchClient = {
    async searchLex(query, options) {
      calls.push({ query, ...options })
      return state.paths.map((filepath) => ({ filepath, score: 0.7 }))
    },
    async get(filepath, options) {
      calls.push({ filepath, ...options })
      return { filepath, collectionName: state.collection, body: state.body }
    },
  }
  const options = {
    client,
    scopeId: 'play-a',
    revision: 'checkpoint-1',
    collection: 'play-a',
    documents: [document],
  }
  return { body, document, state, calls, options }
}

describe('source-bound QMD retrieval', () => {
  it('uses exact collection and source bytes across readers, tools, and reopen', async () => {
    const f = fixture()
    const provider = createQmdSearchProvider(f.options)
    const reopened = createQmdSearchProvider(f.options)
    expect(await provider.verifySnapshot()).toMatchObject({ verifiedDocumentCount: 1 })
    f.calls.length = 0
    const result = await provider.search('Hydrogen', { limit: 2 })
    expect(result.hits[0]?.source.text).toBe(f.body)
    expect(result.indexedAt).toBeNull()
    expect(result.snapshotDigest).toBe(reopened.snapshotDigest)
    expect(f.calls[0]).toEqual({ query: 'Hydrogen', collection: 'play-a', limit: 2 })
    const tools = createQmdKnowledgeTools({ provider, namePrefix: 'agent_runtime_coordination_' })
    expect(tools.map((tool) => tool.name)).toEqual([
      'agent_runtime_coordination_qmd_search',
      'agent_runtime_coordination_qmd_read',
    ])
    expect(
      await tools[1]!.handler!({ sourceId: 'finding', fromLine: 2, maxLines: 1 }, {}),
    ).toMatchObject({
      scopeId: 'play-a',
      document: { text: '2: Hydrogen throughput was not independently measured.' },
    })
    f.document.source.contentHash = sha256('changed outside the factory')
    expect((await provider.read('finding')).document.source.contentHash).toBe(sha256(f.body))
    const source = (await provider.read('finding')).document.source
    source.contentHash = sha256('changed returned source')
    expect((await provider.read('finding')).document.source.contentHash).toBe(sha256(f.body))
  })

  it('rejects scope overrides, foreign results, and stale bytes without falling back', async () => {
    const f = fixture()
    const provider = createQmdSearchProvider(f.options)
    const [search] = createQmdKnowledgeTools({ provider })
    await expect(
      search!.handler!({ query: 'Hydrogen', collection: 'play-b' }, {}),
    ).rejects.toThrow()
    await expect(provider.read('other-play-id')).rejects.toThrow('not in the bound')
    expect(f.calls).toHaveLength(0)
    f.state.paths = ['qmd://play-b/private.md']
    await expect(provider.search('Hydrogen')).rejects.toThrow('outside the bound')
    expect(f.calls).toHaveLength(1)
    f.state.paths = [f.document.qmdPath]
    f.state.body += 'New parent work after the checkpoint.'
    await expect(provider.verifySnapshot()).rejects.toThrow('stale')
    await expect(provider.search('Hydrogen')).rejects.toThrow('stale')
    await expect(provider.read('finding')).rejects.toThrow('stale')
    f.state.body = f.body
    f.state.collection = 'play-b'
    await expect(provider.read('finding')).rejects.toThrow('outside the bound')
  })

  it('rejects ambiguous manifests and never silently enables model-backed retrieval', async () => {
    const f = fixture()
    expect(() => createQmdSearchProvider({ ...f.options, mode: 'vector' })).toThrow('unavailable')
    expect(() =>
      createQmdSearchProvider({ ...f.options, documents: [f.document, f.document] }),
    ).toThrow('duplicate')
    expect(() =>
      createQmdSearchProvider({
        ...f.options,
        documents: [{ ...f.document, qmdPath: 'qmd://play-a/../private.md' }],
      }),
    ).toThrow('bound collection')
    expect(() =>
      createQmdSearchProvider({
        ...f.options,
        documents: [{ ...f.document, source: { ...f.document.source, text: 'invented' } }],
      }),
    ).toThrow('contentHash')
    const vectorCalls: string[] = []
    const provider = createQmdSearchProvider({
      ...f.options,
      mode: 'vector',
      client: {
        ...f.options.client,
        async searchVector(query, options) {
          vectorCalls.push(query)
          return f.options.client.searchLex(query, options)
        },
      },
    })
    await provider.search('What do we know about hydrogen production?')
    expect(vectorCalls).toHaveLength(1)
  })
})
