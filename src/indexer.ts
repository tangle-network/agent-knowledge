import { join } from 'node:path'
import type { KnowledgeIndex } from './types'
import { buildKnowledgeGraph } from './graph'
import { layoutFor, loadKnowledgePages, writeJson } from './store'

export async function buildKnowledgeIndex(root: string): Promise<KnowledgeIndex> {
  const pages = await loadKnowledgePages(root)
  const index: KnowledgeIndex = {
    root,
    generatedAt: new Date().toISOString(),
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
