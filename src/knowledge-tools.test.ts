import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '@tangle-network/agent-interface'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KnowledgeCitationResolutionError } from './citation-resolution'
import { createKnowledgeTools } from './knowledge-tools'
import {
  assertKnowledgeRetrievalMatchesVisibility,
  assertKnowledgeRetrievalMatchesVisibilityArtifact,
  createKnowledgeRetrievalDisposition,
  createKnowledgeVisibilitySnapshot,
  type KnowledgeRetrievalReceipt,
  verifyKnowledgeRetrievalDisposition,
} from './knowledge-use-receipts'
import { createRunScopedStores, type RunScopedStores } from './run-scoped'
import { initKnowledgeBase } from './store'

let root: string
let shared: string
let stores: RunScopedStores
let recorded: KnowledgeRetrievalReceipt[]
let tools: Map<string, ToolDefinition>

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'knowledge-tools-')))
  shared = await realpath(await mkdtemp(join(tmpdir(), 'knowledge-tools-shared-')))
  stores = createRunScopedStores({ root, sharedRoot: shared })
  await stores.init('run-a')
  recorded = []
  tools = new Map(
    createKnowledgeTools({
      stores,
      runId: 'run-a',
      retrieverVersion: '10.6.0',
      actorId: 'analyst',
      intake: {},
      recordRetrieval: (receipt) => {
        recorded.push(receipt)
      },
    }).map((tool) => [tool.name, tool]),
  )
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(shared, { recursive: true, force: true })
})

const call = async (name: string, input: unknown) =>
  (await tools.get(name)!.handler(input, {})) as Record<string, unknown>

async function writePage(storeRoot: string, id: string, body: string) {
  await writeFile(join(storeRoot, 'knowledge', `${id}.md`), `---\nid: ${id}\n---\n\n${body}\n`)
}

describe('createKnowledgeTools', () => {
  it('persists one exact visibility artifact for concurrent receipts and verifies it after mutation', async () => {
    await writePage(stores.storePath('run-a'), 'budget', 'Retry budget is three attempts.')
    await Promise.all([
      call('knowledge_search', { question: 'retry budget' }),
      call('knowledge_search', { question: 'three attempts' }),
    ])
    const first = recorded[0]!
    expect(first.visibility.artifact).toBeDefined()
    expect(recorded[1]!.visibility.artifact).toEqual(first.visibility.artifact)
    expect(
      await readdir(join(stores.storePath('run-a'), '.agent-knowledge/retrieval-visibility')),
    ).toHaveLength(1)
    await writePage(stores.storePath('run-a'), 'budget', 'Retry budget is now five attempts.')
    await assertKnowledgeRetrievalMatchesVisibilityArtifact(first, (ref) =>
      readFile(new URL(ref.uri)),
    )
    await call('knowledge_search', { question: 'retry budget' })
    expect(recorded[2]!.visibility.artifact).not.toEqual(first.visibility.artifact)
    await assertKnowledgeRetrievalMatchesVisibilityArtifact(recorded[2]!, (ref) =>
      readFile(new URL(ref.uri)),
    )
  })

  it('refuses corrupt stored visibility bytes before recording another receipt', async () => {
    await writePage(stores.storePath('run-a'), 'budget', 'Retry budget is three attempts.')
    await call('knowledge_search', { question: 'retry budget' })
    await writeFile(new URL(recorded[0]!.visibility.artifact!.uri), 'corrupt')
    await expect(call('knowledge_search', { question: 'retry budget' })).rejects.toThrow(
      'content identity',
    )
    expect(recorded).toHaveLength(1)
  })

  it('mints a retrieval receipt the visibility snapshot verifies', async () => {
    await writePage(
      stores.storePath('run-a'),
      'retry-budget',
      'A retry budget caps the retries one run may spend before the run is refused.',
    )

    const result = await call('knowledge_search', { question: 'retry budget' })

    expect(result.citationIds).toEqual(['retry-budget'])
    expect(result.text).toContain('[retry-budget]')
    expect(recorded).toHaveLength(1)
    assertKnowledgeRetrievalMatchesVisibility(
      recorded[0]!,
      createKnowledgeVisibilitySnapshot(await stores.loadChain('run-a')),
    )
    expect(result.retrievalReceiptDigest).toBe(recorded[0]!.receiptDigest)
  })

  it('applies the write intake gate to a recorded proposal', async () => {
    await expect(
      call('knowledge_record', {
        proposal:
          '---FILE: knowledge/claim.md---\n---\nid: claim\ncites:\n  - absent\n---\n\nA claim with no target.\n---END FILE---\n',
      }),
    ).rejects.toThrow(KnowledgeCitationResolutionError)

    const written = await call('knowledge_record', {
      proposal:
        '---FILE: knowledge/claim.md---\n---\nid: claim\n---\n\nA claim standing on its own.\n---END FILE---\n',
    })
    expect(written.written).toEqual(['knowledge/claim.md'])
  })

  it('reports an id visible at two origins instead of choosing one', async () => {
    await writePage(stores.storePath('run-a'), 'budget', 'The run-local version of the budget.')
    await initKnowledgeBase(shared)
    await writePage(shared, 'budget', 'The shared version of the budget.')

    const read = await call('knowledge_read', { pageId: 'budget' })
    expect(read.status).toBe('ambiguous')
    expect(read.page).toBeNull()
    expect((read.candidates as Array<{ origin: string }>).map((entry) => entry.origin)).toEqual([
      'here',
      'shared',
    ])

    const qualified = await call('knowledge_read', { pageId: 'shared::budget' })
    expect(qualified.status).toBe('resolved')
    expect((qualified.page as { text: string }).text).toContain('shared version')
  })
})

describe('createKnowledgeRetrievalDisposition', () => {
  it('binds a no-use record to one exact retrieval and refuses any other', async () => {
    await writePage(stores.storePath('run-a'), 'retry-budget', 'A retry budget caps retries.')
    const first = (await call('knowledge_search', { question: 'retry budget' }))
      .receipt as KnowledgeRetrievalReceipt
    const second = (await call('knowledge_search', { question: 'retries' }))
      .receipt as KnowledgeRetrievalReceipt

    const disposition = createKnowledgeRetrievalDisposition({
      retrieval: first,
      relation: 'no-use',
      consumer: { kind: 'decision', uri: 'decision://run-a/1' },
      createdAt: '2026-08-21T00:00:00.000Z',
    })

    expect(verifyKnowledgeRetrievalDisposition(disposition, first).relation).toBe('no-use')
    expect(() => verifyKnowledgeRetrievalDisposition(disposition, second)).toThrow(
      'references a different retrieval receipt',
    )
  })
})
