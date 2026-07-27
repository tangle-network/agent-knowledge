import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMem0MemoryAdapter } from '../../src/memory/index'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('Mem0 OSS integration', () => {
  it('writes, searches, and clears real SQLite memory without external API calls', async () => {
    vi.stubEnv('MEM0_TELEMETRY', 'false')
    const directory = await mkdtemp(join(tmpdir(), 'agent-knowledge-mem0-'))
    temporaryDirectories.push(directory)
    const embeddingServer = await startEmbeddingServer()
    const vectorDbPath = join(directory, 'vectors.db')
    const historyDbPath = join(directory, 'history.db')

    try {
      const { Memory } = await import('mem0ai/oss')
      const memory = new Memory({
        embedder: {
          provider: 'openai',
          config: {
            apiKey: 'local-test-key',
            baseURL: embeddingServer.baseUrl,
            embeddingDims: 3,
            model: 'deterministic-test-embedding',
          },
        },
        vectorStore: {
          provider: 'memory',
          config: {
            collectionName: 'agent-knowledge-contract',
            dbPath: vectorDbPath,
            dimension: 3,
          },
        },
        llm: {
          provider: 'openai',
          config: {
            apiKey: 'unused-local-test-key',
            baseURL: embeddingServer.baseUrl,
            model: 'unused-local-test-model',
          },
        },
        historyStore: { provider: 'sqlite', config: { historyDbPath } },
      })
      const adapter = createMem0MemoryAdapter({ client: memory, infer: false, mode: 'oss' })
      const scope = { userId: 'sqlite-user' }

      const write = await adapter.write({
        kind: 'fact',
        text: 'SQLite memory survives the adapter boundary.',
        scope,
      })
      const hits = await adapter.search('SQLite memory', { scope, limit: 5 })
      const history = await memory.history(write.id)

      expect(write).toMatchObject({ accepted: true, kind: 'fact' })
      expect(hits).toMatchObject([
        { id: write.id, kind: 'fact', text: 'SQLite memory survives the adapter boundary.' },
      ])
      expect(history.length).toBeGreaterThan(0)
      await expect(stat(vectorDbPath)).resolves.toMatchObject({ size: expect.any(Number) })
      await expect(stat(historyDbPath)).resolves.toMatchObject({ size: expect.any(Number) })

      await adapter.clear?.(scope)

      await expect(adapter.search('SQLite memory', { scope, limit: 5 })).resolves.toEqual([])
      expect(embeddingServer.paths.length).toBeGreaterThanOrEqual(2)
      expect(new Set(embeddingServer.paths)).toEqual(new Set(['/v1/embeddings']))
    } finally {
      await embeddingServer.close()
    }
  })
})

async function startEmbeddingServer(): Promise<{
  baseUrl: string
  close: () => Promise<void>
  paths: string[]
}> {
  const paths: string[] = []
  const server = createServer(async (request, response) => {
    paths.push(request.url ?? '')
    if (request.method !== 'POST' || request.url !== '/v1/embeddings') {
      response.writeHead(404).end()
      return
    }

    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body) as { input?: string | string[] }
    const inputs = Array.isArray(payload.input) ? payload.input : [payload.input ?? '']
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        data: inputs.map((_input, index) => ({
          embedding: [1, 0.5, 0.25],
          index,
          object: 'embedding',
        })),
        model: 'deterministic-test-embedding',
        object: 'list',
        usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
      }),
    )
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('failed to bind the local Mem0 embedding server')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    paths,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
