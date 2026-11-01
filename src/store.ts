import { join, resolve } from 'node:path'
import { mapFileIo } from './bounded-file-io'
import {
  type FileIdentity,
  isMissingFile,
  listRegularFileMetadataWithinRoot,
  listRegularFilesWithinRoot,
  readRegularFileWithinRoot,
  withSafeDirectory,
  writeFileDurableWithinRoot,
  writeJsonDurable,
} from './durable-fs'
import { parseFrontmatter } from './frontmatter'
import { slugify } from './ids'
import { isKnowledgeRootHeld, withKnowledgeMutation, withKnowledgeRead } from './mutation-lock'
import { type KnowledgePagesOptions, normalizePagesDirectory } from './pages-directory'
import { KnowledgePageInvalidationSchema } from './schemas'
import type { KnowledgePage } from './types'
import { extractWikilinks, normalizeLinkTarget } from './wikilinks'

export interface KnowledgeLayout {
  root: string
  knowledgeDir: string
  rawSourcesDir: string
  sourceRegistryPath: string
  indexPath: string
  logPath: string
  cacheDir: string
}

export function layoutFor(root: string): KnowledgeLayout {
  return {
    root,
    knowledgeDir: join(root, 'knowledge'),
    rawSourcesDir: join(root, 'raw', 'sources'),
    sourceRegistryPath: join(root, '.agent-knowledge', 'sources.json'),
    indexPath: join(root, 'knowledge', 'index.md'),
    logPath: join(root, 'knowledge', 'log.md'),
    cacheDir: join(root, '.agent-knowledge'),
  }
}

/**
 * Filenames that `initKnowledgeBase` writes as human-navigation scaffolding.
 * These are excluded from the page index — they exist on disk so authors can
 * curate their vault, but they are not searchable content.
 *
 * Add new scaffold filenames here (and only here) to keep lint, validate, viz,
 * and the indexer consistent.
 */
export const SCAFFOLD_PAGE_BASENAMES: readonly string[] = ['index.md', 'log.md']

/**
 * True when a knowledge-relative path points at a scaffold file rather than
 * authored content. Accepts both repo-relative paths (`knowledge/index.md`)
 * and any nested `<dir>/index.md` or `<dir>/log.md` (for example
 * `knowledge/concepts/index.md`) so subdirectory README-style scaffolds are
 * also excluded.
 */
export function isScaffoldPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  for (const basename of SCAFFOLD_PAGE_BASENAMES) {
    if (normalized === `knowledge/${basename}`) return true
    if (normalized.endsWith(`/${basename}`)) return true
  }
  return false
}

export async function initKnowledgeBase(root: string): Promise<KnowledgeLayout> {
  const layout = layoutFor(root)
  if (await knowledgeBaseInitialized(layout)) return layout
  return withKnowledgeMutation(root, () => initKnowledgeBaseUnlocked(root))
}

async function initKnowledgeBaseUnlocked(root: string): Promise<KnowledgeLayout> {
  const layout = layoutFor(root)
  await withSafeDirectory(root, 'knowledge', true, () => undefined)
  await withSafeDirectory(root, 'raw/sources', true, () => undefined)
  await withSafeDirectory(root, '.agent-knowledge', true, () => undefined)
  await writeIfMissing(root, 'knowledge/index.md', '# Knowledge Index\n\n')
  await writeIfMissing(root, 'knowledge/log.md', '# Knowledge Log\n\n')
  await writeIfMissing(
    root,
    '.agent-knowledge/sources.json',
    '{\n  "generatedAt": "1970-01-01T00:00:00.000Z",\n  "sources": []\n}\n',
  )
  return layout
}

export async function loadKnowledgePages(
  root: string,
  options: KnowledgePagesOptions = {},
): Promise<KnowledgePage[]> {
  const { views } = await readKnowledgePageViews([root], options)
  return views[0]!.pages.map((page) => structuredClone(page))
}

/** One root's pages, frozen and shared by every reader in this process, with what proves them. */
export type KnowledgePagesView = {
  readonly pages: readonly KnowledgePage[]
  generation: string | undefined
  bytes: number
  files: Map<string, { generation: string; page: KnowledgePage }>
}
type Refresh = Promise<{ view: KnowledgePagesView; pagesRead: number }>

const MAX_CACHED_ROOTS = 8
const MAX_CACHED_SOURCE_BYTES = 64 * 1024 * 1024
// A file changed this recently can be rewritten within one filesystem timestamp tick without
// changing its identity (every write moves ctime), so it is re-read until its ctime is older.
const RACY_NS = 1_000_000_000n
const cachedViews = new Map<string, KnowledgePagesView>()
// The roots each root was last read with, so a read of one store keeps the rest of its chain.
const cachedGroups = new Map<string, readonly string[]>()
const refreshes = new Map<string, { running?: Refresh; next?: Refresh }>()

/**
 * Internal. Each root's pages under one pages directory; a file is read and parsed again only when
 * its identity (device, inode, size, mtime, ctime) changed, so a read of an unchanged store reads
 * no page. `pagesRead` counts the files this call's refreshes read from disk. Beyond a root and byte
 * bound, the least recently read roots are evicted, never one read with this call's roots.
 */
export async function readKnowledgePageViews(
  roots: readonly string[],
  options: KnowledgePagesOptions = {},
): Promise<{ views: KnowledgePagesView[]; pagesRead: number }> {
  const pagesDirectory = normalizePagesDirectory(options.pagesDirectory)
  const keys = roots.map((root) => JSON.stringify([resolve(root), pagesDirectory]))
  const loaded = await Promise.all(
    roots.map((root, index) => refreshView(keys[index]!, resolve(root), pagesDirectory)),
  )
  if (keys.length > 1) for (const key of keys) cachedGroups.set(key, keys)
  const live = new Set(keys.flatMap((key) => cachedGroups.get(key) ?? [key]))
  let bytes = 0
  for (const view of cachedViews.values()) bytes += view.bytes
  for (const [key, view] of cachedViews) {
    if (cachedViews.size <= MAX_CACHED_ROOTS && bytes <= MAX_CACHED_SOURCE_BYTES) break
    if (live.has(key)) continue
    cachedViews.delete(key)
    cachedGroups.delete(key)
    bytes -= view.bytes
  }
  return {
    views: loaded.map((item) => item.view),
    pagesRead: loaded.reduce((sum, item) => sum + item.pagesRead, 0),
  }
}

// One refresh per root at a time. A caller joins only a refresh that starts after it arrived, so it
// observes every write that completed before its call. A caller already inside a read or write of
// the root loads by itself: a queued refresh may be waiting for that very scope to end.
function refreshView(key: string, root: string, pagesDirectory: string): Refresh {
  const start = (): Refresh =>
    loadView(root, pagesDirectory, cachedViews.get(key)).then((loaded) => {
      cachedViews.delete(key)
      cachedViews.set(key, loaded.view)
      return loaded
    })
  if (isKnowledgeRootHeld(root)) return start()
  const state = refreshes.get(key) ?? {}
  refreshes.set(key, state)
  state.next ??= (state.running ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => {
      state.next = undefined
      const running = start().finally(() => {
        if (state.running === running) state.running = undefined
        if (!state.running && !state.next) refreshes.delete(key)
      })
      state.running = running
      return running
    })
  return state.next
}

function loadView(root: string, pagesDirectory: string, previous?: KnowledgePagesView): Refresh {
  return withKnowledgeRead(root, async () => {
    const recent = BigInt(Date.now()) * 1_000_000n - RACY_NS
    const listed = await listRegularFileMetadataWithinRoot(root, pagesDirectory).catch(
      (error: unknown) => (isMissingFile(error) ? ([] as FileIdentity[]) : Promise.reject(error)),
    )
    const trusted = (file: FileIdentity) => (file.changedNs < recent ? file.generation : '')
    const generation = listed.every((file) => trusted(file) !== '')
      ? JSON.stringify(listed.map((file) => [file.path, file.generation]))
      : undefined
    if (generation !== undefined && previous?.generation === generation) {
      return { view: previous, pagesRead: 0 }
    }
    const files: KnowledgePagesView['files'] = new Map()
    const changed: FileIdentity[] = []
    for (const file of listed) {
      const known = previous?.files.get(file.path)
      if (known?.generation === file.generation) files.set(file.path, known)
      else if (isKnowledgePagePath(file.path)) changed.push(file)
    }
    const parse = (file: FileIdentity, bytes: Buffer) => {
      const page = knowledgePageFromMarkdown(file.path, bytes.toString('utf8'), pagesDirectory)
      const known = previous?.files.get(file.path)?.page
      const same =
        known?.text === page.text &&
        JSON.stringify(known.frontmatter) === JSON.stringify(page.frontmatter)
      files.set(file.path, { generation: trusted(file), page: same ? known : freezeView(page) })
    }
    let pagesRead = changed.length
    if (changed.length > listed.length / 2) {
      // A cold or wholesale change reads the tree through one anchored walk. A file replaced or
      // removed after the listing differs from its listed generation at the next refresh.
      const wanted = new Map(changed.map((file) => [file.path, file]))
      const walked = await listRegularFilesWithinRoot(root, pagesDirectory)
      for (const file of walked)
        if (wanted.has(file.path)) parse(wanted.get(file.path)!, file.bytes)
      pagesRead = walked.length
    } else {
      await mapFileIo(changed, async (file) => {
        try {
          parse(file, (await readRegularFileWithinRoot(root, file.path)).bytes)
        } catch (error) {
          if (!isMissingFile(error)) throw error
        }
      })
    }
    const pages = [...files.values()]
      .map((file) => file.page)
      .sort((a, b) => a.path.localeCompare(b.path))
    const bytes = listed.reduce((sum, file) => sum + file.bytes, 0)
    // Unchanged content keeps its page objects, and then the view keeps its identity.
    if (previous?.pages.length === pages.length && pages.every((p, i) => p === previous.pages[i])) {
      return { view: Object.assign(previous, { generation, bytes, files }), pagesRead }
    }
    return { view: { pages: Object.freeze(pages), generation, bytes, files }, pagesRead }
  })
}

function freezeView<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeView(child)
    Object.freeze(value)
  }
  return value
}

/** True when a root-relative path names authored Markdown rather than scaffolding. */
export function isKnowledgePagePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return normalized.endsWith('.md') && !isScaffoldPath(normalized)
}

/**
 * Build a page from the bytes of one Markdown file.
 *
 * The reader and every gate that inspects a page before it is written share
 * this constructor, so what a gate judges is exactly what the store loads back.
 */
export function knowledgePageFromMarkdown(
  path: string,
  content: string,
  pagesDirectory?: string,
): KnowledgePage {
  const rel = path.replace(/\\/g, '/')
  const pagesPrefix = `${normalizePagesDirectory(pagesDirectory)}/`
  const { frontmatter, body } = parseFrontmatter(content)
  const title =
    stringField(frontmatter.title) ??
    firstHeading(body) ??
    rel.split('/').pop()!.replace(/\.md$/, '')
  const cites = idListField(frontmatter.cites)
  const contradicts = idListField(frontmatter.contradicts)
  const invalidation = KnowledgePageInvalidationSchema.safeParse(frontmatter.invalidation)
  const pageRelativePath = rel.startsWith(pagesPrefix) ? rel.slice(pagesPrefix.length) : rel
  return {
    id: stringField(frontmatter.id) ?? slugify(pageRelativePath.replace(/\.md$/, '')),
    path: rel,
    title,
    text: body,
    frontmatter,
    sourceIds: arrayField(frontmatter.sources),
    tags: arrayField(frontmatter.tags),
    outLinks: extractWikilinks(body).map(normalizeLinkTarget),
    ...(cites.length > 0 ? { cites } : {}),
    ...(contradicts.length > 0 ? { contradicts } : {}),
    ...(invalidation.success ? { invalidation: invalidation.data } : {}),
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeJsonDurable(path, value)
}

async function writeIfMissing(root: string, relativePath: string, content: string): Promise<void> {
  try {
    await readRegularFileWithinRoot(root, relativePath)
  } catch (error) {
    if (!isMissingFile(error)) throw error
    await writeFileDurableWithinRoot(root, relativePath, content, { encoding: 'utf8' })
  }
}

async function knowledgeBaseInitialized(layout: KnowledgeLayout): Promise<boolean> {
  try {
    await withSafeDirectory(layout.root, 'knowledge', false, () => undefined)
    await withSafeDirectory(layout.root, 'raw/sources', false, () => undefined)
    await withSafeDirectory(layout.root, '.agent-knowledge', false, () => undefined)
    await readRegularFileWithinRoot(layout.root, 'knowledge/index.md')
    await readRegularFileWithinRoot(layout.root, 'knowledge/log.md')
    await readRegularFileWithinRoot(layout.root, '.agent-knowledge/sources.json')
    return true
  } catch (error) {
    if (isMissingFile(error)) return false
    throw error
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function arrayField(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function idListField(value: unknown): string[] {
  const values = typeof value === 'string' ? [value] : arrayField(value)
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))]
}

function firstHeading(body: string): string | undefined {
  return /^#\s+(.+)$/m.exec(body)?.[1]?.trim()
}
