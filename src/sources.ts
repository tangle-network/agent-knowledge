import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import type { SourceRecord, SourceRegistry } from './types'
import { sha256, slugify, stableId } from './ids'
import { layoutFor } from './store'

export interface AddSourceOptions {
  copyIntoRaw?: boolean
  now?: () => Date
}

export async function loadSourceRegistry(root: string): Promise<SourceRegistry> {
  const path = sourceRegistryPath(root)
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as SourceRegistry
    return {
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : new Date(0).toISOString(),
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
    }
  } catch {
    return { generatedAt: new Date(0).toISOString(), sources: [] }
  }
}

export async function writeSourceRegistry(root: string, registry: SourceRegistry): Promise<void> {
  const path = sourceRegistryPath(root)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(registry, null, 2) + '\n', 'utf8')
}

export async function addSourcePath(root: string, sourcePath: string, options: AddSourceOptions = {}): Promise<SourceRecord[]> {
  const s = await stat(sourcePath)
  if (s.isDirectory()) {
    const out: SourceRecord[] = []
    for (const file of await listFiles(sourcePath)) {
      out.push(...await addSourcePath(root, file, options))
    }
    return out
  }

  const layout = layoutFor(root)
  await mkdir(layout.rawSourcesDir, { recursive: true })
  const bytes = await readFile(sourcePath)
  const contentHash = sha256(bytes.toString('base64'))
  const fileName = basename(sourcePath)
  const id = stableId('src', `${contentHash}:${fileName}`)
  const targetRel = join('raw', 'sources', `${slugify(fileName.replace(/\.[^.]+$/, ''))}-${contentHash.slice(0, 8)}${ext(fileName)}`).replace(/\\/g, '/')
  const targetAbs = join(root, targetRel)

  if (options.copyIntoRaw ?? true) {
    await mkdir(dirname(targetAbs), { recursive: true })
    await copyFile(sourcePath, targetAbs)
  }

  const existing = await loadSourceRegistry(root)
  const record: SourceRecord = {
    id,
    uri: targetRel,
    title: fileName,
    mediaType: mediaTypeFor(fileName),
    contentHash,
    text: textPreview(fileName, bytes),
    anchors: [],
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    metadata: {
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

export function sourceRegistryPath(root: string): string {
  return join(layoutFor(root).cacheDir, 'sources.json')
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) out.push(...await listFiles(full))
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
