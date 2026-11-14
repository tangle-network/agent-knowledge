import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createKnowledgeTools, createRunScopedStores, type KnowledgePage } from '../src/index'
import { searchKnowledgePages } from '../src/search/index'

const page = (id: string, text: string): KnowledgePage => ({
  id,
  path: `${id}.md`,
  title: id,
  text,
  frontmatter: {},
  sourceIds: [],
  tags: [],
  outLinks: [],
})

const hits = (pages: KnowledgePage[], query: string) =>
  searchKnowledgePages(pages, query).map((hit) => hit.page.id)

describe('sentence punctuation in search', () => {
  it('matches a question and a sentence whose last word carries punctuation', () => {
    const pages = [page('policy', 'Checkout is at noon.'), page('delivery', 'Delivery takes days.')]

    expect(hits(pages, 'When is checkout?')).toEqual(['policy'])
    expect(hits(pages, 'checkout!')).toEqual(['policy'])
    expect(hits(pages, 'Checkout; noon: when')).toEqual(['policy'])
    expect(hits(pages, 'noon')).toEqual(['policy'])
    expect(hits(pages, 'days?')).toEqual(['delivery'])
  })

  it('keeps a dot or colon that a letter or digit follows inside one term', () => {
    const pages = [
      page('release', 'Upgrade to v1.2 before deploying.'),
      page('module', 'The entry is file.ts, served from example.com at 12:30.'),
      page('plain', 'A file was sent to the example team at 12 sharp.'),
      page('secrets', 'Secrets live in .env files!'),
    ]

    expect(hits(pages, 'v1.2')).toEqual(['release'])
    expect(hits(pages, 'Is it v1.2.')).toEqual(['release'])
    expect(hits(pages, 'Which file.ts?')).toEqual(['module'])
    expect(hits(pages, 'example.com')).toEqual(['module'])
    expect(hits(pages, '12:30')).toEqual(['module'])
    expect(hits(pages, 'example')).toEqual(['plain'])
    expect(hits(pages, '.env')).toEqual(['secrets'])
    expect(hits(pages, 'env')).toEqual([])
  })
})

describe('knowledge_search with sentence punctuation', () => {
  let root: string | undefined
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('returns the page a natural-language question names', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'knowledge-punctuation-')))
    const stores = createRunScopedStores({ root })
    await stores.init('run-a')
    await writeFile(
      join(stores.storePath('run-a'), 'knowledge', 'policy.md'),
      '---\nid: policy\ntitle: Policy\n---\n\nCheckout is at noon.\n',
    )
    const search = createKnowledgeTools({
      stores,
      runId: 'run-a',
      retrieverVersion: 'test',
    }).find((tool) => tool.name === 'knowledge_search')!

    const result = (await search.handler({ question: 'When is checkout?' }, {})) as {
      receipt: { results: { snippet?: string }[] }
    }

    expect(result.receipt.results).toHaveLength(1)
    expect(result.receipt.results[0]!.snippet).toContain('noon')
  })
})
