import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KnowledgeCitationResolutionError } from './citation-resolution'
import { applyKnowledgeWriteBlocks } from './proposals'
import type { OriginatedPage } from './run-scoped'
import { initKnowledgeBase } from './store'
import type { KnowledgePage } from './types'
import { assertKnowledgeWriteIntake, KnowledgeDuplicateIntakeError } from './write-intake'

const body =
  'Retrieval receipts prove what an actor could see and what its retriever returned, so a later reader can replay the exact ranked view instead of trusting the prose. '

function page(id: string, overrides: Partial<KnowledgePage> = {}): KnowledgePage {
  return {
    id,
    path: `knowledge/${id}.md`,
    title: 'Retrieval receipts prove retrieval',
    text: body.repeat(3),
    frontmatter: { id },
    sourceIds: [],
    tags: [],
    outLinks: [],
    ...overrides,
  }
}

function visible(pages: KnowledgePage[]): OriginatedPage[] {
  return pages.map((entry) => ({ page: entry, origin: 'here' as const }))
}

describe('assertKnowledgeWriteIntake', () => {
  const settled = page('settled')

  it('refuses a candidate that restates a visible page without relating to it', () => {
    const call = () =>
      assertKnowledgeWriteIntake([page('restated')], { visiblePages: visible([settled]) })

    expect(call).toThrow(KnowledgeDuplicateIntakeError)
    try {
      call()
    } catch (error) {
      expect((error as KnowledgeDuplicateIntakeError).pairs).toEqual([
        {
          candidatePageId: 'restated',
          candidatePath: 'knowledge/restated.md',
          matchedPageId: 'settled',
          matchedPath: 'knowledge/settled.md',
          similarity: 1,
          exact: true,
        },
      ])
    }
  })

  it('accepts the same candidate once it cites the page it restates', () => {
    const candidate = page('restated', {
      cites: ['settled'],
      frontmatter: { id: 'restated', cites: ['settled'] },
    })

    expect(
      assertKnowledgeWriteIntake([candidate], { visiblePages: visible([settled]) }).map(
        (resolved) => resolved.pageId,
      ),
    ).toEqual(['settled'])
  })

  it('accepts the same candidate once it names the page in contradicts', () => {
    const candidate = page('restated', { contradicts: ['settled'] })

    expect(assertKnowledgeWriteIntake([candidate], { visiblePages: visible([settled]) })).toEqual(
      [],
    )
  })

  it('accepts a same-id update of the page it restates', () => {
    const candidate = page('settled', { path: 'knowledge/settled-v2.md' })

    expect(assertKnowledgeWriteIntake([candidate], { visiblePages: visible([settled]) })).toEqual(
      [],
    )
  })

  it('accepts a rewrite of the page at the same path, which replaces it', () => {
    const candidate = page('renamed', { path: 'knowledge/settled.md' })

    expect(assertKnowledgeWriteIntake([candidate], { visiblePages: visible([settled]) })).toEqual(
      [],
    )
  })

  it('resolves a citation into the same batch and refuses one that exists nowhere', () => {
    const support = page('support', {
      text: 'Independent support with its own prose and evidence.',
    })
    const claim = page('claim', {
      text: 'A distinct claim that builds on the support written beside it.',
      cites: ['support'],
    })

    expect(
      assertKnowledgeWriteIntake([support, claim], { visiblePages: [] }).map(
        (resolved) => resolved.pageId,
      ),
    ).toEqual(['support'])
    expect(() =>
      assertKnowledgeWriteIntake([page('claim', { text: 'orphan claim', cites: ['absent'] })], {
        visiblePages: [],
      }),
    ).toThrow(KnowledgeCitationResolutionError)
  })
})

describe('applyKnowledgeWriteBlocks with intake', () => {
  let root: string

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'write-intake-')))
    await initKnowledgeBase(root)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const proposal = (path: string, frontmatter: string, text: string) =>
    `---FILE: ${path}---\n---\n${frontmatter}\n---\n\n${text}\n---END FILE---\n`

  it('refuses the whole proposal when a block cites a page that exists nowhere', async () => {
    await expect(
      applyKnowledgeWriteBlocks(
        root,
        proposal('knowledge/claim.md', 'id: claim\ncites:\n  - absent', 'A claim with no target.'),
        { intake: {} },
      ),
    ).rejects.toThrow(KnowledgeCitationResolutionError)

    expect(await readdir(join(root, 'knowledge'))).toEqual(['index.md', 'log.md'])
  })

  it('refuses a block that restates a stored page and accepts it once it cites that page', async () => {
    await writeFile(
      join(root, 'knowledge', 'settled.md'),
      `---\nid: settled\n---\n\n${body.repeat(3)}\n`,
    )

    await expect(
      applyKnowledgeWriteBlocks(
        root,
        proposal('knowledge/restated.md', 'id: restated', body.repeat(3)),
        { intake: {} },
      ),
    ).rejects.toThrow(KnowledgeDuplicateIntakeError)

    const accepted = await applyKnowledgeWriteBlocks(
      root,
      proposal('knowledge/restated.md', 'id: restated\ncites:\n  - settled', body.repeat(3)),
      { intake: {} },
    )
    expect(accepted.written).toEqual(['knowledge/restated.md'])
  })
})
