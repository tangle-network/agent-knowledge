import { canonicalJson } from '@tangle-network/agent-eval'
import { describe, expect, it } from 'vitest'
import { sha256 } from '../../src/ids'
import {
  type AgentMemoryBranchSnapshot,
  createAgentMemoryBranch,
  createHindsightMemoryAdapter,
  createPlayMemoryTools,
  forkAgentMemoryBranchSnapshot,
  type HindsightClientLike,
  HindsightOperationUnknownError,
} from '../../src/memory/index'

// Protocol fixture follows the pinned 0.10.2 OpenAPI. It tests orchestration, not model quality.
/** The fixture Hindsight. Ingestion completes at once, so success paths get a deadline a loaded CI host cannot
 *  miss; only the test of the unresolved path waits out a short one. */
function server({ ingestionTimeoutMs = 10_000 }: { ingestionTimeoutMs?: number } = {}) {
  type Document = {
    id: string
    bank_id: string
    original_text: string
    document_metadata: Record<string, string>
  }
  type Operation = { operation_id: string; status: string; document: Document }
  const documents = new Map<string, Document>()
  const operations = new Map<string, Operation>()
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const state = { version: '0.10.2', complete: true, lostAcknowledgement: false, retains: 0 }
  const client: HindsightClientLike = {
    async request(input) {
      calls.push(input)
      if (input.path === '/version') return { status: 200, body: { api_version: state.version } }
      const match = /^\/v1\/default\/banks\/([^/]+)(.*)$/.exec(input.path)!
      const bank = match[1]!
      const route = match[2]!
      if (route.startsWith('/documents/'))
        return {
          status: documents.has(bank + route) ? 200 : 404,
          body: documents.get(bank + route),
        }
      if (route.startsWith('/operations/')) {
        const operation = operations.get(bank + route)
        if (!operation) return { status: 404, body: {} }
        if (state.complete && operation.status === 'pending') {
          operation.status = 'completed'
          documents.set(`${bank}/documents/${operation.document.id}`, operation.document)
        }
        return {
          status: 200,
          body: { operation_id: operation.operation_id, status: operation.status },
        }
      }
      if (route === '/memories') {
        const body = input.body as {
          operation_id: string
          items: Array<{ content: string; document_id: string; metadata: Record<string, string> }>
        }
        expect(body.items).toHaveLength(1)
        const item = body.items[0]!
        const key = `${bank}/operations/${body.operation_id}`
        if (!operations.has(key)) {
          state.retains++
          operations.set(key, {
            operation_id: body.operation_id,
            status: 'pending',
            document: {
              id: item.document_id,
              bank_id: bank,
              original_text: item.content,
              document_metadata: item.metadata,
            },
          })
        }
        if (state.lostAcknowledgement) {
          state.lostAcknowledgement = false
          throw new Error('connection closed after acceptance')
        }
        return {
          status: 200,
          body: { success: true, bank_id: bank, async: true, operation_id: body.operation_id },
        }
      }
      if (route === '/memories/recall')
        return {
          status: 200,
          body: {
            results: [...documents.values()]
              .filter((doc) => doc.bank_id === bank)
              .map((doc) => ({
                id: doc.id,
                text: doc.original_text,
                type: 'world',
                document_id: doc.id,
                metadata: doc.document_metadata,
                source_fact_ids: [],
                scores: { final: 0.9 },
              })),
            source_facts: {},
            source_facts_truncated: false,
          },
        }
      throw new Error(`unexpected protocol ${input.method} ${input.path}`)
    },
  }
  function adapter(branchId: string) {
    return createHindsightMemoryAdapter({
      client,
      backendRef: 'fixture-0.10.2',
      branchId,
      ingestionTimeoutMs,
      pollIntervalMs: 1,
    })
  }
  function branch(branchId = 'parent', namespace = 'play-a') {
    return createAgentMemoryBranch({
      adapter: adapter(branchId),
      branchId,
      baseScope: { namespace },
      policy: { read: ['shared'], write: 'shared' },
    })
  }
  return { state, calls, documents, operations, adapter, branch }
}

const first = {
  id: 'source-a:observation-1',
  kind: 'observation' as const,
  text: 'Fixture finding: hydrogen cost is unmeasured.',
  sourceRefs: ['source-a#sha256:fixture'],
}

describe('play memory Hindsight protocol and durable tool boundary', () => {
  it('shares collaborators, persists accepted bytes, rebinds and forks a checkpoint without later parent writes', async () => {
    const f = server()
    const parent = f.branch()
    const checkpoints: AgentMemoryBranchSnapshot[] = []
    const receipts: unknown[] = []
    const [recall, record] = createPlayMemoryTools({
      branch: parent,
      actorId: 'director',
      onCheckpoint: (value) => {
        checkpoints.push(value)
      },
      recordRetrieval: (value) => {
        receipts.push(value)
      },
    })
    await record!.handler!(first, {})
    const checkpoint = JSON.parse(JSON.stringify(checkpoints[0]!)) as AgentMemoryBranchSnapshot
    const child = await forkAgentMemoryBranchSnapshot({
      snapshot: checkpoint,
      adapter: f.adapter('fork'),
      branchId: 'fork',
      baseScope: { namespace: 'play-fork' },
    })
    await record!.handler!({ ...first, id: 'later', text: 'Later parent-only observation.' }, {})
    const [workerRecall] = createPlayMemoryTools({
      branch: parent,
      actorId: 'grandchild',
      onCheckpoint: () => {},
    })
    const result = (await workerRecall!.handler!({ question: 'hydrogen' }, {})) as {
      hits: unknown[]
      receipt: { receiptDigest: string }
    }
    expect(result.hits).toHaveLength(2)
    expect((await child.search('hydrogen')).map((hit) => hit.text)).toEqual([first.text])
    expect(await f.branch('unrelated', 'play-b').search('hydrogen')).toEqual([])
    const latest = await parent.snapshot()
    const resumed = createAgentMemoryBranch({
      adapter: f.adapter('parent'),
      branchId: 'parent',
      snapshot: JSON.parse(JSON.stringify(latest)),
    })
    expect(await resumed.search('hydrogen')).toHaveLength(2)
    const replayRecord = createPlayMemoryTools({
      branch: resumed,
      actorId: 'director',
      onCheckpoint: () => {},
    })[1]!
    await replayRecord.handler!(first, {})
    expect((await resumed.snapshot()).journal).toHaveLength(2)
    expect(f.state.retains).toBe(3)
    const recalled = (await recall!.handler!({ question: 'hydrogen' }, {})) as {
      receipt: Record<string, unknown>
    }
    const { receiptDigest, ...content } = JSON.parse(JSON.stringify(recalled.receipt))
    expect(receiptDigest).toBe(`sha256:${sha256(canonicalJson(content))}`)
    expect(receipts).toHaveLength(1)
    expect(checkpoint.journal[0]?.input.metadata).toEqual({
      actorId: 'director',
      sourceRefs: first.sourceRefs,
    })
  })

  it('reconciles an ambiguous retain by the same operation ID before checkpointing; changed content and intervening writes are refused', async () => {
    const f = server()
    const branch = f.branch()
    let published = 0
    const record = createPlayMemoryTools({
      branch,
      actorId: 'director',
      onCheckpoint: () => {
        published++
      },
    })[1]!
    f.state.lostAcknowledgement = true
    await expect(record.handler!(first, {})).rejects.toBeInstanceOf(HindsightOperationUnknownError)
    await expect(branch.snapshot()).rejects.toBeInstanceOf(HindsightOperationUnknownError)
    await expect(record.handler!({ ...first, id: 'different' }, {})).rejects.toThrow(
      'reconcile the prior',
    )
    await record.handler!(first, {})
    expect(f.state.retains).toBe(1)
    expect(published).toBe(1)
    expect((await branch.snapshot()).journal).toHaveLength(1)
    await expect(record.handler!({ ...first, text: 'changed' }, {})).rejects.toThrow(
      'different content',
    )
  })

  it('does not acknowledge before durable checkpoint publication and retries publication without duplicate retain', async () => {
    const f = server()
    const branch = f.branch()
    let fail = true
    const record = createPlayMemoryTools({
      branch,
      actorId: 'director',
      onCheckpoint: () => {
        if (fail) throw new Error('disk failed')
      },
    })[1]!
    await expect(record.handler!(first, {})).rejects.toThrow('disk failed')
    fail = false
    await record.handler!(first, {})
    expect(f.state.retains).toBe(1)
    expect((await branch.snapshot()).journal).toHaveLength(1)
  })

  it('keeps timed out and expired-operation state unknown instead of inventing completion', async () => {
    const f = server({ ingestionTimeoutMs: 10 })
    const branch = f.branch()
    f.state.complete = false
    await expect(branch.write(first)).rejects.toBeInstanceOf(HindsightOperationUnknownError)
    await expect(branch.snapshot()).rejects.toBeInstanceOf(HindsightOperationUnknownError)
    f.state.complete = true
    await branch.write(first)
    f.operations.clear()
    const fresh = f.branch()
    await expect(fresh.write(first)).rejects.toBeInstanceOf(HindsightOperationUnknownError)
    await expect(fresh.snapshot()).rejects.toBeInstanceOf(HindsightOperationUnknownError)
    expect(f.state.retains).toBe(1)
  })

  it('rejects caller scope overrides and an unqualified backend before retaining', async () => {
    const f = server()
    const tools = createPlayMemoryTools({
      branch: f.branch(),
      actorId: 'director',
      onCheckpoint: () => {},
    })
    await expect(
      tools[1]!.handler!({ ...first, scope: { namespace: 'foreign' } }, {}),
    ).rejects.toThrow()
    await expect(tools[0]!.handler!({ question: 'facts', bankId: 'foreign' }, {})).rejects.toThrow()
    expect(f.calls).toHaveLength(0)
    f.state.version = '0.10.3'
    await expect(tools[1]!.handler!(first, {})).rejects.toThrow('qualified 0.10.2')
    expect(f.state.retains).toBe(0)
  })

  it('rejects provider document corruption under a stable ID without overwriting it', async () => {
    const f = server()
    const branch = f.branch()
    await branch.write(first)
    const document = [...f.documents.values()][0]!
    document.original_text = 'unexpected replacement'
    await expect(f.branch().write(first)).rejects.toThrow('identity or bytes differ')
    expect(f.state.retains).toBe(1)
  })
})
