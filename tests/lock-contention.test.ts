import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ToolDefinition } from '@tangle-network/agent-interface'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createKnowledgeTools } from '../src/knowledge-tools'
import { withKnowledgeMutation, withKnowledgeRead } from '../src/mutation-lock'
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

/** Another OS process that holds the store around each of its writes for `holdMs`. */
function otherProcess(
  pages: string[],
  holdMs: number,
): { child: ChildProcess; holding: Promise<void>; done: Promise<void> } {
  const child = spawn(
    process.execPath,
    [
      '--experimental-transform-types',
      '--no-warnings',
      PROCESS,
      SOURCE,
      JSON.stringify({ root: dir, runId: 'run', actorId: 'other-process', pages, holdMs }),
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
  return { child, holding, done }
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
    const other = otherProcess(['other-1.md', 'other-2.md'], 4_000)
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
    const other = otherProcess(['held.md'], 4_000)
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
