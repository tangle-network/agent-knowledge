import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
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
import {
  DEFAULT_STALE_MS,
  describeHolder,
  holderIsProvablyDead,
  type LockHolder,
  loadLockfile,
  readLockOwner,
  recordLockOwner,
  STORE_LOCK,
  staleWindow,
  takeOverDeadHolder,
} from './lock-holder'

const DEFAULT_READ_WAIT_MS = 25
const MAX_POLL_MS = 250

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * How long a writer waits for the store lock, behind this process's writers and then another
 * process's hold, before it fails naming the holder. It is the default stale window: by then the
 * holder released, or stopped heartbeating and its lock was taken over, or it held the store
 * longer than a crashed holder could wedge it.
 *
 * Holds measured on Discovery's archive USB disk had a median of 30.4 s and reached 92.6 s, and
 * the 60 s same-process admission this replaces failed a queued `knowledge_record` terminally
 * there, losing the write (agent-knowledge#251). On flash the same holds take 58-86 ms.
 */
const WRITER_WAIT_MS = DEFAULT_STALE_MS

/**
 * How long a reader waits out writes before failing, when the caller sets no `retries`. It covers
 * the slowest hold measured (92.6 s); the 2.5 s it replaces failed 18.3% of reads on that disk.
 * A read changes nothing, so failing one loses no work, which is why it waits less than a writer.
 */
const READER_WAIT_MS = 2 * 60 * 1000

/** Purpose prefix of a proposal write; its purpose hashes the exact proposal. */
export const KNOWLEDGE_PROPOSAL_PURPOSE_PREFIX = 'knowledge-proposal:'

/**
 * A pending transaction with no recovery owner, found by a caller that holds the exclusive lock
 * and is not resuming that purpose. The transaction belongs to the lock hold that opened it, and
 * holding the lock now proves that hold ended: released on an error or exit, expired, or broken
 * because its holder was provably dead. Its caller never saw success, so rolling it back leaves
 * the store as that caller last saw it, and an identical retry still writes cleanly.
 */
function isAbandonedTransaction(
  pending: { purpose: string; recoveryOwner?: string },
  resumingPurpose?: string,
): boolean {
  return !pending.recoveryOwner && pending.purpose !== resumingPurpose
}

const holderLabels = new AsyncLocalStorage<string>()

/**
 * Name the store mutations `body` performs, so a writer or reader that times out behind them can
 * say who held the store. Internal: tools label their writes with the tool and actor.
 */
export function withKnowledgeMutationLabel<T>(label: string, body: () => Promise<T>): Promise<T> {
  return holderLabels.run(label, body)
}

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`
}

interface KnowledgeMutationScope {
  active: boolean
  lock: KnowledgeMutationLock
}

const activeRoots = new AsyncLocalStorage<ReadonlyMap<string, KnowledgeMutationScope>>()
const activeReadRoots = new AsyncLocalStorage<ReadonlySet<string>>()

/**
 * In-process admission to one store root, in front of the cross-process file lock.
 *
 * Writers queue FIFO here instead of polling the file lock with backoff, so only one writer in
 * this process contends for it at a time. Readers share the gate and exclude this process's
 * writers, so a reader never restarts because a same-process write moved the epoch. The gate is
 * phase-fair: a releasing writer admits every waiting reader at once, and a waiting writer stops
 * new readers from entering, so neither side starves. Other processes still meet the file lock
 * and the epoch exactly as before.
 */
interface RootGate {
  readers: number
  writing: boolean
  /** The admitted writer, named in a waiter's timeout. */
  holder: LockHolder | undefined
  readersWaiting: Array<() => void>
  writersWaiting: Array<() => void>
}

const gates = new Map<string, RootGate>()

function gateOf(root: string): RootGate {
  let gate = gates.get(root)
  if (!gate) {
    gate = { readers: 0, writing: false, holder: undefined, readersWaiting: [], writersWaiting: [] }
    gates.set(root, gate)
  }
  return gate
}

/** Admit whoever may go next: waiting readers after a write, otherwise a waiting writer first. */
function admitNext(root: string, gate: RootGate, afterWrite: boolean): void {
  if (gate.writing) return
  if (gate.readersWaiting.length > 0 && (afterWrite || gate.writersWaiting.length === 0)) {
    const admitted = gate.readersWaiting.splice(0)
    gate.readers += admitted.length
    for (const admit of admitted) admit()
  } else if (gate.readers === 0 && gate.writersWaiting.length > 0) {
    gate.writing = true
    gate.writersWaiting.shift()!()
  } else if (gate.readers === 0) {
    gates.delete(root)
  }
}

/** Who a same-process waiter is waiting behind, for its timeout error. */
function describeGate(gate: RootGate): string {
  const queued = gate.writersWaiting.length
  const behind = gate.holder
    ? describeHolder(gate.holder)
    : gate.readers > 0
      ? `${gate.readers} reader(s) of this process`
      : 'no admitted writer'
  return queued > 0 ? `${behind}; ${queued} writer(s) still queued` : behind
}

async function enterGate(
  root: string,
  mode: 'read' | 'write',
  timeoutMs: number,
  label = 'a knowledge mutation',
): Promise<() => void> {
  const gate = gateOf(root)
  const release =
    mode === 'read'
      ? () => {
          gate.readers -= 1
          if (gate.readers === 0) admitNext(root, gate, false)
        }
      : () => {
          gate.writing = false
          gate.holder = undefined
          admitNext(root, gate, true)
        }
  const hold = () => {
    if (mode === 'write')
      gate.holder = { label, pid: process.pid, host: hostname(), since: Date.now() }
    return once(release)
  }
  const free =
    mode === 'read'
      ? !gate.writing && gate.writersWaiting.length === 0
      : !gate.writing && gate.readers === 0 && gate.writersWaiting.length === 0
  if (free) {
    if (mode === 'read') gate.readers += 1
    else gate.writing = true
    return hold()
  }
  const waiting = mode === 'read' ? gate.readersWaiting : gate.writersWaiting
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined
    const admit = () => {
      if (timer) clearTimeout(timer)
      resolve(hold())
    }
    waiting.push(admit)
    timer = setTimeout(() => {
      const position = waiting.indexOf(admit)
      if (position < 0) return
      waiting.splice(position, 1)
      const behind = describeGate(gate)
      // A departing writer may have been the only thing holding readers back.
      admitNext(root, gate, mode === 'write')
      reject(
        mode === 'read'
          ? new Error(
              `knowledge read could not observe a stable mutation epoch: ${root}; waited ${seconds(timeoutMs)} behind ${behind}`,
            )
          : Object.assign(
              new Error(
                `knowledge store is locked by this process: ${root}; waited ${seconds(timeoutMs)} behind ${behind}`,
              ),
              { code: 'ELOCKED' },
            ),
      )
    }, timeoutMs)
    timer.unref?.()
  })
}

function once(release: () => void): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    release()
  }
}

/** Measured cost of the outermost store mutation run inside `measureKnowledgeMutation`. */
export interface KnowledgeMutationTiming {
  /** Same-process queueing plus cross-process file lock acquisition. */
  lockWaitMs: number
  /** Time the store lock was held, including epoch and transaction durability. */
  lockHoldMs: number
}

const mutationTimings = new AsyncLocalStorage<KnowledgeMutationTiming[]>()

/** Run `body` and report the lock timings of the store mutations it performed. */
export async function measureKnowledgeMutation<T>(
  body: () => Promise<T>,
): Promise<{ value: T; timing: KnowledgeMutationTiming | undefined }> {
  const timings: KnowledgeMutationTiming[] = []
  const value = await mutationTimings.run(timings, body)
  return {
    value,
    timing:
      timings.length === 0
        ? undefined
        : timings.reduce((sum, next) => ({
            lockWaitMs: sum.lockWaitMs + next.lockWaitMs,
            lockHoldMs: sum.lockHoldMs + next.lockHoldMs,
          })),
  }
}

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
   * window. A holder its owner record proves dead (same host and pid namespace, the same lock
   * directory, and its pid gone, reused or from before a reboot) is taken over at once instead.
   * Any other holder (another host, an old or missing record, no birthtime) keeps the window and
   * can block the next writer for up to `staleMs`. Every caller of a root must use one `staleMs`:
   * a shorter window reads a live holder as stale and can race a takeover.
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
  if (activeReadRoots.getStore()?.has(resolvedRoot)) {
    // The read would wait for this write and this write for the read.
    throw new Error('a knowledge mutation cannot start inside a read of the same store')
  }

  const label =
    holderLabels.getStore() ?? options.resumeTransaction?.purpose ?? 'a knowledge mutation'
  const started = performance.now()
  const leave = await enterGate(
    resolvedRoot,
    'write',
    noRetries(options.retries) ? 0 : WRITER_WAIT_MS,
    label,
  )
  try {
    return await withSafeDirectory(resolvedRoot, '.agent-knowledge', true, async (cacheDir) => {
      const acquired = await acquireStoreLock(resolvedRoot, cacheDir, {
        staleMs: options.staleMs,
        retries: options.retries,
        started,
      })
      await recordLockOwner(cacheDir, label)
      const held = performance.now()
      try {
        return await runOwnedMutation(resolvedRoot, cacheDir, acquired, options, mutate)
      } finally {
        try {
          await acquired.release()
        } finally {
          mutationTimings.getStore()?.push({
            lockWaitMs: Math.round(held - started),
            lockHoldMs: Math.round(performance.now() - held),
          })
        }
      }
    })
  } finally {
    leave()
  }
}

/**
 * Take the cross-process file lock. A caller that sets `retries` keeps that attempt budget; every
 * other writer polls until one deadline shared with its in-process wait, so a hold longer than a
 * fixed number of attempts delays a write instead of failing it.
 */
async function acquireStoreLock(
  root: string,
  cacheDir: string,
  options: { staleMs?: number; retries?: LockOptions['retries']; started: number },
): Promise<DurableFileLock> {
  const lockfilePath = join(cacheDir, STORE_LOCK.directory)
  const deadline = options.started + WRITER_WAIT_MS
  let pause = 10
  for (;;) {
    try {
      return await acquireDurableFileLock(root, {
        lockfilePath,
        staleMs: options.staleMs,
        retries: options.retries ?? 0,
      })
    } catch (error) {
      // A dead holder is broken whatever the caller's retries, and the retry right after it is free.
      if (isLocked(error) && (await takeOverDeadHolder(cacheDir, options.staleMs))) continue
      const remaining = deadline - performance.now()
      if (
        options.retries !== undefined ||
        (error as NodeJS.ErrnoException).code !== 'ELOCKED' ||
        remaining <= 0
      ) {
        throw await namedLockError(error, root, cacheDir, performance.now() - options.started)
      }
      await sleep(Math.min(remaining, pause * (0.5 + Math.random())))
      pause = Math.min(MAX_POLL_MS, pause * 1.5)
    }
  }
}

/** A contended file lock, restated with the holder its owner record names. */
async function namedLockError(
  error: unknown,
  root: string,
  cacheDir: string,
  waitedMs: number,
): Promise<unknown> {
  if (!isLocked(error)) return error
  const owner = await readLockOwner(cacheDir)
  return Object.assign(
    new Error(
      `knowledge store is locked by another process: ${root}; waited ${seconds(waitedMs)} for ${owner ? describeHolder(owner) : 'a holder that recorded no owner'}`,
      { cause: error },
    ),
    { code: 'ELOCKED' },
  )
}

function isLocked(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ELOCKED'
}

function noRetries(retries: KnowledgeMutationOptions['retries']): boolean {
  return (
    retries === 0 ||
    (typeof retries === 'object' && !Array.isArray(retries) && retries.retries === 0)
  )
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
 * Holding it also authorizes rolling back a pending transaction with no recovery owner, as every
 * holder of the store lock does.
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
    const abandoned =
      pending !== null && isAbandonedTransaction(pending, options.resumeTransaction?.purpose)
    const resume =
      pending && !abandoned
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
        if (pending && abandoned) {
          await rollBackAbandonedTransaction(
            resolvedRoot,
            mutationLock.transactionRoot,
            pending,
            mutationLock.assertOwned,
          )
        } else if (pending && resume) {
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

/** Called once the abandoned case is excluded, so a mismatched purpose names a recovery owner. */
function assertKnowledgeTransactionResume(
  pending: KnowledgeFileTransaction,
  resume: KnowledgeMutationOptions['resumeTransaction'],
): NonNullable<KnowledgeMutationOptions['resumeTransaction']> {
  if (
    !resume ||
    pending.purpose !== resume.purpose ||
    (pending.recoveryOwner && pending.recoveryOwner !== resume.recoveryOwner)
  ) {
    throw ownerResumeRefusal(pending)
  }
  if (pending.recoveryOwner !== resume.recoveryOwner) {
    throw new Error(`knowledge transaction '${pending.purpose}' has no recovery owner`)
  }
  return resume
}

/** The refusal every reader and writer meets while an owned transaction is pending. */
function ownerResumeRefusal(pending: KnowledgeFileTransaction): Error {
  const owner = pending.recoveryOwner ?? 'its recovery owner'
  const transition = pending.purpose.startsWith('knowledge-promotion:')
    ? 'promoteKnowledgeCandidate'
    : pending.purpose.startsWith('knowledge-restore:')
      ? 'restoreKnowledgeCandidateBaseline'
      : undefined
  const resumeCall = transition
    ? `re-run ${transition} with the same candidate${owner.startsWith('knowledge-improvement-activation:') ? ' and the same activation' : ''}`
    : `re-run the call that owns '${owner}' with the same purpose`
  return new Error(
    `knowledge transaction '${pending.purpose}' requires its owner to resume: it must be resumed by '${owner}' (transaction ${pending.transactionId}, created ${pending.createdAt}); ${resumeCall}`,
  )
}

async function rollBackAbandonedTransaction(
  root: string,
  transactionRoot: string,
  pending: KnowledgeFileTransaction,
  assertOwned: () => void,
): Promise<void> {
  await recoverKnowledgeFileTransaction({
    root,
    transactionRoot,
    expectedPurpose: pending.purpose,
    direction: 'rollback',
    assertOwned,
  })
  process.emitWarning(
    `rolled back abandoned knowledge transaction ${pending.transactionId} ('${pending.purpose}', created ${pending.createdAt}): its writer ended without success and named no recovery owner`,
    { type: 'AgentKnowledgeRecovery', code: 'AGENT_KNOWLEDGE_TRANSACTION_ROLLBACK' },
  )
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
  const started = performance.now()
  const retries = options.retries
  // `retries` keeps its attempt budget and fixed pause. Without it a reader waits out writes until
  // one deadline, backing its polls off to MAX_POLL_MS so a long hold costs few epoch reads.
  const budgetMs =
    retries === undefined
      ? READER_WAIT_MS
      : (retries + 1) * (options.waitMs ?? DEFAULT_READ_WAIT_MS)
  const deadline = started + budgetMs
  const leave = await enterGate(resolvedRoot, 'read', budgetMs)
  try {
    return await activeReadRoots.run(readRoots, async () => {
      let pause = options.waitMs ?? DEFAULT_READ_WAIT_MS
      for (let attempt = 0; retries === undefined || attempt <= retries; attempt += 1) {
        if (attempt > 0 && retries === undefined && performance.now() >= deadline) break
        const before = await readMutationEpoch(resolvedRoot)
        let active = before
        if (!isOdd(before)) {
          const result = await read()
          const after = await readMutationEpoch(resolvedRoot)
          if (before === after) return result
          // A whole write landed during the read: read again at once.
          if (!isOdd(after)) continue
          active = after
        }
        await waitForActiveMutationEpoch(resolvedRoot, active, options, pause)
        if (retries === undefined) pause = Math.min(MAX_POLL_MS, pause * 1.5)
      }
      throw new Error(
        `knowledge read could not observe a stable mutation epoch: ${resolvedRoot}; waited ${seconds(performance.now() - started)} for ${await describeWriter(resolvedRoot)}`,
      )
    })
  } finally {
    leave()
  }
}

/** The writer a reader gave up on: this process's admitted writer, else the recorded owner. */
async function describeWriter(root: string): Promise<string> {
  const local = gates.get(root)?.holder
  if (local) return describeHolder(local)
  let owner: LockHolder | undefined
  try {
    owner = await withSafeDirectory(root, '.agent-knowledge', false, readLockOwner)
  } catch {
    owner = undefined
  }
  return owner ? describeHolder(owner) : 'a writer that recorded no owner'
}

export async function acquireDurableFileLock(
  target: string,
  options: { lockfilePath: string; staleMs?: number; retries?: LockOptions['retries'] },
): Promise<DurableFileLock> {
  const stale = staleWindow(options.staleMs)
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
  pauseMs: number,
): Promise<void> {
  if (!(await hasActiveMutationLock(root, options)))
    await healAbandonedMutationEpoch(root, epoch, options)
  await sleep(pauseMs)
}

async function healAbandonedMutationEpoch(
  root: string,
  expectedEpoch: number,
  options: KnowledgeReadOptions,
): Promise<void> {
  await withSafeDirectory(root, '.agent-knowledge', false, async (cacheDir) => {
    const acquire = () =>
      acquireDurableFileLock(root, {
        lockfilePath: join(cacheDir, STORE_LOCK.directory),
        staleMs: options.staleMs,
        retries: 0,
      }).catch((error: unknown) => {
        if (isLocked(error)) return undefined
        throw error
      })
    const acquired =
      (await acquire()) ??
      ((await takeOverDeadHolder(cacheDir, options.staleMs)) ? await acquire() : undefined)
    if (!acquired) return
    // A healer killed during a slow rollback must leave a lock the next caller can prove dead.
    await recordLockOwner(cacheDir, 'heal of an abandoned mutation epoch')
    try {
      const currentEpoch = await readMutationEpochFromCache(cacheDir)
      if (currentEpoch !== expectedEpoch || !isOdd(currentEpoch)) return
      const pending = await inspectKnowledgeFileTransaction({
        root,
        transactionRoot: join(cacheDir, 'file-transactions'),
      })
      if (pending && isAbandonedTransaction(pending.transaction)) {
        await rollBackAbandonedTransaction(
          root,
          join(cacheDir, 'file-transactions'),
          pending.transaction,
          () => acquired.assertOwned(),
        )
      } else if (pending) {
        throw ownerResumeRefusal(pending.transaction)
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
    // A provably dead holder reads as inactive, so the heal runs and takes its lock over.
    return await withSafeDirectory(
      root,
      '.agent-knowledge',
      false,
      async (cacheDir) =>
        (await check(root, {
          lockfilePath: join(cacheDir, STORE_LOCK.directory),
          realpath: false,
          stale: staleWindow(options.staleMs),
        })) && !(await holderIsProvablyDead(cacheDir)),
    )
  } catch (error) {
    if (isMissingFile(error)) return false
    throw error
  }
}

function isOdd(value: number): boolean {
  return value % 2 === 1
}
