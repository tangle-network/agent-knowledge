import { writeJsonDurableWithinRoot } from './durable-fs'
import { buildKnowledgeGraph } from './graph'
import { withKnowledgeMutation, withKnowledgeRead } from './mutation-lock'
import { loadSourceRegistry } from './sources'
import { loadKnowledgePages } from './store'
import type { KnowledgeIndex } from './types'

export async function buildKnowledgeIndex(root: string): Promise<KnowledgeIndex> {
  return withKnowledgeRead(root, () => buildKnowledgeIndexUnlocked(root))
}

async function buildKnowledgeIndexUnlocked(root: string): Promise<KnowledgeIndex> {
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
  return withKnowledgeMutation(root, async () => {
    const index = await buildKnowledgeIndexUnlocked(root)
    await writeJsonDurableWithinRoot(root, '.agent-knowledge/index.json', index)
    return index
  })
}
