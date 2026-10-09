/** Durable immutable event payloads with bounded, hash-partitioned metadata buckets. */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  isMissingFile,
  listRegularFilesWithinRoot,
  readRegularFileWithinRoot,
  withSafeDescendant,
  withSafeDirectory,
} from './durable-fs'
import type { KnowledgeEventQuery } from './events'
import { commitKnowledgeFileMutations, type KnowledgeFileMutation } from './file-transaction'
import { sha256 } from './ids'
import { withKnowledgeMutation, withKnowledgeRead } from './mutation-lock'
import { KnowledgeEventSchema } from './schemas'
import type { KnowledgeEvent } from './types'

const stateSchema = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().nonnegative().safe(),
    count: z.number().int().nonnegative().safe(),
  })
  .strict()
const entrySchema = z
  .object({
    id: z.string().min(1),
    createdAt: z.string().min(1),
    type: KnowledgeEventSchema.shape.type,
    target: z.string().optional(),
    sequence: z.number().int().nonnegative().safe(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
type Entry = z.infer<typeof entrySchema>
const MAX_BUCKET_ENTRIES = 256
const bucketSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('branch') }).strict(),
  z
    .object({ kind: z.literal('leaf'), entries: z.array(entrySchema).max(MAX_BUCKET_ENTRIES) })
    .strict(),
])
type Bucket = z.infer<typeof bucketSchema>
const encode = (value: unknown) => `${JSON.stringify(value)}\n`
const recordPath = (directory: string, digest: string) => `${directory}/records/${digest}.json`
const bucketPath = (directory: string, prefix: string) => `${directory}/index/${prefix}.json`

async function readOptional(root: string, path: string): Promise<Buffer | undefined> {
  try {
    return (await readRegularFileWithinRoot(root, path)).bytes
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
}
async function assertNoLegacy(root: string, path: string) {
  // Metadata only: never parse the old history on a migrated store's hot path.
  const exists = await withSafeDescendant(root, path, async (target) => {
    try {
      await lstat(target)
      return true
    } catch (error) {
      if (isMissingFile(error)) return false
      throw error
    }
  })
  if (exists)
    throw new Error(
      'legacy event history reappeared after migration; reconcile the older writer before proceeding',
    )
}
function ordered(entries: Entry[]): Entry[] {
  return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sequence - b.sequence)
}

export async function putStoredEvent(
  root: string,
  legacyPath: string,
  event: KnowledgeEvent,
): Promise<void> {
  const directory = legacyPath === 'events.json' ? 'event-log' : '.agent-knowledge/event-log'
  const statePath = `${directory}/state.json`
  const parsed = KnowledgeEventSchema.parse(structuredClone(event))
  const purpose = `event-put:${sha256(encode({ legacyPath, event: parsed }))}`
  await withKnowledgeMutation(
    root,
    async (lock) => {
      const saved = await readOptional(root, statePath)
      let sequence = 0
      let count = 0
      const mutations = new Map<string, KnowledgeFileMutation>()
      const add = (path: string, content: string | null) => mutations.set(path, { path, content })
      const bucketCache = new Map<string, Bucket>()
      const writeBucket = (prefix: string, entries: Entry[]) => {
        const writeTree = (prefix: string, entries: Entry[]): void => {
          if (entries.length <= MAX_BUCKET_ENTRIES) {
            const bucket: Bucket = {
              kind: 'leaf',
              entries: entries.sort((a, b) => a.id.localeCompare(b.id)),
            }
            bucketCache.set(prefix, bucket)
            add(bucketPath(directory, prefix), encode(bucket))
            return
          }
          if (prefix.length >= 64) throw new Error('event id hash collision')
          const branch: Bucket = { kind: 'branch' }
          bucketCache.set(prefix, branch)
          add(bucketPath(directory, prefix), encode(branch))
          const groups = new Map<string, Entry[]>()
          for (const entry of entries) {
            const child = sha256(entry.id).slice(0, prefix.length + 1)
            const group = groups.get(child) ?? []
            group.push(entry)
            groups.set(child, group)
          }
          for (const [child, group] of groups) writeTree(child, group)
        }
        writeTree(prefix, entries)
      }
      const putIndexEntry = async (entry: Entry) => {
        const idHash = sha256(entry.id)
        for (let length = 2; length <= 64; length++) {
          const prefix = idHash.slice(0, length)
          let bucket = bucketCache.get(prefix)
          if (!bucket) {
            const bytes = await readOptional(root, bucketPath(directory, prefix))
            bucket = bytes ? parseBucket(prefix, bytes, sequence) : { kind: 'leaf', entries: [] }
            bucketCache.set(prefix, bucket)
          }
          if (bucket.kind === 'branch') continue
          if (!bucket.entries.some((value) => value.id === entry.id)) count += 1
          writeBucket(prefix, [...bucket.entries.filter((value) => value.id !== entry.id), entry])
          return
        }
        throw new Error('event index has an invalid terminal branch')
      }
      const append = async (value: KnowledgeEvent) => {
        if (sequence >= Number.MAX_SAFE_INTEGER) throw new Error('event sequence exhausted')
        sequence += 1
        const content = encode(value)
        const digest = sha256(content)
        add(recordPath(directory, digest), content)
        await putIndexEntry({
          id: value.id,
          createdAt: value.createdAt,
          type: value.type,
          ...(value.target === undefined ? {} : { target: value.target }),
          sequence,
          digest,
        })
      }
      if (saved) {
        const state = stateSchema.parse(JSON.parse(saved.toString('utf8')))
        sequence = state.sequence
        count = state.count
        await assertNoLegacy(root, legacyPath)
      } else {
        await assertEmptyLog(root, directory)
        const legacy = await readOptional(root, legacyPath)
        if (legacy) {
          const events = z.array(KnowledgeEventSchema).parse(JSON.parse(legacy.toString('utf8')))
          for (const value of events) await append(value)
          add(legacyPath, null)
        }
      }
      await append(parsed)
      add(statePath, encode({ version: 1, sequence, count }))
      await commitKnowledgeFileMutations({
        root,
        transactionRoot: lock.transactionRoot,
        purpose,
        researchState: true,
        mutations: [...mutations.values()],
        assertOwned: lock.assertOwned,
      })
    },
    { resumeTransaction: { purpose } },
  )
}

export async function listStoredEvents(
  root: string,
  legacyPath: string,
  query: KnowledgeEventQuery,
): Promise<KnowledgeEvent[]> {
  const directory = legacyPath === 'events.json' ? 'event-log' : '.agent-knowledge/event-log'
  const statePath = `${directory}/state.json`
  return withKnowledgeRead(root, async () => {
    const saved = await readOptional(root, statePath)
    if (!saved) {
      await assertEmptyLog(root, directory)
      const bytes = await readOptional(root, legacyPath)
      let events = bytes
        ? z.array(KnowledgeEventSchema).parse(JSON.parse(bytes.toString('utf8')))
        : []
      if (query.type) events = events.filter((event) => event.type === query.type)
      if (query.target) events = events.filter((event) => event.target === query.target)
      return events.slice(-(query.limit ?? events.length))
    }
    const state = stateSchema.parse(JSON.parse(saved.toString('utf8')))
    await assertNoLegacy(root, legacyPath)
    const entries: Entry[] = []
    const buckets = new Map<string, Bucket>()
    for (const file of await readEventIndex(root, `${directory}/index`)) {
      const prefix = file.path.slice(`${directory}/index/`.length, -'.json'.length)
      buckets.set(prefix, parseBucket(prefix, file.bytes, state.sequence))
    }
    let count = 0
    for (const [prefix, bucket] of buckets) {
      for (let length = 2; length < prefix.length; length++) {
        if (buckets.get(prefix.slice(0, length))?.kind !== 'branch')
          throw new Error('event index has an orphaned bucket')
      }
      if (bucket.kind === 'branch') {
        if (
          ![...buckets.keys()].some(
            (child) => child.length === prefix.length + 1 && child.startsWith(prefix),
          )
        )
          throw new Error('event index branch has no children')
        continue
      }
      count += bucket.entries.length
      for (const entry of bucket.entries) {
        if (query.type && entry.type !== query.type) continue
        if (query.target && entry.target !== query.target) continue
        entries.push(entry)
      }
    }
    if (count !== state.count) throw new Error('event index entry count mismatch')
    const selected = ordered(entries).slice(-(query.limit ?? entries.length))
    return Promise.all(
      selected.map(async (entry) => {
        const bytes = (await readRegularFileWithinRoot(root, recordPath(directory, entry.digest)))
          .bytes
        if (createHash('sha256').update(bytes).digest('hex') !== entry.digest)
          throw new Error('event payload digest mismatch')
        const event = KnowledgeEventSchema.parse(JSON.parse(bytes.toString('utf8')))
        if (
          event.id !== entry.id ||
          event.createdAt !== entry.createdAt ||
          event.type !== entry.type ||
          event.target !== entry.target
        )
          throw new Error('event payload index mismatch')
        return event
      }),
    )
  })
}

async function assertEmptyLog(root: string, directory: string) {
  try {
    if ((await listRegularFilesWithinRoot(root, directory)).length)
      throw new Error('event log state is missing; recover the log before proceeding')
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
}

async function readEventIndex(root: string, relativeDirectory: string) {
  return withSafeDirectory(root, relativeDirectory, false, async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    const files: Array<{ path: string; bytes: Buffer }> = []
    for (let start = 0; start < entries.length; start += 64) {
      // Tiny index records are read synchronously in bounded slices: queueing thousands of
      // open/stat/read/close round trips dominates their bytes. The parent remains descriptor-
      // anchored, each child is O_NOFOLLOW, and we yield between slices for other requests.
      if (start > 0) await new Promise<void>((resolve) => setImmediate(resolve))
      for (const entry of entries.slice(start, start + 64)) {
        if (!entry.isFile() || !/^[a-f0-9]{2,64}\.json$/.test(entry.name))
          throw new Error('event index contains an unsupported entry')
        const fd = openSync(
          join(directory, entry.name),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        )
        try {
          if (!fstatSync(fd).isFile()) throw new Error('event index contains an unsupported entry')
          files.push({ path: `${relativeDirectory}/${entry.name}`, bytes: readFileSync(fd) })
        } finally {
          closeSync(fd)
        }
      }
    }
    return files
  })
}

function parseBucket(prefix: string, bytes: Buffer, sequence: number): Bucket {
  const bucket = bucketSchema.parse(JSON.parse(bytes.toString('utf8')))
  if (bucket.kind === 'branch') {
    if (prefix.length >= 64) throw new Error('event index has an invalid terminal branch')
    return bucket
  }
  const ids = new Set<string>()
  for (const entry of bucket.entries) {
    if (!sha256(entry.id).startsWith(prefix) || entry.sequence > sequence || ids.has(entry.id))
      throw new Error('event index identity mismatch')
    ids.add(entry.id)
  }
  return bucket
}
