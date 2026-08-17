import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  initKnowledgeBase,
  loadKnowledgePages,
  withKnowledgeMutation,
  withKnowledgeRead,
} from './index'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'knowledge-store-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('loadKnowledgePages', () => {
  it('keeps the published knowledge-directory default', async () => {
    await initKnowledgeBase(root)
    await writeFile(
      join(root, 'knowledge', 'default-page.md'),
      '---\ntitle: Default page\n---\n# Default page\n\nDefault body.\n',
    )

    const pages = await loadKnowledgePages(root)

    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({
      id: 'default-page',
      path: 'knowledge/default-page.md',
      title: 'Default page',
      text: '# Default page\n\nDefault body.\n',
    })
  })

  it('loads a caller-selected nested page directory and derives ids relative to it', async () => {
    await initKnowledgeBase(root)
    await mkdir(join(root, 'kb', 'pages', 'line-a'), { recursive: true })
    await writeFile(join(root, 'kb', 'pages', 'index.md'), '# Custom index\n')
    await writeFile(
      join(root, 'kb', 'pages', 'line-a', 'measured-result.md'),
      '---\ntitle: Measured result\ntags:\n  - experiment\n---\nMeasured body with [[prior-result]].\n',
    )

    const pages = await loadKnowledgePages(root, { pagesDirectory: './kb/pages/' })

    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({
      id: 'line-a-measured-result',
      path: 'kb/pages/line-a/measured-result.md',
      title: 'Measured result',
      tags: ['experiment'],
      outLinks: ['prior-result'],
    })
  })

  it('refuses an empty page-directory selector', async () => {
    await initKnowledgeBase(root)
    await expect(loadKnowledgePages(root, { pagesDirectory: './' })).rejects.toThrow(
      /pagesDirectory/,
    )
  })
})

describe('public knowledge lock scopes', () => {
  it('compose a reentrant mutation and a stable read through the package entrypoint', async () => {
    await initKnowledgeBase(root)
    const calls: string[] = []

    await withKnowledgeMutation(root, async (outer) => {
      outer.assertOwned()
      calls.push('outer')
      await withKnowledgeMutation(root, async (inner) => {
        expect(inner).toBe(outer)
        inner.assertOwned()
        calls.push('inner')
      })
    })

    await expect(withKnowledgeRead(root, () => [...calls])).resolves.toEqual(['outer', 'inner'])
  })
})
