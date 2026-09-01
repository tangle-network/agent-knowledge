import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { LockOptions } from 'proper-lockfile'
import {
  isMissingFile,
  withSafeDescendant,
  withSafeDirectory,
  writeJsonDurableWithinRoot,
} from './durable-fs'
import {
  inspectKnowledgeFileTransaction,
  type KnowledgeFileTransaction,
  loadKnowledgeFileTransaction,
  recoverKnowledgeFileTransaction,
} from './file-transaction'

const DEFAULT_STALE_MS = 15 * 60 * 1000
const DEFAULT_READ_RETRIES = 100
const DEFAULT_READ_WAIT_MS = 25

// `proper-lockfile` pulls in `graceful-fs`, which patches Node's `fs` at MODULE
// scope (`fs.close = ...`, `fs.closeSync = ...`). workerd exposes those as
// getter-only accessors, so a STATIC import makes the assignment throw while
// Cloudflare runs startup validation on upload — `Cannot set property close of
// #<Object> which has only a getter [code: 10021]` — rejecting the whole Worker
// before any request frame exists, uncatchably, even for bundles that never
// take a lock. Loading it on first use keeps this module importable at the
// edge. Every consumer below is already async, so nothing else changes.
let lockfileModule: Promise<typeof import('proper-lockfile')> | undefined

function loadLockfile(): Promise<typeof import('proper-lockfile')> {
  lockfileModule ??= import('proper-lockfile')
  return lockfileModule
}

interface KnowledgeMutationScope {
  active: boolean
  lock: KnowledgeMutationLock
}

const activeRoots = new AsyncLocalStorage<ReadonlyMap<string, KnowledgeMutationScope>>()
const activeReadRoots = new AsyncLocalStorage<ReadonlySet<string>>()

export interface KnowledgeMutationLock {
  readonly transactionRoot: string
  readonly recovery?: KnowledgeMutationRecovery
  assertOwned(): void
}

interface KnowledgeMutationRecovery {
  transactionId: string
  purpose: string
  direction: 'apply' | 'rollback'
  transaction: KnowledgeFileTransaction
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
  /**
   * How long a lock may go without a heartbeat before another taker treats it as abandoned.
   * Defaults to 15 minutes, and is floored at 5 seconds. The holder heartbeats at a third of this
   * window, so the window is also the bound on how long a crashed holder wedges every other
   * writer: a process that dies mid-write blocks the next one for up to `staleMs`.
   *
   * The default is sized for a knowledge-improvement run that holds the lock across agent turns.
   * A consumer whose holds are short should say so and take the shorter wedge — measured holds of
   * this lock are 9 ms for one page, 586 ms for a 50-page batch, and about 390 ms for the longest
   * promotion in the largest store, against a 900 s default.
   */
  staleMs?: number
  resumeTransaction?: {
    purpose: string
    recoveryOwner?: string
    validate?: (transaction: KnowledgeFileTransaction) => void
    direction?: 'apply' | 'rollback'
    deferFinish?: boolean
  }
  retries?: LockOptions['retries']
}

export interface PendingKnowledgeMutation {
  transactionId: string
  purpose: string
  recoveryOwner?: string
  createdAt: string
  direction: 'apply' | 'rollback'
  paths: string[]
}

export interface RecoverPendingKnowledgeMutationOptions {
  transactionId: string
  action: 'apply' | 'rollback'
}

export interface KnowledgeReadOptions {
  staleMs?: number
  retries?: number
  waitMs?: number
}

/**
 * A store lock over a knowledge root that a caller took by its own path, and the one question
 * this package asks of it.
 *
 * A consumer that batches its own writes around a read-modify-write takes the lock itself and
 * then needs to call this package inside that window. It supplies the hold; this package supplies
 * the scope, so a nested `withKnowledgeMutation` on the same root runs inline instead of blocking
 * against a lock the caller already owns.
 */
export interface KnowledgeMutationHold {
  /**
   * Throw when the lock is no longer owned. Every mutation asks before it begins and again after
   * it returns, so a lock lost to a stale-timeout takeover stops the write rather than letting it
   * land under a lock somebody else now holds.
   */
  assertOwned(): void
}

/**
 * Whether the current async context already holds the store lock for `root`.
 *
 * A caller that must decide between taking the lock and joining the one it is inside reads this
 * rather than guessing; taking a held lock from inside its own scope would block against itself.
 */
export function isKnowledgeMutationHeld(root: string): boolean {
  return activeRoots.getStore()?.get(resolve(root))?.active === true
}

export async function withKnowledgeMutation<T>(
  root: string,
  mutate: (lock: KnowledgeMutationLock) => Promise<T> | T,
  options: KnowledgeMutationOptions = {},
): Promise<T> {
  const resolvedRoot = resolve(root)
  const existing = activeRoots.getStore()?.get(resolvedRoot)
  if (existing?.active) return await runInlineMutation(existing.lock, mutate)

  return withSafeDirectory(resolvedRoot, '.agent-knowledge', true, async (cacheDir) => {
    const acquired = await acquireDurableFileLock(resolvedRoot, {
      lockfilePath: join(cacheDir, 'mutation.lock.durable'),
      staleMs: options.staleMs,
      retries:
        options.retries ??
        ({ retries: 100, factor: 1.1, minTimeout: 10, maxTimeout: 200, randomize: true } as const),
    })
    try {
      return await runOwnedMutation(resolvedRoot, cacheDir, acquired, options, mutate)
    } finally {
      await acquired.release()
    }
  })
}

/**
 * Run `body` inside this package's mutation scope for `root`, on a lock the caller already holds.
 *
 * The caller owns acquiring and releasing that lock; this package owns the scope, the file
 * transaction it opens, and the epoch a concurrent reader watches. Inside `body`, every
 * lock-taking function in this package sees the root as held and runs inline, which is what makes
 * a consumer's own read-modify-write composable with this package instead of exclusive of it.
 *
 * The hold is asked `assertOwned()` at the same points a lock this package acquired is asked, so
 * an externally held lock carries the same guarantee and not a weaker one. Entering a scope for a
 * lock the caller does not actually hold is the one way to defeat the store's single-writer rule;
 * the hold is required, rather than assumed, so that is a statement the caller has to make.
 */
export async function runInKnowledgeMutationScope<T>(
  root: string,
  hold: KnowledgeMutationHold,
  body: (lock: KnowledgeMutationLock) => Promise<T> | T,
  options: KnowledgeMutationOptions = {},
): Promise<T> {
  const resolvedRoot = resolve(root)
  const existing = activeRoots.getStore()?.get(resolvedRoot)
  if (existing?.active) return await runInlineMutation(existing.lock, body)

  return withSafeDirectory(resolvedRoot, '.agent-knowledge', true, (cacheDir) =>
    runOwnedMutation(resolvedRoot, cacheDir, hold, options, body),
  )
}

/** The reentrant path: the root is already held in this async context, so no lock is taken. */
async function runInlineMutation<T>(
  lock: KnowledgeMutationLock,
  mutate: (lock: KnowledgeMutationLock) => Promise<T> | T,
): Promise<T> {
  lock.assertOwned()
  const result = await mutate(lock)
  lock.assertOwned()
  return result
}

/** The owning path, shared by a lock this package acquired and a lock the caller supplies. */
async function runOwnedMutation<T>(
  resolvedRoot: string,
  cacheDir: string,
  hold: KnowledgeMutationHold,
  options: KnowledgeMutationOptions,
  mutate: (lock: KnowledgeMutationLock) => Promise<T> | T,
): Promise<T> {
  let recovery: KnowledgeMutationRecovery | undefined
  const mutationLock: KnowledgeMutationLock = {
    transactionRoot: join(cacheDir, 'file-transactions'),
    get recovery() {
      return recovery
    },
    assertOwned: () => hold.assertOwned(),
  }
  const scope: KnowledgeMutationScope = { active: true, lock: mutationLock }
  try {
    const pendingState = await inspectKnowledgeFileTransaction({
      root: resolvedRoot,
      transactionRoot: mutationLock.transactionRoot,
    })
    const pending = pendingState?.transaction ?? null
    const resume = pending
      ? assertKnowledgeTransactionResume(pending, options.resumeTransaction)
      : undefined
    const locks = new Map(activeRoots.getStore())
    locks.set(resolvedRoot, scope)
    return await activeRoots.run(locks, async () => {
      const epoch = await beginMutationEpoch(cacheDir)
      const finishEpoch = async (completed: boolean) => {
        mutationLock.assertOwned()
        const stillPending = await loadKnowledgeFileTransaction({
          root: resolvedRoot,
          transactionRoot: mutationLock.transactionRoot,
        })
        if (completed && stillPending) {
          throw new Error('knowledge mutation returned with an unfinished transaction')
        }
        if (!stillPending) await finishMutationEpoch(cacheDir, epoch)
      }
      try {
        if (pending) {
          if (!resume)
            throw new Error(
              `knowledge transaction '${pending.purpose}' requires its owner to resume`,
            )
          await recoverKnowledgeFileTransaction({
            root: resolvedRoot,
            transactionRoot: mutationLock.transactionRoot,
            expectedPurpose: resume.purpose,
            direction: resume.direction,
            finish: resume.deferFinish !== true,
            validate: resume.validate,
            assertOwned: mutationLock.assertOwned,
          })
          recovery = Object.freeze({
            transactionId: pending.transactionId,
            purpose: pending.purpose,
            direction: resume.direction ?? pendingState?.direction ?? 'apply',
            transaction: pending,
          })
        }
        mutationLock.assertOwned()
        const result = await mutate(mutationLock)
        mutationLock.assertOwned()
        await finishEpoch(true)
        return result
      } catch (error) {
        try {
          await finishEpoch(false)
        } catch (finishError) {
          throw new AggregateError(
            [error, finishError],
            'knowledge mutation failed and its durable state could not be inspected',
          )
        }
        throw error
      }
    })
  } finally {
    scope.active = false
  }
}

export async function inspectPendingKnowledgeMutation(
  root: string,
): Promise<PendingKnowledgeMutation | null> {
  const resolvedRoot = resolve(root)
  const pending = await inspectKnowledgeFileTransaction({
    root: resolvedRoot,
    transactionRoot: join(resolvedRoot, '.agent-knowledge', 'file-transactions'),
  })
  if (!pending) return null
  const { transaction, direction } = pending
  return {
    transactionId: transaction.transactionId,
    purpose: transaction.purpose,
    ...(transaction.recoveryOwner ? { recoveryOwner: transaction.recoveryOwner } : {}),
    createdAt: transaction.createdAt,
    direction,
    paths: transaction.entries.map((entry) => entry.path),
  }
}

function assertKnowledgeTransactionResume(
  pending: KnowledgeFileTransaction,
  resume: KnowledgeMutationOptions['resumeTransaction'],
): NonNullable<KnowledgeMutationOptions['resumeTransaction']> {
  if (!resume || pending.purpose !== resume.purpose) {
    throw new Error(`knowledge transaction '${pending.purpose}' requires its owner to resume`)
  }
  if (pending.recoveryOwner !== resume.recoveryOwner) {
    if (pending.recoveryOwner) {
      throw new Error(
        `knowledge transaction '${pending.purpose}' must be resumed by '${pending.recoveryOwner}'`,
      )
    }
    throw new Error(`knowledge transaction '${pending.purpose}' has no recovery owner`)
  }
  return resume
}

export async function recoverPendingKnowledgeMutation(
  root: string,
  options: RecoverPendingKnowledgeMutationOptions,
): Promise<void> {
  const pending = await inspectPendingKnowledgeMutation(root)
  if (!pending) throw new Error('knowledge base has no pending mutation')

  let matched = false
  await withKnowledgeMutation(
    root,
    () => {
      if (!matched) throw new Error('pending knowledge mutation changed before recovery')
    },
    {
      resumeTransaction: {
        purpose: pending.purpose,
        direction: options.action,
        validate(transaction) {
          if (transaction.transactionId !== options.transactionId) {
            throw new Error(`pending knowledge mutation does not match '${options.transactionId}'`)
          }
          matched = true
        },
      },
    },
  )
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
  const { lock } = await loadLockfile()
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

async function beginMutationEpoch(cacheDir: string): Promise<number> {
  const current = await readMutationEpochFromCache(cacheDir)
  const odd = isOdd(current) ? current : current + 1
  await writeMutationEpoch(cacheDir, odd)
  return odd
}

async function finishMutationEpoch(cacheDir: string, odd: number): Promise<void> {
  await writeMutationEpoch(cacheDir, isOdd(odd) ? odd + 1 : odd)
}

async function readMutationEpoch(root: string): Promise<number> {
  try {
    return await withSafeDirectory(root, '.agent-knowledge', false, readMutationEpochFromCache)
  } catch (error) {
    if (isMissingFile(error)) return 0
    throw error
  }
}

async function readMutationEpochFromCache(cacheDir: string): Promise<number> {
  try {
    const text = await withSafeDescendant(cacheDir, 'mutation-epoch.json', (path) =>
      readFile(path, 'utf8'),
    )
    const parsed = JSON.parse(text) as { epoch?: unknown }
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

async function writeMutationEpoch(cacheDir: string, epoch: number): Promise<void> {
  await writeJsonDurableWithinRoot(cacheDir, 'mutation-epoch.json', {
    epoch,
    updatedAt: new Date().toISOString(),
  })
}

async function waitForActiveMutationEpoch(
  root: string,
  epoch: number,
  options: KnowledgeReadOptions,
): Promise<void> {
  if (!(await hasActiveMutationLock(root, options)))
    await healAbandonedMutationEpoch(root, epoch, options)
  await new Promise((resolve) => setTimeout(resolve, options.waitMs ?? DEFAULT_READ_WAIT_MS))
}

async function healAbandonedMutationEpoch(
  root: string,
  expectedEpoch: number,
  options: KnowledgeReadOptions,
): Promise<void> {
  await withSafeDirectory(root, '.agent-knowledge', false, async (cacheDir) => {
    let acquired: DurableFileLock
    try {
      acquired = await acquireDurableFileLock(root, {
        lockfilePath: join(cacheDir, 'mutation.lock.durable'),
        staleMs: options.staleMs,
        retries: 0,
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOCKED') return
      throw error
    }
    try {
      const currentEpoch = await readMutationEpochFromCache(cacheDir)
      if (currentEpoch !== expectedEpoch || !isOdd(currentEpoch)) return
      const pending = await inspectKnowledgeFileTransaction({
        root,
        transactionRoot: join(cacheDir, 'file-transactions'),
      })
      if (pending) {
        throw new Error(
          `knowledge transaction '${pending.transaction.purpose}' requires its owner to resume`,
        )
      }
      await finishMutationEpoch(cacheDir, currentEpoch)
    } finally {
      await acquired.release()
    }
  })
}

async function hasActiveMutationLock(
  root: string,
  options: Pick<KnowledgeReadOptions, 'staleMs'>,
): Promise<boolean> {
  try {
    const { check } = await loadLockfile()
    return await withSafeDirectory(root, '.agent-knowledge', false, (cacheDir) =>
      check(root, {
        lockfilePath: join(cacheDir, 'mutation.lock.durable'),
        realpath: false,
        stale: Math.max(5_000, options.staleMs ?? DEFAULT_STALE_MS),
      }),
    )
  } catch (error) {
    if (isMissingFile(error)) return false
    throw error
  }
}

function isOdd(value: number): boolean {
  return value % 2 === 1
}
