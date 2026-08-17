import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRunScopedStores, type RunLineageAuthority } from './run-scoped'

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

  it('reopening a run is idempotent and refuses a different parent', async () => {
    const stores = createRunScopedStores({ root })
    await stores.init('child', { parentRunId: 'parent-a' })
    await expect(stores.init('child', { parentRunId: 'parent-a' })).resolves.toBeDefined()
    await expect(stores.init('child', { parentRunId: 'parent-b' })).rejects.toThrow(
      /lineage conflict/,
    )
  })

  it('reads ancestry from an external product-owned authority', async () => {
    const parents = new Map<string, string | null>([
      ['parent', null],
      ['child', 'parent'],
    ])
    const authority: RunLineageAuthority = {
      async parentOf(runId) {
        return parents.get(runId) ?? null
      },
    }
    const stores = createRunScopedStores({ root, lineageAuthority: authority })
    await stores.init('parent')
    await addPage(join(root, 'parent', 'knowledge-base'), 'parent-page.md', 'owned by parent')
    await stores.init('child', { parentRunId: 'parent' })
    await addPage(join(root, 'child', 'knowledge-base'), 'child-page.md', 'owned by child')

    await expect(stores.lineage('child')).resolves.toEqual(['parent'])
    const chain = await stores.loadChain('child')
    expect(chain.map((entry) => [entry.page.title, entry.origin])).toEqual([
      ['child-page.md', 'here'],
      ['parent-page.md', 'inherited:parent'],
    ])
  })

  it('fails closed when a read-only external authority disagrees at initialization', async () => {
    const authority: RunLineageAuthority = {
      async parentOf() {
        return 'registered-parent'
      },
    }
    const stores = createRunScopedStores({ root, lineageAuthority: authority })

    await expect(stores.init('child', { parentRunId: 'different-parent' })).rejects.toThrow(
      /external lineage authority disagrees/,
    )
  })

  it('refuses a lineage cycle loudly', async () => {
    const stores = createRunScopedStores({ root })
    await stores.init('a', { parentRunId: 'b' })
    await stores.init('b', { parentRunId: 'a' })
    await expect(stores.lineage('a')).rejects.toThrow(/cycle/)
  })

  it('refuses an ancestry chain beyond the declared safety bound', async () => {
    const parents = new Map<string, string | null>()
    for (let index = 0; index < 66; index++) {
      parents.set(`run-${index}`, index === 65 ? null : `run-${index + 1}`)
    }
    const stores = createRunScopedStores({
      root,
      lineageAuthority: {
        async parentOf(runId) {
          return parents.get(runId) ?? null
        },
      },
    })

    await expect(stores.lineage('run-0')).rejects.toThrow(/exceeds 64 ancestors/)
  })
})
