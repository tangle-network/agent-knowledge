import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildRetrievalEvalDispatch,
  createFileSystemSearchProvider,
  initKnowledgeBase,
  type RetrievalEvalScenario,
  retrievalConfigSurface,
} from '../src/index'

async function withProject(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-knowledge-fs-search-'))
  try {
    await initKnowledgeBase(root)
    await mkdir(join(root, 'knowledge', 'concepts'), { recursive: true })
    await writeFile(
      join(root, 'knowledge', 'concepts', 'flash-attention.md'),
      [
        '---',
        'id: flash-attention',
        'title: Flash Attention',
        'sources:',
        '  - src-flash',
        '---',
        '# Flash Attention',
        'IO aware attention improves memory bandwidth with tiled SRAM reads.',
      ].join('\n'),
    )
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('FileSystemSearchProvider', () => {
  it('searches the on-disk KB and refreshes only when requested', async () => {
    await withProject(async (root) => {
      const provider = createFileSystemSearchProvider({ root, defaultLimit: 1 })

      const initial = await provider.search('memory bandwidth')
      expect(initial).toHaveLength(1)
      expect(initial[0]?.page.id).toBe('flash-attention')
      expect(initial[0]?.normalizedScore).toBe(1)

      await writeFile(
        join(root, 'knowledge', 'concepts', 'refund-policy.md'),
        [
          '---',
          'id: refund-policy',
          'title: Refund Policy',
          '---',
          '# Refund Policy',
          'Refund policy answers customer billing refund requests.',
        ].join('\n'),
      )

      expect(await provider.search('refund policy')).toHaveLength(0)
      const refreshed = await provider.search('refund policy', { refresh: true })
      expect(refreshed[0]?.page.id).toBe('refund-policy')

      provider.invalidate()
      const afterInvalidate = await provider.search('refund policy')
      expect(afterInvalidate[0]?.page.id).toBe('refund-policy')
    })
  })

  it('indexes a caller-selected pages directory and refuses an unsafe one', async () => {
    await withProject(async (root) => {
      await mkdir(join(root, 'kb', 'pages', 'line-a'), { recursive: true })
      await writeFile(
        join(root, 'kb', 'pages', 'line-a', 'tiled-reads.md'),
        ['---', 'id: tiled-reads', 'title: Tiled reads', '---', 'Tiled SRAM reads.'].join('\n'),
      )

      const provider = createFileSystemSearchProvider({ root, pagesDirectory: './kb/pages/' })
      expect(provider.pagesDirectory).toBe('kb/pages')
      const hits = await provider.search('tiled sram reads')
      expect(hits.map((hit) => hit.page.path)).toEqual(['kb/pages/line-a/tiled-reads.md'])
      expect(await provider.search('memory bandwidth')).toHaveLength(0)

      expect(() => createFileSystemSearchProvider({ root, pagesDirectory: '../kb' })).toThrow(
        /pagesDirectory/,
      )
    })
  })

  it('adapts directly to retrieval eval dispatch', async () => {
    await withProject(async (root) => {
      const provider = createFileSystemSearchProvider({ root })
      const scenario: RetrievalEvalScenario = {
        id: 'q-memory-bandwidth',
        kind: 'retrieval-eval',
        query: 'memory bandwidth',
        expected: { kind: 'page', pageId: 'flash-attention' },
      }
      const dispatch = buildRetrievalEvalDispatch({
        retrieve: provider.asRetrievalEvalRetriever(),
      })

      const artifact = await dispatch(retrievalConfigSurface({ k: 1 }), scenario, {
        cellId: 'cell-1',
        rep: 0,
        seed: 1,
        signal: new AbortController().signal,
      })

      expect(artifact.hits[0]).toMatchObject({
        pageId: 'flash-attention',
        path: 'knowledge/concepts/flash-attention.md',
        rank: 1,
      })
    })
  })
})
