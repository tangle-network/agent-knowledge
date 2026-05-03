import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import type { KnowledgePage } from './types'
import { parseFrontmatter } from './frontmatter'
import { slugify } from './ids'
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

export async function initKnowledgeBase(root: string): Promise<KnowledgeLayout> {
  const layout = layoutFor(root)
  await mkdir(layout.knowledgeDir, { recursive: true })
  await mkdir(layout.rawSourcesDir, { recursive: true })
  await mkdir(layout.cacheDir, { recursive: true })
  await writeIfMissing(layout.indexPath, '# Knowledge Index\n\n')
  await writeIfMissing(layout.logPath, '# Knowledge Log\n\n')
  await writeIfMissing(layout.sourceRegistryPath, '{\n  "generatedAt": "1970-01-01T00:00:00.000Z",\n  "sources": []\n}\n')
  return layout
}

export async function loadKnowledgePages(root: string): Promise<KnowledgePage[]> {
  const layout = layoutFor(root)
  const files = await listMarkdownFiles(layout.knowledgeDir)
  const pages: KnowledgePage[] = []
  for (const file of files) {
    const content = await readFile(file, 'utf8')
    const { frontmatter, body } = parseFrontmatter(content)
    const rel = relative(root, file).replace(/\\/g, '/')
    const title = stringField(frontmatter.title) ?? firstHeading(body) ?? rel.split('/').pop()!.replace(/\.md$/, '')
    const sourceIds = arrayField(frontmatter.sources)
    const tags = arrayField(frontmatter.tags)
    pages.push({
      id: stringField(frontmatter.id) ?? slugify(rel.replace(/^knowledge\//, '').replace(/\.md$/, '')),
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
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await stat(path)
  } catch {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
  }
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const out: string[] = []
    for (const entry of entries) {
      const full = join(root, entry.name)
      if (entry.isDirectory()) out.push(...await listMarkdownFiles(full))
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full)
    }
    return out
  } catch {
    return []
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function arrayField(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function firstHeading(body: string): string | undefined {
  return /^#\s+(.+)$/m.exec(body)?.[1]?.trim()
}
