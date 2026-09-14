import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KnowledgeCitationResolutionError } from './citation-resolution'
import { knowledgePageDigest } from './knowledge-use-receipts'
import {
  KnowledgePromotionError,
  loadKnowledgePromotionRecord,
  promoteRunScopedPages,
} from './promotion'
import { applyKnowledgeWriteBlocks } from './proposals'
import { createRunScopedStores, type RunScopedStores } from './run-scoped'
import * as store from './store'
import { loadKnowledgePages } from './store'

let root: string
let shared: string
let stores: RunScopedStores

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'promotion-')))
  shared = await realpath(await mkdtemp(join(tmpdir(), 'promotion-shared-')))
  stores = createRunScopedStores({ root, sharedRoot: shared })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
  await rm(shared, { recursive: true, force: true })
})

async function addPage(runId: string, id: string, frontmatter: string, body: string) {
  await writeFile(
    join(stores.storePath(runId), 'knowledge', `${id}.md`),
    `---\nid: ${id}\n${frontmatter}---\n\n${body}\n`,
  )
}

describe('promoteRunScopedPages', () => {
  it('carries the run-local support a promoted claim cites, at its own evidence level', async () => {
    await stores.init('run-a')
    await addPage('run-a', 'measurement', 'rung: 4\n', 'The measured latency was 32 ms.')
    await addPage(
      'run-a',
      'claim',
      'rung: 2\ncites:\n  - measurement\n',
      'Latency is the dominant term.',
    )

    const record = await promoteRunScopedPages(stores, 'run-a', {
      pageIds: ['claim'],
      sharedRoot: shared,
      actor: 'drew',
      reason: 'The measurement replicated twice.',
    })

    expect(record.entries.map((entry) => [entry.pageId, entry.requested])).toEqual([
      ['claim', true],
      ['measurement', false],
    ])
    const promoted = await loadKnowledgePages(shared)
    expect(promoted.map((page) => page.id).sort()).toEqual(['claim', 'measurement'])
    expect(promoted.find((page) => page.id === 'measurement')!.frontmatter.rung).toBe(4)
    expect(promoted.find((page) => page.id === 'claim')!.frontmatter.rung).toBe(2)
    for (const entry of record.entries) {
      expect(entry.pageDigest).toBe(
        knowledgePageDigest(promoted.find((page) => page.id === entry.pageId)!),
      )
    }
    expect(await readFile(join(shared, 'knowledge', 'claim.md'), 'utf8')).toBe(
      await readFile(join(stores.storePath('run-a'), 'knowledge', 'claim.md'), 'utf8'),
    )
  })

  it.each(['claim', 'measurement'])(
    'refuses changed source bytes in %s after reading the citation closure',
    async (changedId) => {
      await stores.init('run-a')
      await addPage('run-a', 'measurement', '', 'The measured latency was 32 ms.')
      await addPage('run-a', 'claim', 'cites: [measurement]\n', 'Latency is the dominant term.')
      const concurrentStores: RunScopedStores = {
        ...stores,
        async loadChain(runId) {
          const snapshot = await stores.loadChain(runId)
          await applyKnowledgeWriteBlocks(
            stores.storePath(runId),
            `---FILE: knowledge/${changedId}.md---\n---\nid: ${changedId}\ncites: [uninspected-source]\n---\nChanged after the promotion snapshot.\n---END FILE---`,
          )
          return snapshot
        },
      }

      await expect(
        promoteRunScopedPages(concurrentStores, 'run-a', {
          pageIds: ['claim'],
          sharedRoot: shared,
          actor: 'drew',
          reason: 'testing concurrent source edits',
        }),
      ).rejects.toThrow(/source page .* changed after the promotion snapshot/)
      expect(await loadKnowledgePages(shared)).toEqual([])
    },
  )

  it('promotes the inspected frozen pages when the source changes before destination initialization', async () => {
    await stores.init('run-a')
    await addPage('run-a', 'measurement', '', 'The measured latency was 32 ms.')
    await addPage('run-a', 'claim', 'cites: [measurement]\n', 'Latency is the dominant term.')
    await addPage('run-a', 'unselected', '', 'Unrelated research remains local.')
    const inspected = await loadKnowledgePages(stores.storePath('run-a'))
    const unselected = await readFile(
      join(stores.storePath('run-a'), 'knowledge', 'unselected.md'),
      'utf8',
    )
    const initialize = store.initKnowledgeBase
    vi.spyOn(store, 'initKnowledgeBase').mockImplementationOnce(async (destination) => {
      await applyKnowledgeWriteBlocks(
        stores.storePath('run-a'),
        '---FILE: knowledge/claim.md---\n---\nid: claim\ncites: [uninspected-source]\n---\nChanged after source capture.\n---END FILE---',
      )
      return initialize(destination)
    })

    const record = await promoteRunScopedPages(stores, 'run-a', {
      pageIds: ['claim'],
      sharedRoot: shared,
      actor: 'drew',
      reason: 'testing frozen source bytes',
    })

    const promoted = await loadKnowledgePages(shared)
    expect(promoted).toEqual(inspected.filter((page) => page.id !== 'unselected'))
    for (const entry of record.entries) {
      expect(entry.pageDigest).toBe(
        knowledgePageDigest(promoted.find((page) => page.id === entry.pageId)!),
      )
    }
    expect(
      await readFile(join(stores.storePath('run-a'), 'knowledge', 'claim.md'), 'utf8'),
    ).toContain('Changed after source capture.')
    expect(
      await readFile(join(stores.storePath('run-a'), 'knowledge', 'unselected.md'), 'utf8'),
    ).toBe(unselected)
  })

  it('refuses a promotion whose citation would resolve to nothing in the shared store', async () => {
    await stores.init('run-a')
    await addPage('run-a', 'claim', 'cites:\n  - absent\n', 'Built on a page that does not exist.')

    await expect(
      promoteRunScopedPages(stores, 'run-a', {
        pageIds: ['claim'],
        sharedRoot: shared,
        actor: 'drew',
        reason: 'testing the gate',
      }),
    ).rejects.toThrow(KnowledgeCitationResolutionError)
    expect(await loadKnowledgePages(shared)).toEqual([])
  })

  it('refuses to promote a page the run did not author', async () => {
    await stores.init('run-a')

    await expect(
      promoteRunScopedPages(stores, 'run-a', {
        pageIds: ['never-written'],
        sharedRoot: shared,
        actor: 'drew',
        reason: 'testing the gate',
      }),
    ).rejects.toThrow(KnowledgePromotionError)
  })

  it('writes a record that reloads unchanged and re-promotes to the same bytes', async () => {
    await stores.init('run-a')
    await addPage('run-a', 'finding', '', 'A finding worth sharing.')
    const options = {
      pageIds: ['finding'],
      sharedRoot: shared,
      actor: 'drew',
      reason: 'The finding held across three runs.',
      now: () => new Date('2026-08-21T00:00:00.000Z'),
    }

    const record = await promoteRunScopedPages(stores, 'run-a', options)
    expect(await loadKnowledgePromotionRecord(shared, record.recordDigest)).toEqual(record)
    expect(await promoteRunScopedPages(stores, 'run-a', options)).toEqual(record)
  })
})
