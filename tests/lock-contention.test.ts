import { type ChildProcess, spawn } from 'node:child_process'
import { lstat, mkdtemp, readdir, readFile, realpath, rm, rmdir, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { ToolDefinition } from '@tangle-network/agent-interface'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildKnowledgeIndex } from '../src/indexer'
import { createKnowledgeTools } from '../src/knowledge-tools'
import {
  inspectPendingKnowledgeMutation,
  withKnowledgeMutation,
  withKnowledgeRead,
} from '../src/mutation-lock'
import { createRunScopedStores, type RunScopedStores } from '../src/run-scoped'

const SOURCE = fileURLToPath(new URL('../src', import.meta.url))
const PROCESS = fileURLToPath(new URL('./support/knowledge-process.mjs', import.meta.url))

let dir: string
let stores: RunScopedStores

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'knowledge-lock-')))
  stores = createRunScopedStores({ root: dir })
  await stores.init('run')
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

const TAKEOVER = 'AGENT_KNOWLEDGE_LOCK_TAKEOVER'
const ROLLBACK = 'AGENT_KNOWLEDGE_TRANSACTION_ROLLBACK'

/** This process's warnings, as `[code, message]`, collected for the current test. */
let parentWarnings: Array<[string, string]>
const onWarning = (warning: Error & { code?: string }) => {
  parentWarnings.push([warning.code ?? '', warning.message])
}
beforeEach(() => {
  parentWarnings = []
  process.on('warning', onWarning)
})
afterEach(() => {
  process.off('warning', onWarning)
})

/** Messages of this process's warnings with `code`, once pending emitWarning ticks have run. */
async function warningsOf(code: string): Promise<string[]> {
  await nextTurn()
  return parentWarnings.filter(([emitted]) => emitted === code).map(([, message]) => message)
}

function toolsFor(actorId: string): Map<string, ToolDefinition> {
  return new Map(
    createKnowledgeTools({ stores, runId: 'run', retrieverVersion: 'test', actorId }).map(
      (tool) => [tool.name, tool],
    ),
  )
}

function call(tools: Map<string, ToolDefinition>, name: string, input: unknown): Promise<any> {
  return tools.get(name)!.handler(input) as Promise<any>
}

function page(path: string, body: string): string {
  return `---FILE: knowledge/${path}---\n# ${path}\n\n${body}\n---END FILE---\n`
}

interface OtherProcessConfig {
  pages?: string[]
  holdMs?: number
  actorId?: string
  transaction?: {
    purpose: string
    recoveryOwner?: string
    researchState?: boolean
    mutations: Array<{ path: string; content: string }>
  }
}

interface OtherProcess {
  child: ChildProcess
  holding: Promise<void>
  done: Promise<void>
  /** Codes of the `warning <code> <message>` lines it printed. */
  warnings(): string[]
  output(): string
}

/**
 * Another OS process on the store: it holds the store around each of its writes for `holdMs`, or
 * holds an open file transaction until it is killed (`tests/support/knowledge-process.mjs`).
 */
function otherProcess(config: OtherProcessConfig): OtherProcess {
  const child = spawn(
    process.execPath,
    [
      '--experimental-transform-types',
      '--no-warnings',
      PROCESS,
      SOURCE,
      JSON.stringify({ root: dir, runId: 'run', actorId: 'other-process', ...config }),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  let errors = ''
  child.stderr!.on('data', (chunk) => {
    errors += chunk
  })
  const holding = new Promise<void>((resolveHolding, reject) => {
    child.stdout!.on('data', (chunk) => {
      output += chunk
      if (output.includes('holding ')) resolveHolding()
    })
    child.on('exit', () => reject(new Error(`other process never held the store: ${errors}`)))
  })
  const done = new Promise<void>((resolveDone, reject) => {
    child.on('exit', (code) =>
      code === 0 && output.includes('done\n')
        ? resolveDone()
        : reject(new Error(`other process exited ${code}: ${errors}`)),
    )
  })
  // A killed process rejects both; a test that needs either awaits it.
  holding.catch(() => undefined)
  done.catch(() => undefined)
  return {
    child,
    holding,
    done,
    warnings: () => [...output.matchAll(/^warning (\S+) /gm)].map((match) => match[1]!),
    output: () => output,
  }
}

describe('agent-knowledge#251: a write that meets the store lock waits for it', () => {
  it('lands the root handoff queued behind a same-process worker write that holds the store past a minute', async () => {
    const worker = toolsFor('worker')
    const lead = toolsFor('root')

    // The worker's gaps.md write holds the store as one did on the archive disk: 92.6 s.
    let release!: () => void
    const released = new Promise<void>((resolveRelease) => {
      release = resolveRelease
    })
    let entered!: () => void
    const holding = new Promise<void>((resolveHolding) => {
      entered = resolveHolding
    })
    const workerWrite = withKnowledgeMutation(stores.storePath('run'), async () => {
      await call(worker, 'knowledge_record', { proposal: page('gaps.md', 'Open gaps.') })
      entered()
      await released
    })
    await holding

    const outcomes: string[] = []
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const rootWrite = call(lead, 'knowledge_record', {
      proposal:
        page('report.md', 'Final report.') + page('handoff.md', 'Next director: start here.'),
    }).then(
      () => outcomes.push('write landed'),
      (error: Error) => outcomes.push(`write failed: ${error.message}`),
    )
    const rootRead = withKnowledgeRead(stores.storePath('run'), () => 'read').then(
      () => outcomes.push('read returned'),
      (error: Error) => outcomes.push(`read failed: ${error.message}`),
    )
    // Past the 60 s same-process admission that failed the handoff, and the 2.5 s read budget.
    await vi.advanceTimersByTimeAsync(95_000)
    expect(outcomes).toEqual([])
    vi.useRealTimers()

    release()
    await workerWrite
    await Promise.all([rootWrite, rootRead])
    // Phase-fair: the waiting reader goes first when the write ends, then the queued writer.
    expect(outcomes).toEqual(['read returned', 'write landed'])
    for (const id of ['gaps', 'report', 'handoff']) {
      expect((await call(lead, 'knowledge_read', { pageId: id })).status).toBe('resolved')
    }
  })

  it('names the same-process holder when a writer cannot wait', async () => {
    let release!: () => void
    const released = new Promise<void>((resolveRelease) => {
      release = resolveRelease
    })
    let entered!: () => void
    const holding = new Promise<void>((resolveHolding) => {
      entered = resolveHolding
    })
    const worker = toolsFor('worker-7')
    const held = withKnowledgeMutation(stores.storePath('run'), async () => {
      await call(worker, 'knowledge_record', { proposal: page('gaps.md', 'Open gaps.') })
      entered()
      await released
    })
    await holding
    try {
      await expect(
        withKnowledgeMutation(stores.storePath('run'), () => undefined, { retries: 0 }),
      ).rejects.toThrow(
        /knowledge store is locked by this process: .*; waited 0 s behind a knowledge mutation \(pid \d+ on .+, holding since /,
      )
    } finally {
      release()
      await held
    }
  })
})

describe('two processes on one store', () => {
  it('lose no write and fail no read while the other process holds the store for seconds at a time', async () => {
    const lead = toolsFor('root')
    await call(lead, 'knowledge_record', { proposal: page('brief.md', 'The brief.') })
    // Each hold outlasts the 2.5 s a reader used to wait before failing.
    const other = otherProcess({ pages: ['other-1.md', 'other-2.md'], holdMs: 4_000 })
    await other.holding

    const failures: string[] = []
    let reads = 0
    let reading = true
    const reader = (async () => {
      while (reading) {
        try {
          const read = await call(lead, 'knowledge_read', { pageId: 'brief' })
          if (read.status !== 'resolved') failures.push(`read ${read.status}`)
          reads += 1
        } catch (error) {
          failures.push((error as Error).message)
        }
      }
    })()
    const writes = ['mine-1.md', 'mine-2.md', 'mine-3.md'].map((path) =>
      call(lead, 'knowledge_record', { proposal: page(path, 'Written by root.') }).catch(
        (error: Error) => failures.push(`write ${path}: ${error.message}`),
      ),
    )
    try {
      await Promise.all(writes)
      await other.done
    } finally {
      reading = false
      await reader
      other.child.kill()
    }

    expect(failures).toEqual([])
    expect(reads).toBeGreaterThan(0)
    for (const id of ['brief', 'other-1', 'other-2', 'mine-1', 'mine-2', 'mine-3']) {
      expect((await call(lead, 'knowledge_read', { pageId: id })).status).toBe('resolved')
    }
  }, 60_000)

  it("names the other process's holder when a writer or reader cannot wait", async () => {
    const other = otherProcess({ pages: ['held.md'], holdMs: 4_000 })
    try {
      await other.holding
      const holder =
        /slow write of held\.md by other-process \(pid \d+ on .+, holding since \S+, \d+ s\)/
      await expect(
        withKnowledgeMutation(stores.storePath('run'), () => undefined, { retries: 0 }),
      ).rejects.toThrow(
        new RegExp(
          `knowledge store is locked by another process: .*; waited .* for ${holder.source}`,
        ),
      )
      await expect(
        withKnowledgeRead(stores.storePath('run'), () => undefined, { retries: 0 }),
      ).rejects.toThrow(
        new RegExp(
          `knowledge read could not observe a stable mutation epoch: .* for ${holder.source}`,
        ),
      )
      await other.done
    } finally {
      other.child.kill()
    }
  }, 30_000)
})

const storeRoot = () => stores.storePath('run')
const lockDirectory = () => join(storeRoot(), '.agent-knowledge', 'mutation.lock.durable')
const ownerRecord = () => join(storeRoot(), '.agent-knowledge', 'mutation.lock.owner.json')

async function lockIdentity(): Promise<{ dev: string; ino: string; birthtimeNs: string }> {
  const entry = await lstat(lockDirectory(), { bigint: true })
  return {
    dev: entry.dev.toString(),
    ino: entry.ino.toString(),
    birthtimeNs: entry.birthtimeNs.toString(),
  }
}

async function snapshot(paths: readonly string[]): Promise<Record<string, string | null>> {
  const files: Record<string, string | null> = {}
  for (const path of paths) {
    files[path] = await readFile(join(storeRoot(), path), 'utf8').catch(() => null)
  }
  return files
}

/** Every regular file under the store root, for a "nothing changed" comparison. */
async function storeFiles(): Promise<Record<string, string>> {
  const entries = await readdir(storeRoot(), { recursive: true, withFileTypes: true })
  const files: Record<string, string> = {}
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    files[path] = await readFile(path, 'utf8')
  }
  return files
}

async function kill(other: OtherProcess, signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
  if (other.child.exitCode !== null || other.child.signalCode !== null) return
  const exited = new Promise((resolveExit) => other.child.once('exit', resolveExit))
  other.child.kill(signal)
  await exited
}

/** A child that holds the store for good, SIGKILLed while it holds: the lock directory stays. */
async function deadHolder(config: OtherProcessConfig = { pages: ['killed.md'], holdMs: 600_000 }) {
  const other = otherProcess(config)
  await other.holding
  await kill(other)
  return other
}

const lead = () => toolsFor('root')

describe('a dead writer is taken over; its unowned transaction rolls back', () => {
  const registry = `${JSON.stringify({ generatedAt: '2026-10-21T00:00:00.000Z', sources: [] }, null, 2)}\n`
  it.each([
    {
      purpose: 'knowledge-proposal:killed',
      mutations: [
        { path: 'knowledge/brief.md', content: '# brief\n\nRewritten by the killed writer.\n' },
        { path: 'knowledge/two.md', content: '# Two\n' },
      ],
    },
    {
      purpose: 'event-put:killed',
      researchState: true,
      mutations: [
        { path: '.agent-knowledge/event-log/index/ab.json', content: '{"kind":"leaf"}\n' },
        {
          path: '.agent-knowledge/event-log/state.json',
          content: '{"version":1,"sequence":1,"count":1}\n',
        },
      ],
    },
    {
      purpose: 'source-import:killed',
      mutations: [
        { path: 'raw/sources/killed.txt', content: 'killed source\n' },
        { path: '.agent-knowledge/sources.json', content: registry },
      ],
    },
    {
      purpose: 'knowledge-promotion:killed-run',
      mutations: [
        { path: 'knowledge/brief.md', content: '# brief\n\nPromoted by the killed writer.\n' },
        { path: 'knowledge/promoted.md', content: '# Promoted\n' },
      ],
    },
  ])(
    '$purpose: the next reader and writer succeed within 10 s',
    async (transaction) => {
      const tools = lead()
      await call(tools, 'knowledge_record', { proposal: page('brief.md', 'The brief.') })
      const touched = transaction.mutations.map((mutation) => mutation.path)
      const before = await snapshot(touched)
      await deadHolder({ transaction })
      expect((await inspectPendingKnowledgeMutation(storeRoot()))?.purpose).toBe(
        transaction.purpose,
      )

      const started = performance.now()
      expect((await call(tools, 'knowledge_read', { pageId: 'brief' })).status).toBe('resolved')
      expect(await snapshot(touched)).toEqual(before)
      await expect(inspectPendingKnowledgeMutation(storeRoot())).resolves.toBeNull()
      await call(tools, 'knowledge_record', { proposal: page('after.md', 'Written after.') })
      expect(performance.now() - started).toBeLessThan(10_000)

      expect((await call(tools, 'knowledge_read', { pageId: 'after' })).status).toBe('resolved')
      const takeovers = await warningsOf(TAKEOVER)
      expect(takeovers).toHaveLength(1)
      expect(takeovers[0]).toMatch(
        /killed write of .* by other-process \(pid \d+ on .*\): pid gone/,
      )
      expect(await warningsOf(ROLLBACK)).toHaveLength(1)
    },
    30_000,
  )

  it('keeps a transaction with a recovery owner and names how to resume it', async () => {
    const tools = lead()
    await call(tools, 'knowledge_record', { proposal: page('brief.md', 'The brief.') })
    const touched = ['knowledge/brief.md', 'knowledge/promoted.md']
    await deadHolder({
      transaction: {
        purpose: 'knowledge-promotion:killed-transition',
        recoveryOwner: 'knowledge-improvement-candidate-transition',
        mutations: [
          { path: touched[0]!, content: '# brief\n\nPromoted by the killed transition.\n' },
          { path: touched[1]!, content: '# Promoted\n' },
        ],
      },
    })
    const atKill = await snapshot(touched)
    const pending = await inspectPendingKnowledgeMutation(storeRoot())
    expect(pending?.recoveryOwner).toBe('knowledge-improvement-candidate-transition')

    const started = performance.now()
    const named = (message: string) => {
      expect(message).toContain('requires its owner to resume')
      expect(message).toContain("must be resumed by 'knowledge-improvement-candidate-transition'")
      expect(message).toContain(`transaction ${pending!.transactionId}`)
      expect(message).toContain(`created ${pending!.createdAt}`)
      expect(message).toContain('re-run promoteKnowledgeCandidate with the same candidate')
    }
    named(((await buildKnowledgeIndex(storeRoot()).catch((error) => error)) as Error).message)
    named(
      (
        (await call(tools, 'knowledge_record', {
          proposal: page('after.md', 'Refused.'),
        }).catch((error) => error)) as Error
      ).message,
    )
    expect(performance.now() - started).toBeLessThan(10_000)

    expect(await snapshot(touched)).toEqual(atKill)
    expect(await warningsOf(TAKEOVER)).toHaveLength(1)
    expect(await warningsOf(ROLLBACK)).toHaveLength(0)
  }, 30_000)

  it('takes over for a writer with explicit retries without spending them', async () => {
    const tools = lead()
    await deadHolder()
    await withKnowledgeMutation(
      storeRoot(),
      () => call(tools, 'knowledge_record', { proposal: page('retried.md', 'Landed.') }),
      { retries: 0 },
    )
    expect((await call(tools, 'knowledge_read', { pageId: 'retried' })).status).toBe('resolved')
    expect(await warningsOf(TAKEOVER)).toHaveLength(1)
  }, 30_000)

  it('takes over a pid that now names another process', async () => {
    await deadHolder()
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], {
      stdio: 'ignore',
    })
    try {
      const record = JSON.parse(await readFile(ownerRecord(), 'utf8'))
      await writeFile(ownerRecord(), JSON.stringify({ ...record, pid: sleeper.pid }))
      await expect(buildKnowledgeIndex(storeRoot())).resolves.toBeDefined()
      const takeovers = await warningsOf(TAKEOVER)
      expect(takeovers).toHaveLength(1)
      expect(takeovers[0]).toMatch(new RegExp(`pid ${sleeper.pid} .*: pid reused$`))
    } finally {
      sleeper.kill('SIGKILL')
    }
  }, 30_000)

  it('lets exactly one of two takers break the lock and roll the transaction back', async () => {
    await deadHolder({
      transaction: {
        purpose: 'event-put:two-takers',
        researchState: true,
        mutations: [
          { path: '.agent-knowledge/event-log/index/cd.json', content: '{"kind":"leaf"}\n' },
          {
            path: '.agent-knowledge/event-log/state.json',
            content: '{"version":1,"sequence":1,"count":1}\n',
          },
        ],
      },
    })
    const takers = [1, 2].map((n) =>
      otherProcess({ pages: [`taker-${n}.md`], holdMs: 0, actorId: `taker-${n}` }),
    )
    try {
      await Promise.all(takers.map((taker) => taker.done))
    } finally {
      for (const taker of takers) await kill(taker)
    }
    const lines = takers.flatMap((taker) => taker.warnings())
    expect(lines.filter((code) => code === TAKEOVER)).toHaveLength(1)
    expect(lines.filter((code) => code === ROLLBACK)).toHaveLength(1)
    const tools = lead()
    for (const id of ['taker-1', 'taker-2']) {
      expect((await call(tools, 'knowledge_read', { pageId: id })).status).toBe('resolved')
    }
    await expect(inspectPendingKnowledgeMutation(storeRoot())).resolves.toBeNull()
  }, 30_000)
})

describe('a live writer is never taken over', () => {
  it('fails a reader behind a stopped writer, then lands the writer after it resumes', async () => {
    const other = otherProcess({ pages: ['stopped.md'], holdMs: 2_000 })
    try {
      await other.holding
      other.child.kill('SIGSTOP')
      const files = await storeFiles()
      const identity = await lockIdentity()
      await expect(withKnowledgeRead(storeRoot(), () => undefined, { retries: 3 })).rejects.toThrow(
        new RegExp(`could not observe a stable mutation epoch: .*\\(pid ${other.child.pid} on `),
      )
      expect(await storeFiles()).toEqual(files)
      expect(await lockIdentity()).toEqual(identity)
      other.child.kill('SIGCONT')
      await other.done
    } finally {
      await kill(other)
    }
    expect((await call(lead(), 'knowledge_read', { pageId: 'stopped' })).status).toBe('resolved')
    expect(await warningsOf(TAKEOVER)).toHaveLength(0)
    expect(other.warnings()).not.toContain(TAKEOVER)
  }, 30_000)

  it('waits out a slow live writer and lands both writes', async () => {
    const other = otherProcess({ pages: ['slow.md'], holdMs: 5_000 })
    const tools = lead()
    try {
      await other.holding
      await call(tools, 'knowledge_record', { proposal: page('mine.md', 'Waited.') })
      await other.done
    } finally {
      await kill(other)
    }
    for (const id of ['slow', 'mine']) {
      expect((await call(tools, 'knowledge_read', { pageId: id })).status).toBe('resolved')
    }
    expect(await warningsOf(TAKEOVER)).toHaveLength(0)
  }, 30_000)
})

describe('a holder that cannot be proven dead keeps its lease', () => {
  async function expectLeaseKept(recorded: { label: string; pid: number }): Promise<void> {
    const identity = await lockIdentity()
    await expect(
      withKnowledgeMutation(storeRoot(), () => undefined, { retries: 0 }),
    ).rejects.toMatchObject({
      code: 'ELOCKED',
      message: expect.stringContaining(`${recorded.label} (pid ${recorded.pid} on `),
    })
    await expect(withKnowledgeRead(storeRoot(), () => undefined, { retries: 3 })).rejects.toThrow(
      /could not observe a stable mutation epoch/,
    )
    expect(await lockIdentity()).toEqual(identity)
    expect(await warningsOf(TAKEOVER)).toHaveLength(0)
  }

  const rewrite = async (change: (record: Record<string, any>) => Record<string, any>) => {
    const record = change(JSON.parse(await readFile(ownerRecord(), 'utf8')))
    await writeFile(ownerRecord(), JSON.stringify(record))
    return record as { label: string; pid: number }
  }

  it('(a) a record naming another host', async () => {
    await deadHolder()
    await expectLeaseKept(await rewrite((record) => ({ ...record, host: 'another-host' })))
  }, 30_000)

  it('(b) a record written for an earlier lock directory while a live writer holds', async () => {
    await deadHolder()
    const earlier = await readFile(ownerRecord(), 'utf8')
    // The dead holder's directory goes, as an expired lease removes it, and a live child takes
    // the lock; the record left on disk still describes the earlier directory.
    await rmdir(lockDirectory())
    const live = otherProcess({ pages: ['live.md'], holdMs: 600_000 })
    try {
      await live.holding
      await writeFile(ownerRecord(), earlier)
      await expectLeaseKept(JSON.parse(earlier))
    } finally {
      await kill(live)
    }
  }, 30_000)

  it('(c) a record whose lock directory has no birthtime', async () => {
    await deadHolder()
    await expectLeaseKept(
      await rewrite((record) => ({ ...record, lock: { ...record.lock, birthtimeNs: '0' } })),
    )
  }, 30_000)

  it('(d) an old-shape record naming a SIGKILLed pid', async () => {
    const dead = await deadHolder()
    await expectLeaseKept(
      await rewrite(({ label, since }) => ({
        label,
        pid: dead.child.pid,
        host: hostname(),
        since,
      })),
    )
  }, 30_000)
})
