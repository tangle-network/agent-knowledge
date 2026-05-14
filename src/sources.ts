import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { type SourceAdapter, textSourceAdapter } from './adapters'
import { sha256, slugify, stableId } from './ids'
import { layoutFor } from './store'
import type { SourceRecord, SourceRegistry } from './types'

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
  const path = sourceRegistryPath(root)
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as SourceRegistry
    return {
      generatedAt:
        typeof parsed.generatedAt === 'string' ? parsed.generatedAt : new Date(0).toISOString(),
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
    }
  } catch {
    return { generatedAt: new Date(0).toISOString(), sources: [] }
  }
}

export async function writeSourceRegistry(root: string, registry: SourceRegistry): Promise<void> {
  const path = sourceRegistryPath(root)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
}

export async function addSourcePath(
  root: string,
  sourcePath: string,
  options: AddSourceOptions = {},
): Promise<SourceRecord[]> {
  const s = await stat(sourcePath)
  if (s.isDirectory()) {
    const out: SourceRecord[] = []
    for (const file of await listFiles(sourcePath)) {
      out.push(...(await addSourcePath(root, file, options)))
    }
    return out
  }

  const layout = layoutFor(root)
  await mkdir(layout.rawSourcesDir, { recursive: true })
  const bytes = await readFile(sourcePath)
  const contentHash = sha256(bytes.toString('base64'))
  const fileName = basename(sourcePath)
  const adapters = options.adapters ?? [textSourceAdapter]
  const adapter = adapters.find((candidate) => candidate.canLoad({ uri: sourcePath, bytes }))
  const loaded = adapter ? await adapter.load({ uri: sourcePath, bytes }) : {}
  const id = stableId('src', `${contentHash}:${fileName}`)
  const targetRel = join(
    'raw',
    'sources',
    `${slugify(fileName.replace(/\.[^.]+$/, ''))}-${contentHash.slice(0, 8)}${ext(fileName)}`,
  ).replace(/\\/g, '/')
  const targetAbs = join(root, targetRel)

  if (options.copyIntoRaw ?? true) {
    await mkdir(dirname(targetAbs), { recursive: true })
    await copyFile(sourcePath, targetAbs)
  }

  const existing = await loadSourceRegistry(root)
  const record: SourceRecord = {
    id,
    uri: targetRel,
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
  }
  const next: SourceRegistry = {
    generatedAt: new Date().toISOString(),
    sources: [record, ...existing.sources.filter((source) => source.id !== id)],
  }
  await writeSourceRegistry(root, next)
  return [record]
}

export async function addSourceText(
  root: string,
  input: AddSourceTextInput,
  options: Pick<AddSourceOptions, 'adapters' | 'now'> = {},
): Promise<SourceRecord> {
  const text = input.text
  const contentHash = sha256(text)
  const fileName = basename(input.uri) || `${slugify(input.title ?? input.uri)}.txt`
  const adapterInput = { uri: input.uri, text, metadata: input.metadata }
  const adapter = (options.adapters ?? [textSourceAdapter]).find((candidate) =>
    candidate.canLoad(adapterInput),
  )
  const loaded = adapter ? await adapter.load(adapterInput) : {}
  const id = stableId('src', `${contentHash}:${input.uri}`)
  const targetRel = join(
    'raw',
    'sources',
    `${slugify(fileName.replace(/\.[^.]+$/, ''))}-${contentHash.slice(0, 8)}.txt`,
  ).replace(/\\/g, '/')
  const targetAbs = join(root, targetRel)
  await mkdir(dirname(targetAbs), { recursive: true })
  await writeFile(targetAbs, text.endsWith('\n') ? text : `${text}\n`, 'utf8')

  const existing = await loadSourceRegistry(root)
  const record: SourceRecord = {
    id,
    uri: targetRel,
    title: input.title ?? loaded.title ?? fileName,
    mediaType: input.mediaType ?? loaded.mediaType ?? 'text/plain',
    contentHash,
    text: loaded.text ?? text.slice(0, 200_000),
    anchors: (loaded.anchors ?? []).map((anchor) => ({ ...anchor, sourceId: id })),
    validUntil: input.validUntil,
    lastVerifiedAt: input.lastVerifiedAt,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    metadata: {
      ...(loaded.metadata ?? {}),
      ...(input.metadata ?? {}),
      originalUri: input.uri,
      sizeBytes: Buffer.byteLength(text, 'utf8'),
    },
  }
  await writeSourceRegistry(root, {
    generatedAt: new Date().toISOString(),
    sources: [record, ...existing.sources.filter((source) => source.id !== id)],
  })
  return record
}

export function sourceRegistryPath(root: string): string {
  return join(layoutFor(root).cacheDir, 'sources.json')
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) out.push(...(await listFiles(full)))
    else if (entry.isFile()) out.push(full)
  }
  return out
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
