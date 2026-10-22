import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { type FileHandle, lstat, open, readFile, readlink, rename, rmdir } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { writeJsonDurableWithinRoot } from './durable-fs'

/** The store's cross-process lock directory, beside its owner record inside the cache directory. */
export const STORE_LOCK_DIRECTORY = 'mutation.lock.durable'

/** Record of the current cross-process holder: names it in a timeout and proves it dead. */
export const LOCK_OWNER_FILE = 'mutation.lock.owner.json'

/** Held only while one taker breaks a dead holder's lock, so two takers never both break it. */
const TAKEOVER_GUARD = 'mutation.lock.takeover'

/**
 * Identity of one lock directory, as decimal strings from `lstat(..., { bigint: true })`. ext4
 * hands a removed directory's inode to the next one at once (measured 1.4 ms apart on
 * drew-gtr-pro), so dev and ino alone can match a stale record to a live holder's new directory;
 * the nanosecond birthtime tells them apart.
 */
export interface LockDirectoryIdentity {
  dev: string
  ino: string
  birthtimeNs: string
}

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
  lock?: LockDirectoryIdentity
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

/**
 * The OS start token of a live pid, the way agent-runtime's `readProcessStart` reads it: the same
 * for a process's whole life and different for every later holder of its pid. `undefined` when
 * the host cannot report one. `node:child_process` loads lazily because the package root, which
 * Cloudflare consumers bundle, imports this module.
 */
async function readProcessStart(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || process.platform === 'win32') return undefined
  if (process.platform === 'linux') {
    let stat: string
    try {
      stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    } catch {
      return undefined
    }
    // The comm field is parenthesized and may hold spaces, so fields are counted after its close.
    const startTime = stat
      .slice(stat.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/u)[19]
    return startTime !== undefined && /^\d+$/u.test(startTime) ? startTime : undefined
  }
  try {
    const { execFile } = await import('node:child_process')
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile('ps', ['-o', 'lstart=', '-p', String(pid)], (error, out) =>
        error ? reject(error) : resolve(out),
      ),
    )
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

interface ProcessIdentity {
  processStart?: string
  bootId?: string
  pidNamespace?: string
}

let ownIdentity: Promise<ProcessIdentity> | undefined

function readOwnIdentity(): Promise<ProcessIdentity> {
  ownIdentity ??= (async () => {
    const [processStart, bootId, pidNamespace] = await Promise.all([
      readProcessStart(process.pid),
      readFile('/proc/sys/kernel/random/boot_id', 'utf8').then(
        (text) => text.trim() || undefined,
        () => undefined,
      ),
      readlink('/proc/self/ns/pid').catch(() => undefined),
    ])
    return {
      ...(processStart ? { processStart } : {}),
      ...(bootId ? { bootId } : {}),
      ...(pidNamespace ? { pidNamespace } : {}),
    }
  })()
  return ownIdentity
}

async function readLockDirectoryIdentity(
  cacheDir: string,
): Promise<LockDirectoryIdentity | undefined> {
  try {
    const entry = await lstat(join(cacheDir, STORE_LOCK_DIRECTORY), { bigint: true })
    if (!entry.isDirectory()) return undefined
    return {
      dev: entry.dev.toString(),
      ino: entry.ino.toString(),
      birthtimeNs: entry.birthtimeNs.toString(),
    }
  } catch {
    return undefined
  }
}

/**
 * Record who holds the file lock, and which lock directory, inside the store's confinement. Call
 * it right after acquiring. Exported for the confinement tests; src/index.ts does not re-export it.
 */
export async function recordLockOwner(cacheDir: string, label: string): Promise<void> {
  try {
    const [identity, lock] = await Promise.all([
      readOwnIdentity(),
      readLockDirectoryIdentity(cacheDir),
    ])
    const owner: LockHolder = {
      label,
      pid: process.pid,
      host: hostname(),
      since: Date.now(),
      ...identity,
      ...(lock ? { lock } : {}),
    }
    await writeJsonDurableWithinRoot(cacheDir, LOCK_OWNER_FILE, owner)
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
export async function readLockOwner(cacheDir: string): Promise<LockHolder | undefined> {
  let handle: FileHandle | undefined
  try {
    handle = await open(
      join(cacheDir, LOCK_OWNER_FILE),
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
  lock: LockDirectoryIdentity
  reason: 'pid gone' | 'pid reused' | 'host rebooted'
}

/** Only ESRCH proves a pid gone; EPERM means it exists under another user. */
function pidIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/**
 * The holder of the current store lock, when its record proves it dead; otherwise `undefined`,
 * and the caller keeps the `staleMs` lease. Proof needs a record with every identity field,
 * written for this very lock directory (dev, ino and a nonzero birthtime), on this host and pid
 * namespace, and then a rebooted host, a gone pid, or a pid whose start token changed. Anything
 * else is unknown, so a live holder's lease is never shortened.
 */
export async function holderIsProvablyDead(cacheDir: string): Promise<DeadHolder | undefined> {
  const holder = await readLockOwner(cacheDir)
  if (!holder?.processStart || !holder.lock || holder.pid <= 0) return undefined
  const lock = await readLockDirectoryIdentity(cacheDir)
  if (
    !lock ||
    lock.birthtimeNs === '0' ||
    lock.dev !== holder.lock.dev ||
    lock.ino !== holder.lock.ino ||
    lock.birthtimeNs !== holder.lock.birthtimeNs ||
    holder.host !== hostname()
  ) {
    return undefined
  }
  const own = await readOwnIdentity()
  if (holder.pidNamespace !== own.pidNamespace) return undefined
  if ((holder.bootId === undefined) !== (own.bootId === undefined)) return undefined
  if (holder.bootId !== own.bootId) return { holder, lock, reason: 'host rebooted' }
  if (pidIsGone(holder.pid)) return { holder, lock, reason: 'pid gone' }
  const start = await readProcessStart(holder.pid)
  if (start !== undefined && start !== holder.processStart) {
    return { holder, lock, reason: 'pid reused' }
  }
  return undefined
}

/**
 * Break the store lock of a provably dead holder, and report whether this call broke it. The
 * guard is proper-lockfile itself: a taker that finds it held breaks nothing and returns to its
 * wait, because another taker is already breaking the lock. Its target is the guard path, not the
 * store root, because proper-lockfile keys its held locks by target and a second lock on the root
 * would replace this process's store-lock entry and break that lock's heartbeat and release.
 */
export async function takeOverDeadHolder(cacheDir: string): Promise<boolean> {
  if (!(await holderIsProvablyDead(cacheDir))) return false
  const { lock } = await loadLockfile()
  const guard = join(cacheDir, TAKEOVER_GUARD)
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
    const dead = await holderIsProvablyDead(cacheDir)
    if (!dead) return false
    const tombstone = join(cacheDir, `${STORE_LOCK_DIRECTORY}.dead-${randomUUID()}`)
    try {
      await rename(join(cacheDir, STORE_LOCK_DIRECTORY), tombstone)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    await rmdir(tombstone)
    process.emitWarning(
      `took over the knowledge store lock of a dead holder, ${describeHolder(dead.holder)}: ${dead.reason}`,
      { type: 'AgentKnowledgeRecovery', code: 'AGENT_KNOWLEDGE_LOCK_TAKEOVER' },
    )
    return true
  } finally {
    await release().catch(() => undefined)
  }
}
