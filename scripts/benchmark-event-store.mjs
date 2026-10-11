// Repeatable local microbenchmark; fixtures bypass ingestion so only append/query are timed.
// Three repetitions per cell; output is JSONL, latency is milliseconds. Not a production SLO.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { FileSystemKbStore as Current } from '../dist/index.js'
if (!process.argv[2])
  throw new Error(
    'Usage: node scripts/benchmark-event-store.mjs <previous-dist/index.js> [100,1000,10000]',
  )
const { FileSystemKbStore: Previous } = await import(pathToFileURL(resolve(process.argv[2])).href)
const hash = (x) => createHash('sha256').update(x).digest('hex')
const json = (x) => JSON.stringify(x) + '\n'
const results = []
const metadata = (payloadBytes) =>
  payloadBytes === 'research'
    ? {
        goal: 'Understand refund eligibility and escalation policy for customer support',
        iteration: 42,
        done: false,
        addedSourceCount: 3,
        written: ['knowledge/refunds.md', 'knowledge/escalation.md', 'knowledge/exceptions.md'],
        warningCount: 0,
        errorCount: 0,
      }
    : { text: 'x'.repeat(payloadBytes) }
for (const count of (process.argv[3] ?? '100,1000,10000').split(',').map(Number))
  for (const payloadBytes of [32, 'research', 8192]) {
    const paths = []
    const row = { count, payloadBytes }
    for (const [name, Store] of [
      ['previous', Previous],
      ['segmented', Current],
    ]) {
      const root = await mkdtemp(join(tmpdir(), 'event-bench-'))
      paths.push(root)
      const dir = join(root, '.agent-knowledge')
      await mkdir(dir, { recursive: true })
      const events = Array.from({ length: count }, (_, i) => ({
        id: String(i),
        type: payloadBytes === 'research' ? 'research.iteration' : 'index.built',
        createdAt: new Date(1700000000000 + i).toISOString(),
        target: i % 2 ? 'b' : 'a',
        metadata: metadata(payloadBytes),
      }))
      const legacy = JSON.stringify(events, null, 2) + '\n'
      let indexBytes = 0
      if (name === 'previous') await writeFile(join(dir, 'events.json'), legacy)
      else {
        const log = join(dir, 'event-log')
        await mkdir(join(log, 'records'), { recursive: true })
        await mkdir(join(log, 'index'), { recursive: true })
        const buckets = new Map()
        for (let start = 0; start < count; start += 32)
          await Promise.all(
            events.slice(start, start + 32).map(async (e, j) => {
              const content = json(e),
                digest = hash(content)
              const entry = {
                id: e.id,
                createdAt: e.createdAt,
                type: e.type,
                target: e.target,
                sequence: start + j + 1,
                digest,
              }
              const prefix = hash(e.id).slice(0, 2)
              const group = buckets.get(prefix) ?? []
              group.push(entry)
              buckets.set(prefix, group)
              await writeFile(join(log, 'records', digest + '.json'), content)
            }),
          )
        for (const [prefix, entries] of buckets) {
          if (entries.length > 256)
            throw new Error('fixture needs a split; use at most 10000 events')
          const content = json({ kind: 'leaf', entries })
          indexBytes += Buffer.byteLength(content)
          await writeFile(join(log, 'index', prefix + '.json'), content)
        }
        await writeFile(join(log, 'state.json'), json({ version: 1, sequence: count, count }))
      }
      const store = new Store({ root })
      const append = [],
        tail = []
      for (let i = 0; i < 3; i++) {
        const e = {
          id: 'new' + i,
          type: payloadBytes === 'research' ? 'research.iteration' : 'index.built',
          createdAt: new Date(1700000000000 + count + i).toISOString(),
          target: 'a',
          metadata: metadata(payloadBytes),
        }
        let t = performance.now()
        await store.putEvent(e)
        append.push(performance.now() - t)
        t = performance.now()
        const selected = await store.listEvents({ target: 'a', limit: 5 })
        tail.push(performance.now() - t)
        if (selected.length !== 5) throw Error('wrong count')
      }
      const median = (x) => x.sort((a, b) => a - b)[1]
      row[name] = {
        appendMedianMs: median(append),
        filteredTailMedianMs: median(tail),
        initialPayloadBytes: Buffer.byteLength(legacy),
        indexBytes,
      }
    }
    results.push(row)
    console.log(JSON.stringify(row))
    await Promise.all(paths.map((p) => rm(p, { recursive: true, force: true })))
  }
