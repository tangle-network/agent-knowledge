import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRunScopedStores } from './run-scoped'

let root: string
let shared: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'run-scoped-'))
  shared = await mkdtemp(join(tmpdir(), 'run-shared-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(shared, { recursive: true, force: true })
})

async function addPage(storeRoot: string, name: string, body: string): Promise<void> {
  await writeFile(join(storeRoot, 'knowledge', name), `---\ntitle: ${name}\n---\n\n${body}\n`)
}

describe('createRunScopedStores', () => {
  it('isolates writes per run and labels chain reads by origin', async () => {
    const stores = createRunScopedStores({ root, sharedRoot: shared })
    const a = await stores.init('run-a')
    await addPage(join(root, 'run-a', 'knowledge-base'), 'a-finding.md', 'learned by a')
    await stores.init('run-b', { parentRunId: 'run-a' })
    await addPage(join(root, 'run-b', 'knowledge-base'), 'b-finding.md', 'learned by b')
    expect(a.root).toContain('run-a')

    const chain = await stores.loadChain('run-b')
    const origins = new Map(chain.map((entry) => [entry.page.title, entry.origin]))
    expect(origins.get('b-finding.md')).toBe('here')
    expect(origins.get('a-finding.md')).toBe('inherited:run-a')
  })

  it('a fresh run inherits nothing from siblings — only declared ancestry reaches it', async () => {
    const stores = createRunScopedStores({ root })
    await stores.init('arm-1')
    await addPage(join(root, 'arm-1', 'knowledge-base'), 'arm1-claim.md', 'arm 1 believes this')
    await stores.init('arm-2')

    const chain = await stores.loadChain('arm-2')
    expect(chain.map((entry) => entry.page.title)).not.toContain('arm1-claim.md')
  })

  it('reads the shared store last, labeled shared, without any run writing it', async () => {
    const stores = createRunScopedStores({ root, sharedRoot: join(shared, 'kb') })
    const sharedStores = createRunScopedStores({
      root: shared,
      runStorePath: () => join(shared, 'kb'),
    })
    await sharedStores.init('shared')
    await addPage(join(shared, 'kb'), 'lab-lesson.md', 'curated instrument knowledge')
    await stores.init('run-x')

    const chain = await stores.loadChain('run-x')
    const lesson = chain.find((entry) => entry.page.title === 'lab-lesson.md')
    expect(lesson?.origin).toBe('shared')
  })

  it('ends the chain at a run with no lineage record instead of erroring', async () => {
    const stores = createRunScopedStores({ root })
    await stores.init('child', { parentRunId: 'never-initialized-parent' })
    await expect(stores.lineage('child')).resolves.toEqual(['never-initialized-parent'])
    await expect(stores.loadChain('child')).resolves.toEqual([])
  })

  it('refuses a lineage cycle loudly', async () => {
    const stores = createRunScopedStores({ root })
    await stores.init('a', { parentRunId: 'b' })
    await stores.init('b', { parentRunId: 'a' })
    await expect(stores.lineage('a')).rejects.toThrow(/cycle/)
  })
})
