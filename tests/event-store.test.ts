import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as durable from '../src/durable-fs'
import { sha256 } from '../src/ids'
import { FileSystemKbStore, MemoryKbStore } from '../src/kb-store'
import type { KnowledgeEvent } from '../src/types'

const roots: string[] = []
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'events-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const event = (id: string, createdAt: string, target = 'a'): KnowledgeEvent => ({
  id,
  createdAt,
  target,
  type: 'index.built',
})
const log = '.agent-knowledge/event-log'

describe('segmented event store', () => {
  it('keeps id replacement, timestamp ordering, filters and limits consistent across stores', async () => {
    for (const store of [new MemoryKbStore(), new FileSystemKbStore({ root: await root() })]) {
      await store.putEvent(event('one', 'z'))
      await store.putEvent(event('two', 'a', 'b'))
      await store.putEvent(event('three', 'z'))
      await store.putEvent(event('one', 'z', 'b'))
      expect(await store.listEvents()).toEqual([
        event('two', 'a', 'b'),
        event('three', 'z'),
        event('one', 'z', 'b'),
      ])
      expect(await store.listEvents({ target: 'b', limit: 1 })).toEqual([event('one', 'z', 'b')])
    }
  })
  it('writes a new segment without changing old payload bytes and reads only selected payloads', async () => {
    const path = await root()
    const store = new FileSystemKbStore({ root: path })
    await store.putEvent(event('one', 'a'))
    const records = join(path, log, 'records')
    const [old] = await readdir(records)
    const bytes = await readFile(join(records, old!))
    await store.putEvent(event('two', 'b'))
    expect(await readFile(join(records, old!))).toEqual(bytes)
    // An unselected payload is never parsed for a tail query; a full read still detects corruption.
    await writeFile(join(records, old!), 'corrupt')
    expect(await store.listEvents({ limit: 1 })).toEqual([event('two', 'b')])
    await expect(store.listEvents()).rejects.toThrow()
  })
  it('migrates legacy arrays once in both published constructor layouts', async () => {
    for (const direct of [false, true]) {
      const path = await root()
      const legacy = join(path, direct ? 'events.json' : '.agent-knowledge/events.json')
      await mkdir(join(path, '.agent-knowledge'), { recursive: true })
      await writeFile(legacy, JSON.stringify([event('one', 'a')]))
      const store = direct ? new FileSystemKbStore(path) : new FileSystemKbStore({ root: path })
      expect(await store.listEvents()).toEqual([event('one', 'a')])
      await store.putEvent(event('two', 'b'))
      expect(await store.listEvents()).toEqual([event('one', 'a'), event('two', 'b')])
      await expect(readFile(legacy)).rejects.toMatchObject({ code: 'ENOENT' })
      // An older writer cannot silently fork the authoritative log after migration.
      await writeFile(legacy, '[]')
      await expect(store.listEvents()).rejects.toThrow(/legacy/)
    }
  })
  it('serializes different instances without losing events', async () => {
    const path = await root()
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        new FileSystemKbStore({ root: path }).putEvent(
          event(String(i), String(i).padStart(2, '0')),
        ),
      ),
    )
    expect(await new FileSystemKbStore({ root: path }).listEvents()).toHaveLength(12)
  })
})

it('preserves replacement ordering even for an identical value at a tied timestamp', async () => {
  for (const store of [new MemoryKbStore(), new FileSystemKbStore({ root: await root() })]) {
    await store.putEvent(event('one', 'z'))
    await store.putEvent(event('two', 'z'))
    await store.putEvent(event('one', 'z'))
    expect(await store.listEvents()).toEqual([event('two', 'z'), event('one', 'z')])
  }
})

it('keeps direct and root layouts separate while canonical directory aliases share a log', async () => {
  const path = await root()
  const direct = new FileSystemKbStore(path)
  const canonical = new FileSystemKbStore({ root: path })
  const alias = new FileSystemKbStore(join(path, '.agent-knowledge'))
  await direct.putEvent(event('direct', 'a'))
  await canonical.putEvent(event('canonical', 'b'))
  expect(await direct.listEvents()).toEqual([event('direct', 'a')])
  expect(await alias.listEvents()).toEqual([event('canonical', 'b')])
  await alias.putEvent(event('alias', 'c'))
  expect(await canonical.listEvents()).toEqual([event('canonical', 'b'), event('alias', 'c')])
})

it('refuses an orphaned log instead of resetting its sequence', async () => {
  const path = await root()
  const store = new FileSystemKbStore({ root: path })
  await store.putEvent(event('one', 'a'))
  await rm(join(path, log, 'state.json'))
  await expect(store.listEvents()).rejects.toThrow(/state is missing/)
  await expect(store.putEvent(event('two', 'b'))).rejects.toThrow(/state is missing/)
})

it('recovers an interrupted event transaction on retry without duplicating the event', async () => {
  const path = await root()
  const store = new FileSystemKbStore({ root: path })
  await mkdir(join(path, '.agent-knowledge'), { recursive: true })
  await writeFile(
    join(path, '.agent-knowledge/events.json'),
    JSON.stringify([event('before', '0')]),
  )
  const value = event('crash', 'a')
  const write = durable.writeFileDurable
  let failed = false
  const spy = vi
    .spyOn(durable, 'writeFileDurable')
    .mockImplementation(async (target, data, options) => {
      if (!failed && target.endsWith(`/${sha256(value.id).slice(0, 2)}.json`)) {
        failed = true
        throw new Error('simulated crash before index commit')
      }
      return write(target, data, options)
    })
  try {
    await expect(store.putEvent(value)).rejects.toThrow(/simulated crash/)
  } finally {
    spy.mockRestore()
  }
  expect(failed).toBe(true)
  await store.putEvent(value)
  expect(await store.listEvents()).toEqual([event('before', '0'), value])
})

it('refuses symlinked event storage and leaves the outside directory unchanged', async () => {
  const path = await root()
  const outside = await root()
  await mkdir(join(path, '.agent-knowledge'), { recursive: true })
  await symlink(outside, join(path, log))
  const store = new FileSystemKbStore({ root: path })
  await expect(store.putEvent(event('one', 'a'))).rejects.toThrow()
  await expect(store.listEvents()).rejects.toThrow()
  expect(await readdir(outside)).toEqual([])
})

it('exports the visible event history into a fresh legacy root for a quiesced downgrade', async () => {
  const path = await root()
  const fresh = await root()
  const store = new FileSystemKbStore({ root: path })
  await store.putEvent(event('one', 'a'))
  await store.putEvent(event('two', 'b'))
  await store.putEvent(event('one', 'c'))
  const events = await store.listEvents()
  await durable.writeJsonDurableWithinRoot(fresh, '.agent-knowledge/events.json', events)
  const legacy = JSON.parse(await readFile(join(fresh, '.agent-knowledge/events.json'), 'utf8'))
  expect(legacy).toEqual([event('two', 'b'), event('one', 'c')])
  expect(await new FileSystemKbStore({ root: fresh }).listEvents()).toEqual(events)
  expect(await store.listEvents()).toEqual(events)
})

it('splits only overflowing hash buckets and preserves replacement and tail queries', async () => {
  const path = await root()
  const values: KnowledgeEvent[] = []
  for (let i = 0; values.length < 257; i++) {
    if (sha256(String(i)).startsWith('aa'))
      values.push(event(String(i), String(values.length).padStart(4, '0')))
  }
  await mkdir(join(path, '.agent-knowledge'), { recursive: true })
  await writeFile(join(path, '.agent-knowledge/events.json'), JSON.stringify(values.slice(0, 256)))
  const store = new FileSystemKbStore({ root: path })
  await store.putEvent(values[256]!)
  const index = join(path, log, 'index')
  expect(JSON.parse(await readFile(join(index, 'aa.json'), 'utf8'))).toEqual({ kind: 'branch' })
  for (const name of await readdir(index)) {
    const bucket = JSON.parse(await readFile(join(index, name), 'utf8'))
    if (bucket.kind === 'leaf') expect(bucket.entries.length).toBeLessThanOrEqual(256)
  }
  expect(await store.listEvents({ limit: 2 })).toEqual(values.slice(-2))
  await store.putEvent({ ...values[0]!, createdAt: 'zz' })
  expect(await store.listEvents()).toHaveLength(257)
  expect(await store.listEvents({ limit: 1 })).toEqual([{ ...values[0]!, createdAt: 'zz' }])
})

it('refuses a lost metadata bucket instead of silently dropping its events', async () => {
  const path = await root()
  const store = new FileSystemKbStore({ root: path })
  await store.putEvent(event('one', 'a'))
  await rm(join(path, log, 'index', `${sha256('one').slice(0, 2)}.json`))
  await expect(store.listEvents()).rejects.toThrow(/count mismatch/)
})
