import { join } from 'node:path'
import {
  isMissingFile,
  listRegularFilesWithinRoot,
  readRegularFileWithinRoot,
  withSafeDirectory,
  writeFileDurableWithinRoot,
  writeJsonDurable,
} from './durable-fs'
import { parseFrontmatter } from './frontmatter'
import { slugify } from './ids'
import { withKnowledgeMutation, withKnowledgeRead } from './mutation-lock'
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

export async function loadKnowledgePages(root: string): Promise<KnowledgePage[]> {
  return withKnowledgeRead(root, () => loadKnowledgePagesUnlocked(root))
}

async function loadKnowledgePagesUnlocked(root: string): Promise<KnowledgePage[]> {
  let files: Awaited<ReturnType<typeof listRegularFilesWithinRoot>>
  try {
    files = await listRegularFilesWithinRoot(root, 'knowledge')
  } catch (error) {
    if (isMissingFile(error)) return []
    throw error
  }
  const pages: KnowledgePage[] = []
  for (const file of files) {
    const rel = file.path
    if (!rel.endsWith('.md')) continue
    if (isScaffoldPath(rel)) continue
    const content = file.bytes.toString('utf8')
    const { frontmatter, body } = parseFrontmatter(content)
    const title =
      stringField(frontmatter.title) ??
      firstHeading(body) ??
      rel.split('/').pop()!.replace(/\.md$/, '')
    const sourceIds = arrayField(frontmatter.sources)
    const tags = arrayField(frontmatter.tags)
    pages.push({
      id:
        stringField(frontmatter.id) ??
        slugify(rel.replace(/^knowledge\//, '').replace(/\.md$/, '')),
      path: rel,
      title,
      text: body,
      frontmatter,
      sourceIds,
      tags,
      outLinks: extractWikilinks(body).map(normalizeLinkTarget),
    })
  }
  pages.sort((a, b) => a.path.localeCompare(b.path))
  return pages
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

function firstHeading(body: string): string | undefined {
  return /^#\s+(.+)$/m.exec(body)?.[1]?.trim()
}
