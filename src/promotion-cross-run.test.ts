import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { hashKnowledgeBase, snapshotKnowledgeBase } from './kb-improvement'
import { promoteRunScopedPages } from './promotion'
import { applyKnowledgeWriteBlocks } from './proposals'
import { createRunScopedStores } from './run-scoped'
import { addSourceText, loadSourceRegistry, writeSourceRegistry } from './sources'
import { initKnowledgeBase, loadKnowledgePages } from './store'

let root: string
let shared: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'knowledge-cross-run-'))
  shared = join(root, 'shared')
  await initKnowledgeBase(shared)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const operationId = `sha256:${'a'.repeat(64)}` as const
const proposal = (id: string, sourceId?: string) =>
  `---FILE: knowledge/${id}.md---\n---\nid: ${id}\ntitle: ${id}\n${sourceId ? `sources: [${sourceId}]\n` : ''}---\n${id} research findings.\n---END FILE---`

it('publishes the exact source closure for a later independent run while preserving earlier pins', async () => {
  const pinned = await snapshotKnowledgeBase({
    root: shared,
    snapshotRoot: join(root, 'snapshot-a'),
  })
  const stores = createRunScopedStores({
    root: join(root, 'runs'),
    sharedRoot: pinned.root,
  })
  await stores.init('a')
  const source = await addSourceText(stores.storePath('a'), {
    uri: 'https://example.org/study',
    title: 'Observed study',
    text: 'Original captured source bytes.\n',
    metadata: {
      provenance: 'Tool-captured response; publisher not authenticated',
    },
  })
  await applyKnowledgeWriteBlocks(stores.storePath('a'), proposal('finding', source.id))
  const options = {
    pageIds: ['finding'],
    sharedRoot: shared,
    actor: 'researcher',
    reason: 'Accepted research supports later work',
    expectedSharedHash: pinned.hash,
    operationId,
  }
  const record = await promoteRunScopedPages(stores, 'a', options)
  expect(
    await promoteRunScopedPages(stores, 'a', {
      ...options,
      now: () => new Date('2099-01-01'),
    }),
  ).toEqual(record)
  expect(record.sources).toEqual([{ sourceId: source.id, contentHash: source.contentHash }])
  await rm(stores.storePath('a'), { recursive: true })

  const next = await snapshotKnowledgeBase({
    root: shared,
    snapshotRoot: join(root, 'snapshot-b'),
  })
  const independent = createRunScopedStores({
    root: join(root, 'independent'),
    sharedRoot: next.root,
  })
  await independent.init('b')
  expect((await independent.loadChain('b')).map(({ page }) => page.id)).toContain('finding')
  expect((await loadSourceRegistry(next.root)).sources).toContainEqual(source)
  expect(await readFile(join(next.root, source.uri), 'utf8')).toBe(
    'Original captured source bytes.\n',
  )
  expect(await loadKnowledgePages(pinned.root)).toEqual([])
  expect(await hashKnowledgeBase(pinned.root)).toBe(pinned.hash)
  expect(next.hash).not.toBe(pinned.hash)
})

it('refuses corrupted captured evidence without publishing partial pages or sources', async () => {
  const before = await hashKnowledgeBase(shared)
  const stores = createRunScopedStores({
    root: join(root, 'runs'),
    sharedRoot: shared,
  })
  await stores.init('a')
  const source = await addSourceText(stores.storePath('a'), {
    uri: 'https://example.org/source',
    text: 'Evidence',
  })
  await applyKnowledgeWriteBlocks(stores.storePath('a'), proposal('finding', source.id))
  await writeFile(join(stores.storePath('a'), source.uri), 'Changed evidence')
  await expect(
    promoteRunScopedPages(stores, 'a', {
      pageIds: ['finding'],
      sharedRoot: shared,
      actor: 'author',
      reason: 'publish',
    }),
  ).rejects.toThrow('registered content hash')
  expect(await hashKnowledgeBase(shared)).toBe(before)
})

it('admits one concurrent publication and refuses its stale competitor', async () => {
  const before = await hashKnowledgeBase(shared)
  const stores = createRunScopedStores({
    root: join(root, 'runs'),
    sharedRoot: shared,
  })
  for (const id of ['a', 'b']) {
    await stores.init(id)
    await applyKnowledgeWriteBlocks(stores.storePath(id), proposal(id))
  }
  const outcomes = await Promise.allSettled(
    ['a', 'b'].map((id) =>
      promoteRunScopedPages(stores, id, {
        pageIds: [id],
        sharedRoot: shared,
        actor: id,
        reason: 'publish',
        expectedSharedHash: before,
      }),
    ),
  )
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
  expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
  expect(
    (outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult).reason
      .code,
  ).toBe('baseline-conflict')
  expect(await loadKnowledgePages(shared)).toHaveLength(1)
})

it('does not reuse a successful operation identity for changed page bytes', async () => {
  const stores = createRunScopedStores({
    root: join(root, 'runs'),
    sharedRoot: shared,
  })
  await stores.init('a')
  await applyKnowledgeWriteBlocks(stores.storePath('a'), proposal('finding'))
  const options = {
    pageIds: ['finding'],
    sharedRoot: shared,
    actor: 'author',
    reason: 'publish',
    operationId,
  }
  await promoteRunScopedPages(stores, 'a', options)
  await applyKnowledgeWriteBlocks(
    stores.storePath('a'),
    proposal('finding').replace('research findings.', 'different research findings.'),
  )
  await expect(promoteRunScopedPages(stores, 'a', options)).rejects.toMatchObject({
    code: 'operation-conflict',
  })
})

it('refuses duplicate target source identities instead of silently dropping registered evidence', async () => {
  const source = await addSourceText(shared, {
    uri: 'https://example.org/source',
    text: 'Captured source',
  })
  const registry = await loadSourceRegistry(shared)
  await writeSourceRegistry(shared, { ...registry, sources: [source, source] })
  const before = await hashKnowledgeBase(shared)
  const stores = createRunScopedStores({ root: join(root, 'runs'), sharedRoot: shared })
  await stores.init('a')
  await applyKnowledgeWriteBlocks(stores.storePath('a'), proposal('finding'))
  await expect(
    promoteRunScopedPages(stores, 'a', {
      pageIds: ['finding'],
      sharedRoot: shared,
      actor: 'author',
      reason: 'publish',
    }),
  ).rejects.toThrow('repeats a source identity')
  expect(await hashKnowledgeBase(shared)).toBe(before)
})

it('refuses snapshot paths within the live corpus before creating them', async () => {
  await expect(
    snapshotKnowledgeBase({ root: shared, snapshotRoot: join(shared, 'run') }),
  ).rejects.toThrow('must be separate')
  await expect(readFile(join(shared, 'run', 'baseline'))).rejects.toMatchObject({ code: 'ENOENT' })
})
