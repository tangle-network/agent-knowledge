import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import {
  applyKnowledgeFileTransaction,
  prepareKnowledgeFileTransaction,
  rollbackKnowledgeFileTransaction,
} from '../src/file-transaction'
import { inspectPendingKnowledgeMutation, recoverPendingKnowledgeMutation } from '../src/index'
import { buildKnowledgeIndex } from '../src/indexer'
import { withKnowledgeMutation } from '../src/mutation-lock'
import { loadSourceRegistry } from '../src/sources'
import { initKnowledgeBase } from '../src/store'

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-knowledge-read-'))
  try {
    await fn(root)
  } finally {
    await chmodTree(root, 0o700).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
}

describe('knowledge read epochs', () => {
  it('does not change an empty root during pure reads', async () => {
    await withRoot(async (root) => {
      expect(await readdir(root)).toEqual([])

      await expect(loadSourceRegistry(root)).resolves.toMatchObject({ sources: [] })
      await expect(buildKnowledgeIndex(root)).resolves.toMatchObject({ pages: [], sources: [] })

      expect(await readdir(root)).toEqual([])
    })
  })

  it.skipIf(process.platform === 'win32')(
    'reads an existing read-only knowledge base',
    async () => {
      await withRoot(async (root) => {
        await mkdir(join(root, 'knowledge'), { recursive: true })
        await mkdir(join(root, '.agent-knowledge'), { recursive: true })
        await writeFile(join(root, 'knowledge', 'page.md'), '# Readable\n')
        await writeFile(
          join(root, '.agent-knowledge', 'sources.json'),
          '{\n  "generatedAt": "1970-01-01T00:00:00.000Z",\n  "sources": []\n}\n',
        )
        await chmodTree(root, 0o555, 0o444)

        const index = await buildKnowledgeIndex(root)

        expect(index.pages.map((page) => page.title)).toEqual(['Readable'])
        await expect(readdir(join(root, '.agent-knowledge'))).resolves.toEqual(['sources.json'])
      })
    },
  )

  it('does not return a mixed view during an active multi-file mutation', async () => {
    await withRoot(async (root) => {
      await mkdir(join(root, 'knowledge'), { recursive: true })
      await writeFile(join(root, 'knowledge', 'one.md'), '# One before\n')
      await writeFile(join(root, 'knowledge', 'two.md'), '# Two before\n')

      let startReader!: () => void
      const readerStart = new Promise<void>((resolve) => {
        startReader = resolve
      })
      let readerSettled = false
      const reader = readerStart
        .then(() => buildKnowledgeIndex(root))
        .finally(() => {
          readerSettled = true
        })

      await withKnowledgeMutation(root, async () => {
        await writeFile(join(root, 'knowledge', 'one.md'), '# One after\n')
        startReader()
        await delay(50)
        expect(readerSettled).toBe(false)
        await writeFile(join(root, 'knowledge', 'two.md'), '# Two after\n')
      })

      await expect(reader).resolves.toMatchObject({
        pages: [{ title: 'One after' }, { title: 'Two after' }],
      })
    })
  })

  it('fails loudly on an abandoned odd mutation epoch', async () => {
    await withRoot(async (root) => {
      await mkdir(join(root, '.agent-knowledge'), { recursive: true })
      await writeFile(
        join(root, '.agent-knowledge', 'mutation-epoch.json'),
        '{\n  "epoch": 1,\n  "updatedAt": "2026-07-13T00:00:00.000Z"\n}\n',
      )

      await expect(buildKnowledgeIndex(root)).rejects.toThrow(/odd with no active writer/)
    })
  })

  it('leaves interrupted transactions unreadable until recovered', async () => {
    await withRoot(async (root) => {
      await mkdir(join(root, 'knowledge'), { recursive: true })
      await writeFile(join(root, 'knowledge', 'one.md'), '# One before\n')
      await writeFile(join(root, 'knowledge', 'two.md'), '# Two before\n')

      await expect(
        withKnowledgeMutation(root, async (lock) => {
          const transaction = await prepareKnowledgeFileTransaction({
            root,
            transactionRoot: lock.transactionRoot,
            purpose: 'interrupted-read',
            mutations: [
              { path: 'knowledge/one.md', content: '# One after\n' },
              { path: 'knowledge/two.md', content: '# Two after\n' },
            ],
          })
          await applyKnowledgeFileTransaction({
            root,
            transactionRoot: lock.transactionRoot,
            transaction: transaction!,
            beforeCommit(entry) {
              if (entry.path === 'knowledge/two.md') throw new Error('simulated interruption')
            },
          })
        }),
      ).rejects.toThrow(/simulated interruption/)

      await expect(buildKnowledgeIndex(root)).rejects.toThrow(/odd with no active writer/)
    })
  })

  it.each([
    {
      action: 'apply' as const,
      expectedOne: '# One after\n',
      expectedTwo: '# Two after\n',
    },
    {
      action: 'rollback' as const,
      expectedOne: '# One before\n',
      expectedTwo: '# Two before\n',
    },
  ])('supports public $action recovery for an interrupted mutation', async (scenario) => {
    await withRoot(async (root) => {
      await mkdir(join(root, 'knowledge'), { recursive: true })
      await writeFile(join(root, 'knowledge', 'one.md'), '# One before\n')
      await writeFile(join(root, 'knowledge', 'two.md'), '# Two before\n')

      await expect(
        withKnowledgeMutation(root, async (lock) => {
          const transaction = await prepareKnowledgeFileTransaction({
            root,
            transactionRoot: lock.transactionRoot,
            purpose: 'public-recovery',
            mutations: [
              { path: 'knowledge/one.md', content: '# One after\n' },
              { path: 'knowledge/two.md', content: '# Two after\n' },
            ],
          })
          await applyKnowledgeFileTransaction({
            root,
            transactionRoot: lock.transactionRoot,
            transaction: transaction!,
            beforeCommit(entry) {
              if (entry.path === 'knowledge/two.md') throw new Error('simulated interruption')
            },
          })
        }),
      ).rejects.toThrow(/simulated interruption/)

      const pending = await inspectPendingKnowledgeMutation(root)
      expect(pending).toMatchObject({
        purpose: 'public-recovery',
        direction: 'apply',
        paths: ['knowledge/one.md', 'knowledge/two.md'],
      })
      await expect(
        recoverPendingKnowledgeMutation(root, {
          transactionId: '00000000-0000-4000-8000-000000000000',
          action: scenario.action,
        }),
      ).rejects.toThrow(/does not match/)
      await expect(inspectPendingKnowledgeMutation(root)).resolves.toEqual(pending)

      await recoverPendingKnowledgeMutation(root, {
        transactionId: pending!.transactionId,
        action: scenario.action,
      })

      await expect(readFile(join(root, 'knowledge', 'one.md'), 'utf8')).resolves.toBe(
        scenario.expectedOne,
      )
      await expect(readFile(join(root, 'knowledge', 'two.md'), 'utf8')).resolves.toBe(
        scenario.expectedTwo,
      )
      await expect(inspectPendingKnowledgeMutation(root)).resolves.toBeNull()
      await expect(buildKnowledgeIndex(root)).resolves.toMatchObject({
        pages: [
          { title: scenario.expectedOne.trim().slice(2) },
          { title: scenario.expectedTwo.trim().slice(2) },
        ],
      })
    })
  })

  it('rejects apply after rollback has durably started', async () => {
    await withRoot(async (root) => {
      await mkdir(join(root, 'knowledge'), { recursive: true })
      await writeFile(join(root, 'knowledge', 'page.md'), '# Before\n')
      const transactionRoot = join(root, '.agent-knowledge', 'file-transactions')
      const transaction = await prepareKnowledgeFileTransaction({
        root,
        transactionRoot,
        purpose: 'interrupted-rollback',
        mutations: [{ path: 'knowledge/page.md', content: '# After\n' }],
      })
      await applyKnowledgeFileTransaction({ root, transactionRoot, transaction: transaction! })

      let rollbackCheck = 0
      await expect(
        rollbackKnowledgeFileTransaction({
          root,
          transactionRoot,
          transaction: transaction!,
          beforeCommit() {
            rollbackCheck += 1
            if (rollbackCheck === 2) throw new Error('simulated rollback interruption')
          },
        }),
      ).rejects.toThrow(/simulated rollback interruption/)
      await expect(inspectPendingKnowledgeMutation(root)).resolves.toMatchObject({
        transactionId: transaction!.transactionId,
        direction: 'rollback',
      })

      await expect(
        recoverPendingKnowledgeMutation(root, {
          transactionId: transaction!.transactionId,
          action: 'apply',
        }),
      ).rejects.toThrow(/already rolling back/)
      await expect(readFile(join(root, 'knowledge', 'page.md'), 'utf8')).resolves.toBe('# After\n')

      await recoverPendingKnowledgeMutation(root, {
        transactionId: transaction!.transactionId,
        action: 'rollback',
      })
      await expect(readFile(join(root, 'knowledge', 'page.md'), 'utf8')).resolves.toBe('# Before\n')
      await expect(inspectPendingKnowledgeMutation(root)).resolves.toBeNull()
    })
  })

  it('does not block source import recovery while re-initializing an existing KB', async () => {
    await withRoot(async (root) => {
      await initKnowledgeBase(root)
      await prepareKnowledgeFileTransaction({
        root,
        transactionRoot: join(root, '.agent-knowledge', 'file-transactions'),
        purpose: 'pending-source-import',
        mutations: [{ path: 'raw/sources/pending.txt', content: 'pending\n' }],
      })

      await expect(initKnowledgeBase(root)).resolves.toMatchObject({ root })
    })
  })

  it('allows nested pure reads inside a writer', async () => {
    await withRoot(async (root) => {
      await mkdir(join(root, 'knowledge'), { recursive: true })
      await writeFile(join(root, 'knowledge', 'page.md'), '# Nested\n')

      await expect(
        withKnowledgeMutation(root, () => buildKnowledgeIndex(root)),
      ).resolves.toMatchObject({
        pages: [{ title: 'Nested' }],
      })
    })
  })
})

async function chmodTree(
  root: string,
  directoryMode: number,
  fileMode = directoryMode,
): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) await chmodTree(path, directoryMode, fileMode)
    await chmod(path, entry.isDirectory() ? directoryMode : fileMode)
  }
  await chmod(root, directoryMode)
}
