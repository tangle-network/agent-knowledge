import { buildKnowledgeIndex } from './indexer'
import { buildKnowledgeLexicalIndex, type KnowledgeLexicalIndex } from './lexical-index'
import { type KnowledgePagesOptions, normalizePagesDirectory } from './pages-directory'
import type { RetrievalEvalRetriever, RetrievedKnowledgeHit } from './retrieval-eval'
import { searchKnowledge } from './search'
import type { KnowledgeIndex, KnowledgeSearchResult } from './types'

export interface FileSystemSearchProviderOptions extends KnowledgePagesOptions {
  /** Knowledge-base root containing the pages directory and `.agent-knowledge/`. */
  root: string
  /** Optional warm index, useful when the caller already built one. */
  index?: KnowledgeIndex
  /** Default result count for `search()`. Defaults to 10. */
  defaultLimit?: number
  /**
   * `manual` caches the index until `refresh: true` or `invalidate()`.
   * `always` rebuilds from disk on every search.
   */
  refresh?: 'manual' | 'always'
}
export interface FileSystemSearchOptions {
  limit?: number
  refresh?: boolean
}

/**
 * File-first retrieval over an `agent-knowledge` KB.
 *
 * This is the simple backend for products that want deterministic search over
 * markdown knowledge files before adding embeddings, rerankers, or a vector DB.
 */
export class FileSystemSearchProvider {
  readonly root: string
  /** Root-relative directory the provider indexes. */
  readonly pagesDirectory: string
  private index: KnowledgeIndex | undefined
  private lexicalIndex: KnowledgeLexicalIndex | undefined
  private readonly defaultLimit: number
  private readonly refreshMode: 'manual' | 'always'

  constructor(options: FileSystemSearchProviderOptions) {
    this.root = options.root
    this.pagesDirectory = normalizePagesDirectory(options.pagesDirectory)
    this.index = options.index
    this.defaultLimit = options.defaultLimit ?? 10
    this.refreshMode = options.refresh ?? 'manual'
  }

  async getIndex(options: FileSystemSearchOptions = {}): Promise<KnowledgeIndex> {
    if (this.refreshMode === 'always' || options.refresh || !this.index) {
      this.index = await buildKnowledgeIndex(this.root, { pagesDirectory: this.pagesDirectory })
      this.lexicalIndex = undefined
    }
    return this.index
  }

  async search(
    query: string,
    options: FileSystemSearchOptions = {},
  ): Promise<KnowledgeSearchResult[]> {
    const index = await this.getIndex(options)
    if (!this.lexicalIndex) this.lexicalIndex = buildKnowledgeLexicalIndex(index.pages)
    return searchKnowledge(index, query, {
      limit: options.limit ?? this.defaultLimit,
      lexicalIndex: this.lexicalIndex,
    })
  }

  async retrieve(
    query: string,
    options: FileSystemSearchOptions = {},
  ): Promise<RetrievedKnowledgeHit[]> {
    const hits = await this.search(query, options)
    return hits.map(hitFromSearchResult)
  }

  asRetrievalEvalRetriever(): RetrievalEvalRetriever {
    return async ({ config, scenario, k }) => ({
      hits: await this.retrieve(scenario.query, {
        limit: k,
        refresh: config.refresh === true,
      }),
    })
  }

  invalidate(): void {
    this.index = undefined
    this.lexicalIndex = undefined
  }
}

export function createFileSystemSearchProvider(
  options: FileSystemSearchProviderOptions,
): FileSystemSearchProvider {
  return new FileSystemSearchProvider(options)
}

function hitFromSearchResult(result: KnowledgeSearchResult): RetrievedKnowledgeHit {
  return {
    pageId: result.page.id,
    path: result.page.path,
    title: result.page.title,
    rank: result.rank,
    score: result.score,
    normalizedScore: result.normalizedScore,
    sourceIds: result.page.sourceIds,
    snippet: result.snippet,
  }
}
