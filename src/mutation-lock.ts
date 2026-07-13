import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { check, type LockOptions, lock } from 'proper-lockfile'
import { isMissingFile, withSafeDirectory, writeJsonDurableWithinRoot } from './durable-fs'
import {
  type KnowledgeFileTransaction,
  loadKnowledgeFileTransaction,
  recoverKnowledgeFileTransaction,
} from './file-transaction'

const DEFAULT_STALE_MS = 15 * 60 * 1000
const DEFAULT_READ_RETRIES = 100
const DEFAULT_READ_WAIT_MS = 25

interface KnowledgeMutationScope {
  active: boolean
  lock: KnowledgeMutationLock
}

const activeRoots = new AsyncLocalStorage<ReadonlyMap<string, KnowledgeMutationScope>>()
const activeReadRoots = new AsyncLocalStorage<ReadonlySet<string>>()

export interface KnowledgeMutationLock {
  readonly transactionRoot: string
  assertOwned(): void
}

export class KnowledgeLockLostError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'KnowledgeLockLostError'
  }
}

interface DurableFileLock {
  assertOwned(): void
  release(): Promise<void>
}

export interface KnowledgeMutationOptions {
  staleMs?: number
  resumeTransaction?: {
    purpose: string
    validate?: (transaction: KnowledgeFileTransaction) => void
  }
  retries?: LockOptions['retries']
}

export interface KnowledgeReadOptions {
  staleMs?: number
  retries?: number
  waitMs?: number
}

export async function withKnowledgeMutation<T>(
  root: string,
  mutate: (lock: KnowledgeMutationLock) => Promise<T> | T,
  options: KnowledgeMutationOptions = {},
): Promise<T> {
  const resolvedRoot = resolve(root)
  const active = activeRoots.getStore()
  const existing = active?.get(resolvedRoot)
  if (existing?.active) {
    existing.lock.assertOwned()
    const result = await mutate(existing.lock)
    existing.lock.assertOwned()
    return result
  }

  return withSafeDirectory(resolvedRoot, '.agent-knowledge', true, async (cacheDir) => {
    const acquired = await acquireDurableFileLock(resolvedRoot, {
      lockfilePath: join(cacheDir, 'mutation.lock.durable'),
      staleMs: options.staleMs,
      retries:
        options.retries ??
        ({ retries: 100, factor: 1.1, minTimeout: 10, maxTimeout: 200, randomize: true } as const),
    })
    const mutationLock: KnowledgeMutationLock = {
      transactionRoot: join(cacheDir, 'file-transactions'),
      assertOwned: acquired.assertOwned,
    }
    const scope: KnowledgeMutationScope = { active: true, lock: mutationLock }
    try {
      const pending = await loadKnowledgeFileTransaction({
        root: resolvedRoot,
        transactionRoot: mutationLock.transactionRoot,
      })
      if (pending) {
        const resume = options.resumeTransaction
        if (!resume || pending.purpose !== resume.purpose) {
          throw new Error(`knowledge transaction '${pending.purpose}' requires its owner to resume`)
        }
      }
      const locks = new Map(active)
      locks.set(resolvedRoot, scope)
      return await activeRoots.run(locks, async () => {
        const epoch = await beginMutationEpoch(resolvedRoot)
        let completed = false
        try {
          if (pending) {
            const resume = options.resumeTransaction
            if (!resume)
              throw new Error(
                `knowledge transaction '${pending.purpose}' requires its owner to resume`,
              )
            await recoverKnowledgeFileTransaction({
              root: resolvedRoot,
              transactionRoot: mutationLock.transactionRoot,
              expectedPurpose: resume.purpose,
              validate: resume.validate,
              assertOwned: acquired.assertOwned,
            })
          }
          mutationLock.assertOwned()
          const result = await mutate(mutationLock)
          mutationLock.assertOwned()
          completed = true
          return result
        } finally {
          mutationLock.assertOwned()
          const stillPending = await loadKnowledgeFileTransaction({
            root: resolvedRoot,
            transactionRoot: mutationLock.transactionRoot,
          })
          if (completed || !stillPending) await finishMutationEpoch(resolvedRoot, epoch)
        }
      })
    } finally {
      scope.active = false
      await acquired.release()
    }
  })
}

export async function withKnowledgeRead<T>(
  root: string,
  read: () => Promise<T> | T,
  options: KnowledgeReadOptions = {},
): Promise<T> {
  const resolvedRoot = resolve(root)
  if (activeRoots.getStore()?.get(resolvedRoot)?.active) return await read()
  if (activeReadRoots.getStore()?.has(resolvedRoot)) return await read()

  const readRoots = new Set(activeReadRoots.getStore())
  readRoots.add(resolvedRoot)
  return activeReadRoots.run(readRoots, async () => {
    const retries = options.retries ?? DEFAULT_READ_RETRIES
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const before = await readMutationEpoch(resolvedRoot)
      if (isOdd(before)) {
        await waitForActiveMutationEpoch(resolvedRoot, before, options)
        continue
      }

      const result = await read()
      const after = await readMutationEpoch(resolvedRoot)
      if (before === after && !isOdd(after)) return result
      if (isOdd(after)) await waitForActiveMutationEpoch(resolvedRoot, after, options)
    }
    throw new Error('knowledge read could not observe a stable mutation epoch')
  })
}

export async function acquireDurableFileLock(
  target: string,
  options: { lockfilePath: string; staleMs?: number; retries?: LockOptions['retries'] },
): Promise<DurableFileLock> {
  const stale = Math.max(5_000, options.staleMs ?? DEFAULT_STALE_MS)
  const update = Math.max(1_000, Math.floor(stale / 3))
  let compromised: Error | undefined
  let released = false
  await mkdir(dirname(options.lockfilePath), { recursive: true })
  const release = await lock(target, {
    lockfilePath: options.lockfilePath,
    realpath: false,
    stale,
    update,
    retries: options.retries,
    onCompromised(error) {
      compromised = error
    },
  })

  return {
    assertOwned() {
      if (released) throw new KnowledgeLockLostError('knowledge filesystem lock is no longer owned')
      if (compromised)
        throw new KnowledgeLockLostError('knowledge filesystem lock was compromised', {
          cause: compromised,
        })
    },
    async release() {
      if (released) return
      released = true
      let releaseError: unknown
      try {
        await release()
      } catch (error) {
        releaseError = error
      }
      if (releaseError && compromised) {
        throw new AggregateError(
          [releaseError, compromised],
          'knowledge filesystem lock was compromised and could not be released',
        )
      }
      if (releaseError) throw releaseError
      if (compromised) {
        throw new KnowledgeLockLostError('knowledge filesystem lock was compromised', {
          cause: compromised,
        })
      }
    },
  }
}

async function beginMutationEpoch(root: string): Promise<number> {
  const current = await readMutationEpoch(root)
  const odd = isOdd(current) ? current : current + 1
  await writeMutationEpoch(root, odd)
  return odd
}

async function finishMutationEpoch(root: string, odd: number): Promise<void> {
  await writeMutationEpoch(root, isOdd(odd) ? odd + 1 : odd)
}

async function readMutationEpoch(root: string): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(mutationEpochPath(root), 'utf8')) as {
      epoch?: unknown
    }
    const epoch = parsed.epoch
    if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) {
      throw new Error('knowledge mutation epoch is invalid')
    }
    return epoch
  } catch (error) {
    if (isMissingFile(error)) return 0
    throw error
  }
}

async function writeMutationEpoch(root: string, epoch: number): Promise<void> {
  await writeJsonDurableWithinRoot(root, '.agent-knowledge/mutation-epoch.json', {
    epoch,
    updatedAt: new Date().toISOString(),
  })
}

async function waitForActiveMutationEpoch(
  root: string,
  epoch: number,
  options: KnowledgeReadOptions,
): Promise<void> {
  if (!(await hasActiveMutationLock(root, options))) {
    throw new Error(`knowledge mutation epoch ${epoch} is odd with no active writer`)
  }
  await new Promise((resolve) => setTimeout(resolve, options.waitMs ?? DEFAULT_READ_WAIT_MS))
}

async function hasActiveMutationLock(
  root: string,
  options: Pick<KnowledgeReadOptions, 'staleMs'>,
): Promise<boolean> {
  try {
    return await check(root, {
      lockfilePath: mutationLockPath(root),
      realpath: false,
      stale: Math.max(5_000, options.staleMs ?? DEFAULT_STALE_MS),
    })
  } catch (error) {
    if (isMissingFile(error)) return false
    throw error
  }
}

function mutationEpochPath(root: string): string {
  return join(root, '.agent-knowledge', 'mutation-epoch.json')
}

function mutationLockPath(root: string): string {
  return join(root, '.agent-knowledge', 'mutation.lock.durable')
}

function isOdd(value: number): boolean {
  return value % 2 === 1
}
