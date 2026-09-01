import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import lockfile from 'proper-lockfile'
import { describe, expect, it } from 'vitest'
import {
  applyKnowledgeFileTransaction,
  prepareKnowledgeFileTransaction,
  rollbackKnowledgeFileTransaction,
} from '../src/file-transaction'
import { inspectPendingKnowledgeMutation, recoverPendingKnowledgeMutation } from '../src/index'
import { buildKnowledgeIndex } from '../src/indexer'
import {
  isKnowledgeMutationHeld,
  type KnowledgeMutationHold,
  runInKnowledgeMutationScope,
  withKnowledgeMutation,
  withKnowledgeRead,
} from '../src/mutation-lock'
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

  it('repairs an abandoned odd mutation epoch when no transaction remains', async () => {
    await withRoot(async (root) => {
      await mkdir(join(root, '.agent-knowledge'), { recursive: true })
      await writeFile(
        join(root, '.agent-knowledge', 'mutation-epoch.json'),
        '{\n  "epoch": 1,\n  "updatedAt": "2026-07-13T00:00:00.000Z"\n}\n',
      )

      await expect(buildKnowledgeIndex(root)).resolves.toMatchObject({ pages: [] })
      await expect(
        readFile(join(root, '.agent-knowledge', 'mutation-epoch.json'), 'utf8'),
      ).resolves.toContain('"epoch": 2')
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

      await expect(buildKnowledgeIndex(root)).rejects.toThrow(/requires its owner to resume/)
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

describe('an externally held store lock can be joined instead of blocked against', () => {
  async function takeTheLockOutside(root: string): Promise<{
    hold: KnowledgeMutationHold
    release: () => Promise<void>
  }> {
    // What a consumer with its own lock wrapper does: the same lockfile this package uses, taken
    // by a path this package did not hand out.
    await mkdir(join(root, '.agent-knowledge'), { recursive: true })
    let compromised: Error | undefined
    const release = await lockfile.lock(root, {
      lockfilePath: join(root, '.agent-knowledge', 'mutation.lock.durable'),
      realpath: false,
      stale: 30_000,
      update: 10_000,
      onCompromised(error) {
        compromised = error
      },
    })
    return {
      hold: {
        assertOwned() {
          if (compromised) throw compromised
        },
      },
      release,
    }
  }

  it('blocks a nested mutation without the scope, and runs it inline inside it', async () => {
    await withRoot(async (root) => {
      const { hold, release } = await takeTheLockOutside(root)
      try {
        // The self-block: the caller holds the lock, so this package cannot take it and the
        // consumer's only option was to forbid itself from calling this package while holding it.
        await expect(
          withKnowledgeMutation(root, () => 'never reached', { retries: 0 }),
        ).rejects.toThrow()

        const order: string[] = []
        const result = await runInKnowledgeMutationScope(root, hold, async () => {
          order.push('outer')
          const inner = await withKnowledgeMutation(root, () => {
            order.push('inner')
            return 'inner ran'
          })
          order.push('after')
          return inner
        })

        expect(result).toBe('inner ran')
        expect(order).toEqual(['outer', 'inner', 'after'])
      } finally {
        await release()
      }
    })
  })

  it('leaves the epoch closed, so a reader is not left waiting on it', async () => {
    await withRoot(async (root) => {
      const { hold, release } = await takeTheLockOutside(root)
      try {
        await runInKnowledgeMutationScope(root, hold, async () => {
          await withKnowledgeMutation(root, () => undefined)
        })
      } finally {
        await release()
      }
      await expect(withKnowledgeRead(root, () => 'read', { retries: 2 })).resolves.toBe('read')
    })
  })

  it('asks the hold whether the lock is still owned, and stops the write when it is not', async () => {
    await withRoot(async (root) => {
      const { release } = await takeTheLockOutside(root)
      try {
        let entered = false
        const lost: KnowledgeMutationHold = {
          assertOwned() {
            if (entered) throw new Error('the external lock was lost')
          },
        }
        // A lost hold reaches the caller the same way a lock this package acquired and lost does:
        // the mutation fails, and the aggregate carries the loss the hold reported.
        const failure = await runInKnowledgeMutationScope(root, lost, () => {
          entered = true
          return 'wrote under a lock somebody else holds'
        }).catch((error: unknown) => error)
        expect(failure).toBeInstanceOf(AggregateError)
        expect((failure as AggregateError).errors.map(String)).toContain(
          'Error: the external lock was lost',
        )
      } finally {
        await release()
      }
    })
  })

  it('reports whether this async context holds the root', async () => {
    await withRoot(async (root) => {
      expect(isKnowledgeMutationHeld(root)).toBe(false)

      await withKnowledgeMutation(root, async () => {
        expect(isKnowledgeMutationHeld(root)).toBe(true)
        expect(isKnowledgeMutationHeld(join(root, 'other'))).toBe(false)
      })
      expect(isKnowledgeMutationHeld(root)).toBe(false)

      const { hold, release } = await takeTheLockOutside(root)
      try {
        await runInKnowledgeMutationScope(root, hold, async () => {
          expect(isKnowledgeMutationHeld(root)).toBe(true)
        })
      } finally {
        await release()
      }
      expect(isKnowledgeMutationHeld(root)).toBe(false)
    })
  })
})
