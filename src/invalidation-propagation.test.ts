import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  formatKnowledgeInvalidationProposal,
  planInvalidationPropagation,
} from './invalidation-propagation'
import { applyKnowledgeWriteBlocks } from './proposals'
import { originatedPages } from './run-scoped'
import { initKnowledgeBase, loadKnowledgePages } from './store'
import type { KnowledgePage } from './types'

const overturned = {
  verdict: 'contradicted' as const,
  observedAt: '2026-08-18T00:00:00.000Z',
  reason: 'The replication measured the opposite direction.',
}

function page(id: string, frontmatter: Record<string, unknown>): KnowledgePage {
  const cites = frontmatter.cites as string[] | undefined
  return {
    id,
    path: `knowledge/${id}.md`,
    title: id,
    text: `Body of ${id}.`,
    frontmatter: { id, ...frontmatter },
    sourceIds: [],
    tags: [],
    outLinks: [],
    ...(cites ? { cites } : {}),
    ...(frontmatter.invalidation ? { invalidation: overturned } : {}),
  }
}

describe('planInvalidationPropagation', () => {
  it('stamps a citer of an invalidated page and clears the stamp when the verdict is gone', () => {
    const refuted = page('refuted', { invalidation: overturned })
    const citer = page('citer', { cites: ['refuted'] })

    const plan = planInvalidationPropagation(originatedPages([refuted, citer]))

    expect(plan.invalidatedPageIds).toEqual(['refuted'])
    expect(plan.stamps.map((stamp) => [stamp.page.id, stamp.citesInvalidated])).toEqual([
      ['citer', ['refuted']],
    ])

    const stamped = page('citer', { cites: ['refuted'], citesInvalidated: ['refuted'] })
    const revalidated = page('refuted', {})
    expect(
      planInvalidationPropagation(originatedPages([revalidated, stamped])).stamps.map((stamp) => [
        stamp.page.id,
        stamp.citesInvalidated,
      ]),
    ).toEqual([['citer', []]])
  })

  it('never stamps a page the store only inherits', () => {
    const refuted = page('refuted', { invalidation: overturned })
    const inheritedCiter = page('inherited-citer', { cites: ['refuted'] })

    const plan = planInvalidationPropagation([
      ...originatedPages([refuted]),
      ...originatedPages([inheritedCiter], 'inherited:run-a'),
    ])

    expect(plan.stamps).toEqual([])
  })
})

describe('applying an invalidation plan through the write path', () => {
  let root: string

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'invalidation-')))
    await initKnowledgeBase(root)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('is a no-op on the second pass over a store it already stamped', async () => {
    await writeFile(
      join(root, 'knowledge', 'refuted.md'),
      `---\nid: refuted\ninvalidation: ${JSON.stringify(overturned)}\n---\n\n# Refuted\n\nA claim its own replication overturned.\n`,
    )
    await writeFile(
      join(root, 'knowledge', 'citer.md'),
      '---\nid: citer\ntags:\n  - live\ncites:\n  - refuted\n---\n\n# Citer\n\nBuilt on the refuted claim.\n',
    )

    const runPass = async () => {
      const plan = planInvalidationPropagation(originatedPages(await loadKnowledgePages(root)))
      if (plan.stamps.length === 0) return { stamped: [] as string[] }
      const applied = await applyKnowledgeWriteBlocks(
        root,
        formatKnowledgeInvalidationProposal(plan),
      )
      return { stamped: applied.written }
    }

    expect((await runPass()).stamped).toEqual(['knowledge/citer.md'])
    const afterFirst = await readFile(join(root, 'knowledge', 'citer.md'), 'utf8')
    expect(afterFirst).toContain('citesInvalidated:\n  - refuted')
    expect(afterFirst).toContain('- live')
    expect(afterFirst).toContain('Built on the refuted claim.')

    expect((await runPass()).stamped).toEqual([])
    expect(await readFile(join(root, 'knowledge', 'citer.md'), 'utf8')).toBe(afterFirst)
  })
})
