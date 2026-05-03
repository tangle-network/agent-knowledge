import { join } from 'node:path'
import type { KnowledgeIndex } from './types'
import { buildKnowledgeGraph } from './graph'
import { loadSourceRegistry } from './sources'
import { layoutFor, loadKnowledgePages, writeJson } from './store'

export async function buildKnowledgeIndex(root: string): Promise<KnowledgeIndex> {
  const [pages, sourceRegistry] = await Promise.all([
    loadKnowledgePages(root),
    loadSourceRegistry(root),
  ])
  const index: KnowledgeIndex = {
    root,
    generatedAt: new Date().toISOString(),
    sources: sourceRegistry.sources,
    pages,
    graph: buildKnowledgeGraph(pages),
  }
  return index
}

export async function writeKnowledgeIndex(root: string): Promise<KnowledgeIndex> {
  const index = await buildKnowledgeIndex(root)
  await writeJson(join(layoutFor(root).cacheDir, 'index.json'), index)
  return index
}
