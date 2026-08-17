import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildKnowledgeGraph } from './graph'
import { KnowledgeIndexSchema } from './schemas'
import { initKnowledgeBase, loadKnowledgePages } from './store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('knowledge page citations', () => {
  it('parses stable ids and projects citation edges into the validated index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'knowledge-citations-'))
    roots.push(root)
    await initKnowledgeBase(root)
    await writeFile(
      join(root, 'knowledge', 'prior.md'),
      ['---', 'id: prior-result', 'title: Prior result', '---', 'The measured prior.', ''].join(
        '\n',
      ),
    )
    await writeFile(
      join(root, 'knowledge', 'new.md'),
      [
        '---',
        'id: new-result',
        'title: New result',
        'cites:',
        '  - prior-result',
        '  - prior-result',
        '---',
        'This result builds on the prior.',
        '',
      ].join('\n'),
    )

    const pages = await loadKnowledgePages(root)
    const current = pages.find((page) => page.id === 'new-result')
    expect(current?.cites).toEqual(['prior-result'])

    const graph = buildKnowledgeGraph(pages)
    expect(graph.edges).toContainEqual({
      source: 'new-result',
      target: 'prior-result',
      weight: 1,
      reasons: ['citation'],
    })
    expect(graph.nodes.find((node) => node.id === 'new-result')?.outDegree).toBe(1)
    expect(graph.nodes.find((node) => node.id === 'prior-result')?.inDegree).toBe(1)

    expect(() =>
      KnowledgeIndexSchema.parse({
        root,
        generatedAt: '2026-08-17T00:00:00.000Z',
        sources: [],
        pages,
        graph,
      }),
    ).not.toThrow()
  })

  it('keeps the graph edge when a citation is origin-qualified', async () => {
    const root = await mkdtemp(join(tmpdir(), 'knowledge-citations-'))
    roots.push(root)
    await initKnowledgeBase(root)
    await writeFile(
      join(root, 'knowledge', 'prior.md'),
      ['---', 'id: prior-result', 'title: Prior result', '---', 'The measured prior.', ''].join(
        '\n',
      ),
    )
    await writeFile(
      join(root, 'knowledge', 'new.md'),
      [
        '---',
        'id: new-result',
        'title: New result',
        'cites:',
        '  - here::prior-result',
        '---',
        'Qualified per the ambiguity remedy.',
        '',
      ].join('\n'),
    )

    const graph = buildKnowledgeGraph(await loadKnowledgePages(root))
    expect(graph.edges).toContainEqual({
      source: 'new-result',
      target: 'prior-result',
      weight: 1,
      reasons: ['citation'],
    })
  })

  it('drops a malformed citation without failing the graph build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'knowledge-citations-'))
    roots.push(root)
    await initKnowledgeBase(root)
    await writeFile(
      join(root, 'knowledge', 'broken.md'),
      [
        '---',
        'id: broken-citer',
        'title: Broken citer',
        'cites:',
        '  - "here::"',
        '---',
        'Origin with an empty page id.',
        '',
      ].join('\n'),
    )

    const graph = buildKnowledgeGraph(await loadKnowledgePages(root))
    expect(graph.edges.filter((edge) => edge.source === 'broken-citer')).toEqual([])
  })

  it('does not project an ambiguous duplicate id into a false graph edge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'knowledge-citations-'))
    roots.push(root)
    await initKnowledgeBase(root)
    await writeFile(
      join(root, 'knowledge', 'first.md'),
      ['---', 'id: reused', 'title: First', '---', 'First page.', ''].join('\n'),
    )
    await writeFile(
      join(root, 'knowledge', 'second.md'),
      ['---', 'id: reused', 'title: Second', '---', 'Second page.', ''].join('\n'),
    )
    await writeFile(
      join(root, 'knowledge', 'consumer.md'),
      [
        '---',
        'id: consumer',
        'title: Consumer',
        'cites:',
        '  - reused',
        '---',
        'Ambiguous citation.',
        '',
      ].join('\n'),
    )

    const graph = buildKnowledgeGraph(await loadKnowledgePages(root))
    expect(graph.edges.some((edge) => edge.source === 'consumer' && edge.target === 'reused')).toBe(
      false,
    )
  })
})
