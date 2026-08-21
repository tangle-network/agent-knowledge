import { createHash } from 'node:crypto'
import { renameSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import {
  applyKnowledgeFileTransaction,
  assertKnowledgeMutationPath,
  finishKnowledgeFileTransaction,
  knowledgeFileTransactionPlanHash,
  loadKnowledgeFileTransaction,
  prepareKnowledgeFileTransaction,
  recoverKnowledgeFileTransaction,
  rollbackKnowledgeFileTransaction,
} from '../src/file-transaction'
import { buildKnowledgeIndex } from '../src/indexer'
import { KnowledgeLockLostError, withKnowledgeMutation } from '../src/mutation-lock'
import { DEFAULT_PAGES_DIRECTORY } from '../src/pages-directory'
import { addSourceText, loadSourceRegistry } from '../src/sources'

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-knowledge-transaction-'))
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('knowledge file transactions', () => {
  it('resumes an interrupted multi-file commit without mixing versions', async () => {
    await withRoot(async (root) => {
      const transactionRoot = join(root, '.transactions')
      await mkdir(join(root, 'knowledge'), { recursive: true })
      await writeFile(join(root, 'knowledge', 'one.md'), 'one-before\n')
      await writeFile(join(root, 'knowledge', 'two.md'), 'two-before\n')
      const prepared = await prepareKnowledgeFileTransaction({
        root,
        transactionRoot,
        purpose: 'interrupted-commit',
        mutations: [
          { path: 'knowledge/one.md', content: 'one-after\n' },
          { path: 'knowledge/two.md', content: null },
          { path: 'knowledge/three.md', content: 'three-after\n' },
        ],
      })
      expect(prepared).not.toBeNull()
      expect(prepared).not.toHaveProperty('schemaVersion')

      await expect(
        applyKnowledgeFileTransaction({
          root,
          transactionRoot,
          transaction: prepared!,
          beforeCommit(entry) {
            if (entry.path === 'knowledge/two.md') throw new Error('simulated interruption')
          },
        }),
      ).rejects.toThrow(/simulated interruption/)
      await expect(readFile(join(root, 'knowledge', 'one.md'), 'utf8')).resolves.toBe('one-after\n')
      await expect(readFile(join(root, 'knowledge', 'two.md'), 'utf8')).resolves.toBe(
        'two-before\n',
      )

      const pending = await loadKnowledgeFileTransaction({ root, transactionRoot })
      expect(pending).not.toBeNull()
      await applyKnowledgeFileTransaction({
        root,
        transactionRoot,
        transaction: pending!,
      })
      await finishKnowledgeFileTransaction({ root, transactionRoot, transaction: pending! })

      await expect(readFile(join(root, 'knowledge', 'one.md'), 'utf8')).resolves.toBe('one-after\n')
      await expect(readFile(join(root, 'knowledge', 'two.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(readFile(join(root, 'knowledge', 'three.md'), 'utf8')).resolves.toBe(
        'three-after\n',
      )
      await expect(loadKnowledgeFileTransaction({ root, transactionRoot })).resolves.toBeNull()
    })
  })

  it('resumes an interrupted rollback instead of reapplying the candidate', async () => {
    await withRoot(async (root) => {
      const transactionRoot = join(root, '.transactions')
      await mkdir(join(root, 'knowledge'), { recursive: true })
      await writeFile(join(root, 'knowledge', 'one.md'), 'one-before\n')
      await writeFile(join(root, 'knowledge', 'two.md'), 'two-before\n')
      const prepared = await prepareKnowledgeFileTransaction({
        root,
        transactionRoot,
        purpose: 'interrupted-rollback',
        mutations: [
          { path: 'knowledge/one.md', content: 'one-after\n' },
          { path: 'knowledge/two.md', content: 'two-after\n' },
        ],
      })
      await applyKnowledgeFileTransaction({ root, transactionRoot, transaction: prepared! })

      await expect(
        rollbackKnowledgeFileTransaction({
          root,
          transactionRoot,
          transaction: prepared!,
          beforeCommit(entry) {
            if (entry.path === 'knowledge/one.md') throw new Error('rollback interrupted')
          },
        }),
      ).rejects.toThrow(/rollback interrupted/)
      await expect(readFile(join(root, 'knowledge', 'one.md'), 'utf8')).resolves.toBe('one-after\n')
      await expect(readFile(join(root, 'knowledge', 'two.md'), 'utf8')).resolves.toBe(
        'two-before\n',
      )
      await expect(
        finishKnowledgeFileTransaction({
          root,
          transactionRoot,
          transaction: prepared!,
        }),
      ).rejects.toThrow(/did not roll back/)
      await expect(loadKnowledgeFileTransaction({ root, transactionRoot })).resolves.toEqual(
        prepared,
      )

      await recoverKnowledgeFileTransaction({
        root,
        transactionRoot,
        expectedPurpose: 'interrupted-rollback',
      })

      await expect(readFile(join(root, 'knowledge', 'one.md'), 'utf8')).resolves.toBe(
        'one-before\n',
      )
      await expect(readFile(join(root, 'knowledge', 'two.md'), 'utf8')).resolves.toBe(
        'two-before\n',
      )
      await expect(loadKnowledgeFileTransaction({ root, transactionRoot })).resolves.toBeNull()
    })
  })

  it('rejects stale apply, rollback, and finish calls without deleting the active transaction', async () => {
    await withRoot(async (root) => {
      const transactionRoot = join(root, '.transactions')
      const first = await prepareKnowledgeFileTransaction({
        root,
        transactionRoot,
        purpose: 'first',
        mutations: [{ path: 'knowledge/page.md', content: 'first\n' }],
      })
      await applyKnowledgeFileTransaction({ root, transactionRoot, transaction: first! })
      await finishKnowledgeFileTransaction({ root, transactionRoot, transaction: first! })
      const second = await prepareKnowledgeFileTransaction({
        root,
        transactionRoot,
        purpose: 'second',
        mutations: [{ path: 'knowledge/page.md', content: 'second\n' }],
      })

      await expect(
        applyKnowledgeFileTransaction({ root, transactionRoot, transaction: first! }),
      ).rejects.toThrow(/does not match/)
      await expect(
        rollbackKnowledgeFileTransaction({ root, transactionRoot, transaction: first! }),
      ).rejects.toThrow(/does not match/)
      await expect(
        finishKnowledgeFileTransaction({ root, transactionRoot, transaction: first! }),
      ).rejects.toThrow(/does not match/)
      await expect(loadKnowledgeFileTransaction({ root, transactionRoot })).resolves.toEqual(second)

      await expect(
        finishKnowledgeFileTransaction({
          root,
          transactionRoot,
          transaction: second!,
          assertOwned() {
            throw new KnowledgeLockLostError('stale owner')
          },
        }),
      ).rejects.toThrow(/stale owner/)
      await expect(loadKnowledgeFileTransaction({ root, transactionRoot })).resolves.toEqual(second)
    })
  })

  it('does not delete a successor installed after the finishing ownership check', async () => {
    await withRoot(async (root) => {
      const transactionRoot = join(root, '.transactions')
      const stagedRoot = join(root, '.staged-transactions')
      const first = await prepareKnowledgeFileTransaction({
        root,
        transactionRoot,
        purpose: 'first',
        mutations: [{ path: 'knowledge/page.md', content: 'first\n' }],
      })
      await applyKnowledgeFileTransaction({ root, transactionRoot, transaction: first! })
      const second = await prepareKnowledgeFileTransaction({
        root,
        transactionRoot: stagedRoot,
        purpose: 'second',
        mutations: [{ path: 'knowledge/page.md', content: 'second\n' }],
      })

      await expect(
        finishKnowledgeFileTransaction({
          root,
          transactionRoot,
          transaction: first!,
          assertOwned() {
            renameSync(
              join(transactionRoot, `active-${first!.transactionId}`),
              join(transactionRoot, `retired-${first!.transactionId}`),
            )
            renameSync(
              join(stagedRoot, `active-${second!.transactionId}`),
              join(transactionRoot, `active-${second!.transactionId}`),
            )
          },
        }),
      ).rejects.toThrow(/does not match/)

      await expect(loadKnowledgeFileTransaction({ root, transactionRoot })).resolves.toEqual(second)
      await expect(readFile(join(root, 'knowledge', 'page.md'), 'utf8')).resolves.toBe('first\n')
    })
  })

  it('fails loudly on an old active journal instead of starting another transaction', async () => {
    await withRoot(async (root) => {
      const transactionRoot = join(root, '.transactions')
      await mkdir(join(transactionRoot, 'active'), { recursive: true })

      await expect(
        prepareKnowledgeFileTransaction({
          root,
          transactionRoot,
          purpose: 'new',
          mutations: [{ path: 'knowledge/page.md', content: 'new\n' }],
        }),
      ).rejects.toThrow(/unsupported active journal/)
    })
  })

  it('recovers an interrupted aggregate write before the next writer reads it', async () => {
    await withRoot(async (root) => {
      const transactionRoot = join(root, '.agent-knowledge', 'file-transactions')
      await prepareKnowledgeFileTransaction({
        root,
        transactionRoot,
        purpose: 'interrupted-source',
        mutations: [
          { path: 'raw/sources/first.txt', content: 'first source\n' },
          {
            path: '.agent-knowledge/sources.json',
            content: `${JSON.stringify(
              {
                generatedAt: '2026-07-12T00:00:00.000Z',
                sources: [
                  {
                    id: 'src_first',
                    uri: 'raw/sources/first.txt',
                    contentHash: 'a'.repeat(64),
                    createdAt: '2026-07-12T00:00:00.000Z',
                  },
                ],
              },
              null,
              2,
            )}\n`,
          },
        ],
      })

      await expect(
        addSourceText(root, {
          uri: 'test://second',
          text: 'second source',
        }),
      ).rejects.toThrow(/requires its owner to resume/)

      await recoverKnowledgeFileTransaction({
        root,
        transactionRoot,
        expectedPurpose: 'interrupted-source',
      })
      await addSourceText(root, { uri: 'test://second', text: 'second source' })

      const registry = await loadSourceRegistry(root)
      expect(registry.sources.map((source) => source.id)).toContain('src_first')
      expect(registry.sources).toHaveLength(2)
      await expect(readFile(join(root, 'raw', 'sources', 'first.txt'), 'utf8')).resolves.toBe(
        'first source\n',
      )
    })
  })

  it('rejects a forged path in an ordinary recovery journal', async () => {
    await withRoot(async (root) => {
      const packagePath = join(root, 'package.json')
      const original = '{"private":true}\n'
      const forged = '{"scripts":{"postinstall":"malicious"}}\n'
      await writeFile(packagePath, original)
      const transactionRoot = join(root, '.agent-knowledge', 'file-transactions')
      const prepared = await prepareKnowledgeFileTransaction({
        root,
        transactionRoot,
        purpose: 'ordinary-recovery',
        mutations: [{ path: 'knowledge/page.md', content: '# Approved\n' }],
      })
      expect(prepared).not.toBeNull()
      const transactionDir = join(transactionRoot, `active-${prepared!.transactionId}`)
      const transactionPath = join(transactionDir, 'transaction.json')
      const transaction = JSON.parse(await readFile(transactionPath, 'utf8')) as {
        entries: Array<{
          index: number
          path: string
          beforeHash: string | null
          afterHash: string | null
          beforeMode?: number
          afterMode?: number
        }>
      }
      const index = Math.max(...transaction.entries.map((entry) => entry.index)) + 1
      transaction.entries.push({
        index,
        path: 'package.json',
        beforeHash: createHash('sha256').update(original).digest('hex'),
        afterHash: createHash('sha256').update(forged).digest('hex'),
      })
      await mkdir(join(transactionDir, 'after'), { recursive: true })
      await writeFile(join(transactionDir, 'after', `${index}.bin`), forged)
      await writeFile(transactionPath, `${JSON.stringify(transaction, null, 2)}\n`)

      await expect(withKnowledgeMutation(root, async () => undefined)).rejects.toThrow(
        /unsupported path: package.json/,
      )
      await expect(readFile(packagePath, 'utf8')).resolves.toBe(original)
    })
  })

  it('journals the pages directory a transaction was prepared under and replays against it', async () => {
    await withRoot(async (root) => {
      const transactionRoot = join(root, '.agent-knowledge', 'file-transactions')
      await expect(
        prepareKnowledgeFileTransaction({
          root,
          transactionRoot,
          purpose: 'custom-pages',
          mutations: [{ path: 'kb/pages/q36/page.md', content: '# Page\n' }],
        }),
      ).rejects.toThrow(/unsupported path: kb\/pages\/q36\/page.md/)

      const prepared = await prepareKnowledgeFileTransaction({
        root,
        transactionRoot,
        purpose: 'custom-pages',
        pagesDirectory: './kb/pages/q36/',
        mutations: [{ path: 'kb/pages/q36/page.md', content: '# Page\n' }],
      })
      expect(prepared?.pagesDirectory).toBe('kb/pages/q36')
      const journal = JSON.parse(
        await readFile(
          join(transactionRoot, `active-${prepared!.transactionId}`, 'transaction.json'),
          'utf8',
        ),
      ) as { pagesDirectory?: string }
      expect(journal.pagesDirectory).toBe('kb/pages/q36')

      await expect(loadKnowledgeFileTransaction({ root, transactionRoot })).resolves.toMatchObject({
        pagesDirectory: 'kb/pages/q36',
      })
      await expect(
        recoverKnowledgeFileTransaction({
          root,
          transactionRoot,
          expectedPurpose: 'custom-pages',
        }),
      ).resolves.toBe(true)
      await expect(readFile(join(root, 'kb', 'pages', 'q36', 'page.md'), 'utf8')).resolves.toBe(
        '# Page\n',
      )
    })
  })

  it('keeps the default journal free of a pages directory field', async () => {
    await withRoot(async (root) => {
      const transactionRoot = join(root, '.agent-knowledge', 'file-transactions')
      const prepared = await prepareKnowledgeFileTransaction({
        root,
        transactionRoot,
        purpose: 'default-pages',
        mutations: [{ path: 'knowledge/page.md', content: '# Page\n' }],
      })
      expect(prepared).not.toHaveProperty('pagesDirectory')
      const journal = JSON.parse(
        await readFile(
          join(transactionRoot, `active-${prepared!.transactionId}`, 'transaction.json'),
          'utf8',
        ),
      ) as Record<string, unknown>
      expect(Object.keys(journal).sort()).toEqual([
        'createdAt',
        'entries',
        'kind',
        'purpose',
        'transactionId',
      ])
    })
  })

  it('rejects a forged pages directory in a recovery journal', async () => {
    await withRoot(async (root) => {
      const packagePath = join(root, 'package.json')
      const original = '{"private":true}\n'
      await writeFile(packagePath, original)
      const transactionRoot = join(root, '.agent-knowledge', 'file-transactions')
      const forge = async (pagesDirectory: string, entryPath: string) => {
        const prepared = await prepareKnowledgeFileTransaction({
          root,
          transactionRoot,
          purpose: 'forged-pages',
          mutations: [{ path: 'knowledge/page.md', content: '# Approved\n' }],
        })
        const transactionDir = join(transactionRoot, `active-${prepared!.transactionId}`)
        const transactionPath = join(transactionDir, 'transaction.json')
        const transaction = JSON.parse(await readFile(transactionPath, 'utf8')) as {
          pagesDirectory?: string
          entries: Array<{ index: number; path: string }>
        }
        transaction.pagesDirectory = pagesDirectory
        transaction.entries[0]!.path = entryPath
        await writeFile(transactionPath, `${JSON.stringify(transaction, null, 2)}\n`)
        return transactionDir
      }

      const dotDir = await forge('.', 'package.json')
      await expect(withKnowledgeMutation(root, async () => undefined)).rejects.toThrow(
        /root-relative directory/,
      )
      await rm(dotDir, { recursive: true, force: true })

      const escapeDir = await forge('..', 'package.json')
      await expect(withKnowledgeMutation(root, async () => undefined)).rejects.toThrow(
        /dot segments/,
      )
      await rm(escapeDir, { recursive: true, force: true })

      const uncanonicalDir = await forge('./kb/', 'kb/page.md')
      await expect(withKnowledgeMutation(root, async () => undefined)).rejects.toThrow(
        /canonical form/,
      )
      await rm(uncanonicalDir, { recursive: true, force: true })

      const foreignDir = await forge('kb', 'package.json')
      await expect(withKnowledgeMutation(root, async () => undefined)).rejects.toThrow(
        /unsupported path: package.json/,
      )
      await rm(foreignDir, { recursive: true, force: true })

      await expect(readFile(packagePath, 'utf8')).resolves.toBe(original)
    })
  })

  it('holds an external reader until every file in a transaction is committed', async () => {
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

      await withKnowledgeMutation(root, async (lock) => {
        const transactionRoot = lock.transactionRoot
        const prepared = await prepareKnowledgeFileTransaction({
          root,
          transactionRoot,
          purpose: 'reader-consistency',
          mutations: [
            { path: 'knowledge/one.md', content: '# One after\n' },
            { path: 'knowledge/two.md', content: '# Two after\n' },
          ],
        })
        expect(prepared).not.toBeNull()
        await applyKnowledgeFileTransaction({
          root,
          transactionRoot,
          transaction: prepared!,
          async beforeCommit(entry) {
            if (entry.path !== 'knowledge/two.md') return
            startReader()
            await delay(50)
            expect(readerSettled).toBe(false)
          },
        })
        await finishKnowledgeFileTransaction({ root, transactionRoot, transaction: prepared! })
      })

      const index = await reader
      expect(index.pages.map((page) => page.title).sort()).toEqual(['One after', 'Two after'])
    })
  })

  it('rejects a missing or truncated live file instead of overwriting it', async () => {
    await withRoot(async (root) => {
      const transactionRoot = join(root, '.transactions')
      const target = join(root, 'knowledge', 'page.md')
      await mkdir(join(root, 'knowledge'), { recursive: true })
      await writeFile(target, 'measured-before\n')
      const prepared = await prepareKnowledgeFileTransaction({
        root,
        transactionRoot,
        purpose: 'external-change',
        mutations: [{ path: 'knowledge/page.md', content: 'approved-after\n' }],
      })
      expect(prepared).not.toBeNull()

      await writeFile(target, 'truncated')
      await expect(
        applyKnowledgeFileTransaction({
          root,
          transactionRoot,
          transaction: prepared!,
        }),
      ).rejects.toThrow(/changed outside transaction/)
      await unlink(target)
      await expect(
        applyKnowledgeFileTransaction({
          root,
          transactionRoot,
          transaction: prepared!,
        }),
      ).rejects.toThrow(/changed outside transaction/)
    })
  })

  it.skipIf(process.platform === 'win32')('preserves an existing file mode exactly', async () => {
    await withRoot(async (root) => {
      const target = join(root, 'knowledge', 'page.md')
      const transactionRoot = join(root, '.transactions')
      await mkdir(join(root, 'knowledge'), { recursive: true })
      await writeFile(target, 'before\n')
      await chmod(target, 0o764)
      const prepared = await prepareKnowledgeFileTransaction({
        root,
        transactionRoot,
        purpose: 'mode-preservation',
        mutations: [{ path: 'knowledge/page.md', content: 'after\n' }],
      })
      expect(prepared).not.toBeNull()

      await applyKnowledgeFileTransaction({
        root,
        transactionRoot,
        transaction: prepared!,
      })
      expect((await stat(target)).mode & 0o777).toBe(0o764)
    })
  })

  it.skipIf(process.platform === 'win32')(
    'commits a mode-only change when file bytes are unchanged',
    async () => {
      await withRoot(async (root) => {
        const target = join(root, 'knowledge', 'page.md')
        const transactionRoot = join(root, '.transactions')
        await mkdir(join(root, 'knowledge'), { recursive: true })
        await writeFile(target, 'same bytes\n')
        await chmod(target, 0o600)
        const prepared = await prepareKnowledgeFileTransaction({
          root,
          transactionRoot,
          purpose: 'mode-only-change',
          mutations: [{ path: 'knowledge/page.md', content: 'same bytes\n', mode: 0o755 }],
        })

        expect(prepared).not.toBeNull()
        await applyKnowledgeFileTransaction({ root, transactionRoot, transaction: prepared! })
        expect(await readFile(target, 'utf8')).toBe('same bytes\n')
        expect((await stat(target)).mode & 0o777).toBe(0o755)
      })
    },
  )

  it.skipIf(process.platform === 'win32')(
    'restores the original mode when a mode-changing transaction rolls back',
    async () => {
      await withRoot(async (root) => {
        const target = join(root, 'knowledge', 'page.md')
        const transactionRoot = join(root, '.transactions')
        await mkdir(join(root, 'knowledge'), { recursive: true })
        await writeFile(target, 'before\n')
        await chmod(target, 0o600)
        const prepared = await prepareKnowledgeFileTransaction({
          root,
          transactionRoot,
          purpose: 'mode-rollback',
          mutations: [{ path: 'knowledge/page.md', content: 'after\n', mode: 0o777 }],
        })

        await applyKnowledgeFileTransaction({ root, transactionRoot, transaction: prepared! })
        expect((await stat(target)).mode & 0o777).toBe(0o777)
        await rollbackKnowledgeFileTransaction({ root, transactionRoot, transaction: prepared! })
        expect(await readFile(target, 'utf8')).toBe('before\n')
        expect((await stat(target)).mode & 0o777).toBe(0o600)
      })
    },
  )

  it('rejects symbolic links in transaction paths', async () => {
    await withRoot(async (root) => {
      const outside = join(root, 'outside.md')
      await writeFile(outside, 'outside\n')
      await mkdir(join(root, 'knowledge'), { recursive: true })
      await symlink(outside, join(root, 'knowledge', 'linked.md'))

      await expect(
        prepareKnowledgeFileTransaction({
          root,
          transactionRoot: join(root, '.transactions'),
          purpose: 'symlink-attack',
          mutations: [{ path: 'knowledge/linked.md', content: 'overwrite\n' }],
        }),
      ).rejects.toThrow(/not a regular file/)
      await expect(readFile(outside, 'utf8')).resolves.toBe('outside\n')
    })
  })

  it('rejects a symbolic-link ancestor without writing outside the knowledge root', async () => {
    await withRoot(async (root) => {
      const outside = await mkdtemp(join(tmpdir(), 'agent-knowledge-outside-'))
      try {
        await writeFile(join(outside, 'page.md'), 'outside\n')
        await symlink(outside, join(root, 'knowledge'))

        await expect(
          prepareKnowledgeFileTransaction({
            root,
            transactionRoot: join(root, '.transactions'),
            purpose: 'ancestor-symlink-attack',
            mutations: [{ path: 'knowledge/page.md', content: 'overwrite\n' }],
          }),
        ).rejects.toThrow(/unsafe directory/)
        await expect(readFile(join(outside, 'page.md'), 'utf8')).resolves.toBe('outside\n')
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    })
  })

  it('rejects a symbolic-link metadata directory before acquiring the package lock', async () => {
    await withRoot(async (root) => {
      const outside = await mkdtemp(join(tmpdir(), 'agent-knowledge-lock-outside-'))
      try {
        await symlink(outside, join(root, '.agent-knowledge'))
        await expect(withKnowledgeMutation(root, async () => undefined)).rejects.toThrow(
          /unsafe directory/,
        )
        await expect(stat(join(outside, 'mutation.lock.durable.lock'))).rejects.toMatchObject({
          code: 'ENOENT',
        })
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    })
  })

  it.skipIf(process.platform !== 'linux')(
    'keeps an in-flight write on its opened directory when an ancestor is swapped',
    async () => {
      await withRoot(async (root) => {
        const outside = await mkdtemp(join(tmpdir(), 'agent-knowledge-outside-'))
        try {
          await mkdir(join(root, 'knowledge'), { recursive: true })
          await writeFile(join(root, 'knowledge', 'page.md'), 'before\n')
          await writeFile(join(outside, 'page.md'), 'outside\n')
          const transactionRoot = join(root, '.transactions')
          const prepared = await prepareKnowledgeFileTransaction({
            root,
            transactionRoot,
            purpose: 'ancestor-swap-attack',
            mutations: [{ path: 'knowledge/page.md', content: 'after\n' }],
          })
          expect(prepared).not.toBeNull()

          let swapped = false
          await expect(
            applyKnowledgeFileTransaction({
              root,
              transactionRoot,
              transaction: prepared!,
              async beforeCommit() {
                if (swapped) return
                swapped = true
                await rename(join(root, 'knowledge'), join(root, 'knowledge-original'))
                await symlink(outside, join(root, 'knowledge'))
              },
            }),
          ).rejects.toThrow(/unsafe directory/)

          await expect(readFile(join(outside, 'page.md'), 'utf8')).resolves.toBe('outside\n')
          await expect(readFile(join(root, 'knowledge-original', 'page.md'), 'utf8')).resolves.toBe(
            'after\n',
          )
        } finally {
          await rm(outside, { recursive: true, force: true })
        }
      })
    },
  )

  it.skipIf(process.platform !== 'linux')(
    'keeps transaction state in its opened metadata directory when that path is swapped',
    async () => {
      await withRoot(async (root) => {
        const outside = await mkdtemp(join(tmpdir(), 'agent-knowledge-metadata-outside-'))
        try {
          await mkdir(join(root, 'knowledge'), { recursive: true })
          await writeFile(join(root, 'knowledge', 'page.md'), 'before\n')

          await withKnowledgeMutation(root, async (lock) => {
            const transaction = await prepareKnowledgeFileTransaction({
              root,
              transactionRoot: lock.transactionRoot,
              purpose: 'metadata-swap',
              mutations: [{ path: 'knowledge/page.md', content: 'after\n' }],
            })
            expect(transaction).not.toBeNull()

            await rename(join(root, '.agent-knowledge'), join(root, '.agent-knowledge-original'))
            await symlink(outside, join(root, '.agent-knowledge'))

            await applyKnowledgeFileTransaction({
              root,
              transactionRoot: lock.transactionRoot,
              transaction: transaction!,
            })
            await finishKnowledgeFileTransaction({
              root,
              transactionRoot: lock.transactionRoot,
              transaction: transaction!,
            })
          })

          await expect(readFile(join(root, 'knowledge', 'page.md'), 'utf8')).resolves.toBe(
            'after\n',
          )
          await expect(stat(join(outside, 'file-transactions'))).rejects.toMatchObject({
            code: 'ENOENT',
          })
        } finally {
          await rm(outside, { recursive: true, force: true })
        }
      })
    },
  )

  it('rolls an applied transaction back to the exact previous files', async () => {
    await withRoot(async (root) => {
      const transactionRoot = join(root, '.transactions')
      await mkdir(join(root, 'knowledge'), { recursive: true })
      await writeFile(join(root, 'knowledge', 'one.md'), 'one-before\n')
      const prepared = await prepareKnowledgeFileTransaction({
        root,
        transactionRoot,
        purpose: 'rollback',
        mutations: [
          { path: 'knowledge/one.md', content: 'one-after\n' },
          { path: 'knowledge/two.md', content: 'two-after\n' },
        ],
      })
      expect(prepared).not.toBeNull()
      await applyKnowledgeFileTransaction({
        root,
        transactionRoot,
        transaction: prepared!,
      })

      await rollbackKnowledgeFileTransaction({
        root,
        transactionRoot,
        transaction: prepared!,
      })
      await expect(readFile(join(root, 'knowledge', 'one.md'), 'utf8')).resolves.toBe(
        'one-before\n',
      )
      await expect(readFile(join(root, 'knowledge', 'two.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
    })
  })

  it('does not start rollback after the writer loses ownership', async () => {
    await withRoot(async (root) => {
      await mkdir(join(root, 'knowledge'), { recursive: true })
      await writeFile(join(root, 'knowledge', 'one.md'), 'one-before\n')
      await writeFile(join(root, 'knowledge', 'two.md'), 'two-before\n')
      const transactionRoot = join(root, '.transactions')
      const prepared = await prepareKnowledgeFileTransaction({
        root,
        transactionRoot,
        purpose: 'lock-loss',
        mutations: [
          { path: 'knowledge/one.md', content: 'one-after\n' },
          { path: 'knowledge/two.md', content: 'two-after\n' },
        ],
      })
      expect(prepared).not.toBeNull()
      await applyKnowledgeFileTransaction({
        root,
        transactionRoot,
        transaction: prepared!,
      })

      await expect(
        rollbackKnowledgeFileTransaction({
          root,
          transactionRoot,
          transaction: prepared!,
          beforeCommit() {
            throw new KnowledgeLockLostError('simulated ownership loss')
          },
        }),
      ).rejects.toThrow(/ownership loss/)
      await expect(readFile(join(root, 'knowledge', 'one.md'), 'utf8')).resolves.toBe('one-after\n')
      await expect(readFile(join(root, 'knowledge', 'two.md'), 'utf8')).resolves.toBe('two-after\n')
    })
  })

  it('rejects a changed transaction snapshot', async () => {
    await withRoot(async (root) => {
      const transactionRoot = join(root, '.transactions')
      const prepared = await prepareKnowledgeFileTransaction({
        root,
        transactionRoot,
        purpose: 'snapshot-integrity',
        mutations: [{ path: 'knowledge/page.md', content: 'approved\n' }],
      })
      expect(prepared).not.toBeNull()
      await writeFile(
        join(transactionRoot, `active-${prepared!.transactionId}`, 'after', '0.bin'),
        'tampered\n',
      )

      await expect(
        applyKnowledgeFileTransaction({
          root,
          transactionRoot,
          transaction: prepared!,
        }),
      ).rejects.toThrow(/snapshot changed/)
      await expect(readFile(join(root, 'knowledge', 'page.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
    })
  })
})

describe('knowledge transaction plan hash', () => {
  const pagesDirectory = 'kb/pages'
  const plan = [
    {
      path: `${pagesDirectory}/concepts/example.md`,
      beforeHash: null,
      afterHash: 'h',
      afterMode: 0o644,
    },
  ]

  it('accepts exactly the paths the transaction validator accepts', () => {
    // A store laid out under a caller-chosen pages directory writes through the
    // same paths it hashes. When the two disagreed, every promotion in such a
    // store was refused by the hash after the transaction had accepted it.
    expect(assertKnowledgeMutationPath(plan[0]!.path, pagesDirectory)).toBe(plan[0]!.path)
    expect(knowledgeFileTransactionPlanHash(plan, pagesDirectory)).toMatch(/^[0-9a-f]{64}$/)

    expect(() => assertKnowledgeMutationPath(plan[0]!.path, DEFAULT_PAGES_DIRECTORY)).toThrow(
      /unsupported path/,
    )
    expect(() => knowledgeFileTransactionPlanHash(plan, DEFAULT_PAGES_DIRECTORY)).toThrow(
      /unsupported path/,
    )
  })

  it('hashes a default-directory plan to the value already recorded in promotions', () => {
    // Promotion plan hashes are compared against values stored by earlier runs,
    // so this digest outlives the process and must not move.
    expect(
      knowledgeFileTransactionPlanHash(
        [
          { path: 'knowledge/concepts/a.md', beforeHash: null, afterHash: 'h1', afterMode: 0o644 },
          {
            path: 'raw/sources/s.md',
            beforeHash: 'h0',
            beforeMode: 0o644,
            afterHash: 'h2',
            afterMode: 0o644,
          },
        ],
        DEFAULT_PAGES_DIRECTORY,
      ),
    ).toBe('be26a6a2f40cb19ab64e40a55cbb6d87bfc63b5997d7ad2ae8a132797a97eee4')
  })
})
