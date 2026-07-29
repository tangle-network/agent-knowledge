import { buildKnowledgeGraph } from './graph'
import { FileSystemKbStore } from './kb-store'
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

/**
 * Build the index from the knowledge tree and store it.
 *
 * The write goes through `FileSystemKbStore` rather than straight to disk: this
 * function and the store used to write two different index files in two
 * different places, so a knowledge base could hold two disagreeing indexes and
 * a store-based reader saw none of the indexer's work. One writer now, and it
 * validates through `KnowledgeIndexSchema` on the way out.
 */
export async function writeKnowledgeIndex(root: string): Promise<KnowledgeIndex> {
  return withKnowledgeMutation(root, async () => {
    const index = await buildKnowledgeIndexUnlocked(root)
    await new FileSystemKbStore(root).putIndex(index)
    return index
  })
}
