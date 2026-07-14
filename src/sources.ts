import { lstat, readdir, readFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { z } from 'zod'
import { type SourceAdapter, textSourceAdapter } from './adapters'
import { readRegularFileWithinRoot, writeJsonDurableWithinRoot } from './durable-fs'
import { commitKnowledgeFileMutations, type KnowledgeFileMutation } from './file-transaction'
import { sha256, slugify, stableId } from './ids'
import { withKnowledgeMutation, withKnowledgeRead } from './mutation-lock'
import { SourceRecordSchema } from './schemas'
import { layoutFor } from './store'
import type { SourceRecord, SourceRegistry } from './types'

const sourceRegistrySchema = z
  .object({
    generatedAt: z.string().min(1),
    sources: z.array(SourceRecordSchema.passthrough()),
  })
  .strict()

export interface AddSourceOptions {
  copyIntoRaw?: boolean
  adapters?: SourceAdapter[]
  now?: () => Date
}

export interface AddSourceTextInput {
  uri: string
  text: string
  title?: string
  mediaType?: string
  validUntil?: string
  lastVerifiedAt?: string
  metadata?: Record<string, unknown>
}

export async function loadSourceRegistry(root: string): Promise<SourceRegistry> {
  return withKnowledgeRead(root, () => loadSourceRegistryUnlocked(root))
}

async function loadSourceRegistryUnlocked(root: string): Promise<SourceRegistry> {
  try {
    const file = await readRegularFileWithinRoot(root, '.agent-knowledge/sources.json')
    return sourceRegistrySchema.parse(JSON.parse(file.bytes.toString('utf8'))) as SourceRegistry
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return { generatedAt: new Date(0).toISOString(), sources: [] }
    }
    throw error
  }
}

export async function writeSourceRegistry(root: string, registry: SourceRegistry): Promise<void> {
  await withKnowledgeMutation(root, async () => {
    await writeJsonDurableWithinRoot(
      root,
      '.agent-knowledge/sources.json',
      sourceRegistrySchema.parse(registry),
    )
  })
}

export async function addSourcePath(
  root: string,
  sourcePath: string,
  options: AddSourceOptions = {},
): Promise<SourceRecord[]> {
  const sourceStat = await lstat(sourcePath)
  if (sourceStat.isDirectory()) {
    const files = await listSourceFiles(sourcePath)
    const prepared = await Promise.all(
      files.map((file) => preparePathSource(root, file.path, file.mode, options)),
    )
    return commitSourceBatch(root, prepared, options)
  }
  if (!sourceStat.isFile()) throw new Error(`unsupported source path: ${sourcePath}`)

  return commitSourceBatch(
    root,
    [await preparePathSource(root, sourcePath, sourceStat.mode & 0o777, options)],
    options,
  )
}

async function preparePathSource(
  root: string,
  sourcePath: string,
  mode: number,
  options: AddSourceOptions,
): Promise<PreparedSourceImport> {
  const bytes = await readFile(sourcePath)
  const contentHash = sha256(bytes.toString('base64'))
  const fileName = basename(sourcePath)
  const adapters = options.adapters ?? [textSourceAdapter]
  const adapter = adapters.find((candidate) => candidate.canLoad({ uri: sourcePath, bytes }))
  const loaded = adapter ? await adapter.load({ uri: sourcePath, bytes }) : {}
  const id = stableId('src', `${contentHash}:${fileName}`)
  const targetRel = rawSourcePath(fileName, contentHash, ext(fileName))
  const copyIntoRaw = options.copyIntoRaw ?? true

  return {
    record: {
      id,
      uri: copyIntoRaw ? targetRel : sourcePath,
      title: loaded.title ?? fileName,
      mediaType: loaded.mediaType ?? mediaTypeFor(fileName),
      contentHash,
      text: loaded.text ?? textPreview(fileName, bytes),
      anchors: (loaded.anchors ?? []).map((anchor) => ({ ...anchor, sourceId: id })),
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
      metadata: {
        ...(loaded.metadata ?? {}),
        originalPath: sourcePath,
        sizeBytes: bytes.length,
        projectRelativePath: relative(root, sourcePath).replace(/\\/g, '/'),
      },
    },
    mutation: copyIntoRaw ? { path: targetRel, content: bytes, mode } : null,
    purposeParts: [sourcePath, contentHash, copyIntoRaw, mode],
  }
}

export async function addSourceText(
  root: string,
  input: AddSourceTextInput,
  options: Pick<AddSourceOptions, 'adapters' | 'now'> = {},
): Promise<SourceRecord> {
  const [record] = await commitSourceBatch(root, [await prepareTextSource(input, options)], options)
  return record!
}

async function prepareTextSource(
  input: AddSourceTextInput,
  options: Pick<AddSourceOptions, 'adapters' | 'now'>,
): Promise<PreparedSourceImport> {
  const text = input.text
  const contentHash = sha256(text)
  const fileName = basename(input.uri) || `${slugify(input.title ?? input.uri)}.txt`
  const adapterInput = { uri: input.uri, text, metadata: input.metadata }
  const adapter = (options.adapters ?? [textSourceAdapter]).find((candidate) =>
    candidate.canLoad(adapterInput),
  )
  const loaded = adapter ? await adapter.load(adapterInput) : {}
  const id = stableId('src', `${contentHash}:${input.uri}`)
  const targetRel = rawSourcePath(fileName, contentHash, '.txt')
  const rawContent = text.endsWith('\n') ? text : `${text}\n`

  return {
    record: {
      id,
      uri: targetRel,
      title: input.title ?? loaded.title ?? fileName,
      mediaType: input.mediaType ?? loaded.mediaType ?? 'text/plain',
      contentHash,
      text: loaded.text ?? text.slice(0, 200_000),
      anchors: (loaded.anchors ?? []).map((anchor) => ({ ...anchor, sourceId: id })),
      ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
      ...(input.lastVerifiedAt === undefined ? {} : { lastVerifiedAt: input.lastVerifiedAt }),
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
      metadata: {
        ...(loaded.metadata ?? {}),
        ...(input.metadata ?? {}),
        originalUri: input.uri,
        sizeBytes: Buffer.byteLength(text, 'utf8'),
      },
    },
    mutation: { path: targetRel, content: rawContent },
    purposeParts: [input.uri, contentHash],
  }
}

interface PreparedSourceImport {
  record: SourceRecord
  mutation: KnowledgeFileMutation | null
  purposeParts: readonly unknown[]
}

async function commitSourceBatch(
  root: string,
  prepared: readonly PreparedSourceImport[],
  options: Pick<AddSourceOptions, 'now'>,
): Promise<SourceRecord[]> {
  if (prepared.length === 0) return []
  const purpose = `source-import:${sha256(JSON.stringify(prepared.map((item) => item.purposeParts)))}`
  return withKnowledgeMutation(
    root,
    async (lock) => {
      const existing = await loadSourceRegistry(root)
      const records = uniqueSources(prepared.map((item) => item.record))
      const next = sourceRegistrySchema.parse({
        generatedAt: (options.now ?? (() => new Date()))().toISOString(),
        sources: [
          ...records,
          ...existing.sources.filter(
            (source) => !records.some((record) => record.id === source.id),
          ),
        ],
      }) as SourceRegistry
      await commitKnowledgeFileMutations({
        root,
        transactionRoot: lock.transactionRoot,
        purpose,
        mutations: [
          ...uniqueMutations(prepared.flatMap((item) => (item.mutation ? [item.mutation] : []))),
          {
            path: relative(root, sourceRegistryPath(root)).replace(/\\/g, '/'),
            content: `${JSON.stringify(next, null, 2)}\n`,
          },
        ],
        assertOwned: lock.assertOwned,
      })
      return records
    },
    { resumeTransaction: { purpose } },
  )
}

export function sourceRegistryPath(root: string): string {
  return join(layoutFor(root).cacheDir, 'sources.json')
}

function uniqueSources(records: readonly SourceRecord[]): SourceRecord[] {
  const byId = new Map<string, SourceRecord>()
  for (const record of records) byId.set(record.id, record)
  return [...byId.values()]
}

function uniqueMutations(mutations: readonly KnowledgeFileMutation[]): KnowledgeFileMutation[] {
  const byPath = new Map<string, KnowledgeFileMutation>()
  for (const mutation of mutations) {
    const existing = byPath.get(mutation.path)
    if (existing && !sameMutation(existing, mutation)) {
      throw new Error(`source import produced conflicting raw path: ${mutation.path}`)
    }
    byPath.set(mutation.path, mutation)
  }
  return [...byPath.values()]
}

function sameMutation(left: KnowledgeFileMutation, right: KnowledgeFileMutation): boolean {
  if (left.mode !== right.mode) return false
  if (Buffer.isBuffer(left.content) && Buffer.isBuffer(right.content)) {
    return left.content.equals(right.content)
  }
  return left.content === right.content
}

async function listSourceFiles(root: string): Promise<Array<{ path: string; mode: number }>> {
  const entries = await readdir(root, { withFileTypes: true })
  const out: Array<{ path: string; mode: number }> = []
  for (const entry of entries) {
    const full = join(root, entry.name)
    const entryStat = await lstat(full)
    if (entryStat.isDirectory()) out.push(...(await listSourceFiles(full)))
    else if (entryStat.isFile()) out.push({ path: full, mode: entryStat.mode & 0o777 })
    else throw new Error(`unsupported directory entry in source import: ${full}`)
  }
  return out
}

function rawSourcePath(fileName: string, contentHash: string, extension: string): string {
  return join(
    'raw',
    'sources',
    `${slugify(fileName.replace(/\.[^.]+$/, ''))}-${contentHash.slice(0, 8)}${extension}`,
  ).replace(/\\/g, '/')
}

function ext(fileName: string): string {
  const idx = fileName.lastIndexOf('.')
  return idx >= 0 ? fileName.slice(idx) : ''
}

function mediaTypeFor(fileName: string): string {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.md')) return 'text/markdown'
  if (lower.endsWith('.txt')) return 'text/plain'
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.csv')) return 'text/csv'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  return 'application/octet-stream'
}

function textPreview(fileName: string, bytes: Buffer): string | undefined {
  const mediaType = mediaTypeFor(fileName)
  if (!mediaType.startsWith('text/') && mediaType !== 'application/json') return undefined
  return bytes.toString('utf8').slice(0, 200_000)
}
