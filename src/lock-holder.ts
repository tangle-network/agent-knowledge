import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { type FileHandle, lstat, open, readdir, rename, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type LockHolderDeathReason,
  type LockHolderIdentity,
  type LockIdentity,
  lockHolderVerdict,
  lockIdentity,
  readLockHolderIdentity,
} from '@tangle-network/agent-eval/lock-holder'
import { writeJsonDurableWithinRoot } from './durable-fs'

export const DEFAULT_STALE_MS = 15 * 60 * 1000

/** The lease a caller's `staleMs` resolves to: the default, floored at 5 s. */
export function staleWindow(staleMs: number | undefined): number {
  return Math.max(5_000, staleMs ?? DEFAULT_STALE_MS)
}

/**
 * The files of one cross-process lock, all beside each other in the directory that holds it: the
 * lock directory proper-lockfile creates, the record of its current holder, which names it in a
 * timeout and proves it dead, and the guard held only while one taker breaks a dead holder's lock,
 * so two takers never both break it.
 */
export interface HeldLock {
  directory: string
  owner: string
  guard: string
  /** What the lock is, as the takeover warning names it. */
  noun: string
}

/** The store's cross-process lock, inside the cache directory. */
export const STORE_LOCK: HeldLock = {
  directory: 'mutation.lock.durable',
  owner: 'mutation.lock.owner.json',
  guard: 'mutation.lock.takeover',
  noun: 'knowledge store lock',
}

/** One knowledge-improvement run's lease, inside its run directory. */
export const RUN_LEASE: HeldLock = {
  directory: 'run.lock.durable',
  owner: 'run.lock.owner.json',
  guard: 'run.lock.takeover',
  noun: 'knowledge improvement run lease',
}

/** A broken lock directory is renamed to `<lock>.dead-<uuid>` beside it, then removed. */
const TOMBSTONE_INFIX = '.dead-'

/** How far before `staleMs` a takeover yields to proper-lockfile's own stale removal. */
const STALE_MARGIN_MS = 60_000

export interface LockHolder {
  label: string
  pid: number
  host: string
  since: number
  /** OS start token of `pid`: Linux `/proc/<pid>/stat` starttime, elsewhere `ps` lstart. */
  processStart?: string
  bootId?: string
  pidNamespace?: string
  /** The lock directory this record was written for. */
  lock?: LockIdentity
}

export function describeHolder(holder: LockHolder, now = Date.now()): string {
  const heldS = Math.max(0, Math.round((now - holder.since) / 1000))
  return `${holder.label} (pid ${holder.pid} on ${holder.host}, holding since ${new Date(holder.since).toISOString()}, ${heldS} s)`
}

// `proper-lockfile` pulls in `graceful-fs`, which patches Node's `fs` at MODULE
// scope (`fs.close = ...`, `fs.closeSync = ...`). workerd exposes those as
// getter-only accessors, so a STATIC import makes the assignment throw while
// Cloudflare runs startup validation on upload — `Cannot set property close of
// #<Object> which has only a getter [code: 10021]` — rejecting the whole Worker
// before any request frame exists, uncatchably, even for bundles that never
// take a lock. Loading it on first use keeps this module importable at the
// edge. Every consumer is already async, so nothing else changes.
let lockfileModule: Promise<typeof import('proper-lockfile')> | undefined

export function loadLockfile(): Promise<typeof import('proper-lockfile')> {
  lockfileModule ??= import('proper-lockfile')
  return lockfileModule
}

// This process's identity never changes, and off Linux reading it runs `ps` synchronously.
let ownIdentity: LockHolderIdentity | undefined

async function readLockDirectoryIdentity(
  cacheDir: string,
  held: HeldLock,
): Promise<LockIdentity | undefined> {
  try {
    const entry = await lstat(join(cacheDir, held.directory), { bigint: true })
    return entry.isDirectory() ? lockIdentity(entry) : undefined
  } catch {
    return undefined
  }
}

/**
 * Record who holds the file lock, and which lock directory, inside the directory that holds it.
 * Call it right after acquiring. Exported for the confinement tests; src/index.ts does not
 * re-export it.
 */
export async function recordLockOwner(
  cacheDir: string,
  label: string,
  held: HeldLock = STORE_LOCK,
): Promise<void> {
  try {
    ownIdentity ??= readLockHolderIdentity()
    const { pid, host, ...identity } = ownIdentity
    const lock = await readLockDirectoryIdentity(cacheDir, held)
    const owner: LockHolder = {
      label,
      pid,
      host,
      since: Date.now(),
      ...identity,
      ...(lock ? { lock } : {}),
    }
    await writeJsonDurableWithinRoot(cacheDir, held.owner, owner)
  } catch {
    // A missing owner record makes a later timeout say so and keeps the lease; it never fails the write.
  }
}

/**
 * `cacheDir` is withSafeDirectory's anchored path, so only the owner file itself can be swapped.
 * Anyone who can write the cache directory can plant a FIFO there, so the open adds O_NONBLOCK
 * and fstat refuses it. The shared readRegularFileNoFollow stays blocking: the event store and
 * file transactions read through it, and their descriptor use must not change.
 *
 * The old shape `{ label, pid, host, since }` still parses. A newer field that is missing or
 * malformed is dropped, which leaves the holder named but never provably dead.
 */
export async function readLockOwner(
  cacheDir: string,
  held: HeldLock = STORE_LOCK,
): Promise<LockHolder | undefined> {
  let handle: FileHandle | undefined
  try {
    handle = await open(
      join(cacheDir, held.owner),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    if (!(await handle.stat()).isFile()) return undefined
    const value = JSON.parse(await handle.readFile('utf8')) as Record<string, unknown> | null
    if (
      typeof value?.label !== 'string' ||
      !Number.isSafeInteger(value.pid) ||
      typeof value.host !== 'string' ||
      typeof value.since !== 'number' ||
      // A Date holds at most ±8.64e15 ms; describeHolder's toISOString throws beyond that.
      Number.isNaN(new Date(value.since).getTime())
    ) {
      return undefined
    }
    const text = (field: unknown) =>
      typeof field === 'string' && field.length > 0 ? field : undefined
    const lock = value.lock as Record<string, unknown> | null | undefined
    const decimal = (field: unknown) => typeof field === 'string' && /^\d+$/u.test(field)
    const processStart = text(value.processStart)
    const bootId = text(value.bootId)
    const pidNamespace = text(value.pidNamespace)
    return {
      label: value.label,
      pid: value.pid as number,
      host: value.host,
      since: value.since,
      ...(processStart ? { processStart } : {}),
      ...(bootId ? { bootId } : {}),
      ...(pidNamespace ? { pidNamespace } : {}),
      ...(lock && decimal(lock.dev) && decimal(lock.ino) && decimal(lock.birthtimeNs)
        ? {
            lock: {
              dev: lock.dev as string,
              ino: lock.ino as string,
              birthtimeNs: lock.birthtimeNs as string,
            },
          }
        : {}),
    }
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export interface DeadHolder {
  holder: LockHolder
  lock: LockIdentity
  reason: LockHolderDeathReason
}

/**
 * The holder of the current lock, when its record proves it dead; otherwise `undefined`, and the
 * caller keeps the `staleMs` lease. agent-eval's `./lock-holder` owns the rule; this module owns
 * reading the record and the lock directory it names.
 */
export async function holderIsProvablyDead(
  cacheDir: string,
  held: HeldLock = STORE_LOCK,
): Promise<DeadHolder | undefined> {
  const holder = await readLockOwner(cacheDir, held)
  const lock = await readLockDirectoryIdentity(cacheDir, held)
  const verdict = lockHolderVerdict(holder, lock)
  return verdict.liveness === 'dead' && holder && lock
    ? { holder, lock, reason: verdict.reason }
    : undefined
}

/**
 * Break the lock of a provably dead holder, and report whether this call broke it. The
 * guard is proper-lockfile itself: a taker that finds it held breaks nothing and returns to its
 * wait, because another taker is already breaking the lock. Its target is the guard path, not the
 * locked target, because proper-lockfile keys its held locks by target and a second lock on that
 * target would replace this process's entry for it and break that lock's heartbeat and release.
 *
 * proper-lockfile's own stale removal does not take the guard. Once the lock directory's mtime is
 * near `staleMs`, another process may remove it as stale and create its own between our re-check
 * and our rename, so that lock is left to the stale path, which frees it within the margin.
 */
export async function takeOverDeadHolder(
  cacheDir: string,
  staleMs: number | undefined,
  held: HeldLock = STORE_LOCK,
): Promise<boolean> {
  if (!(await holderIsProvablyDead(cacheDir, held))) return false
  const { lock } = await loadLockfile()
  const guard = join(cacheDir, held.guard)
  let release: () => Promise<void>
  try {
    release = await lock(guard, {
      lockfilePath: guard,
      realpath: false,
      stale: 30_000,
      retries: 0,
      onCompromised: () => undefined,
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') return false
    throw error
  }
  try {
    // Re-read under the guard: a taker before us may already have broken the lock and re-acquired.
    const dead = await holderIsProvablyDead(cacheDir, held)
    if (!dead) return false
    const lockDirectory = join(cacheDir, held.directory)
    const { mtimeMs } = await lstat(lockDirectory)
    const stale = staleWindow(staleMs)
    if (Date.now() - mtimeMs >= stale - Math.min(STALE_MARGIN_MS, stale / 3)) return false
    const tombstone = `${lockDirectory}${TOMBSTONE_INFIX}${randomUUID()}`
    try {
      await rename(lockDirectory, tombstone)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    // The lock is free once renamed. A tombstone left by a taker killed here is swept by the next.
    for (const entry of await readdir(cacheDir).catch(() => [])) {
      if (entry.startsWith(`${held.directory}${TOMBSTONE_INFIX}`)) {
        await rmdir(join(cacheDir, entry)).catch(() => undefined)
      }
    }
    process.emitWarning(
      `took over the ${held.noun} of a dead holder, ${describeHolder(dead.holder)}: ${dead.reason}`,
      { type: 'AgentKnowledgeRecovery', code: 'AGENT_KNOWLEDGE_LOCK_TAKEOVER' },
    )
    return true
  } finally {
    await release().catch(() => undefined)
  }
}
