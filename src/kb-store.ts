import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { KnowledgeEventQuery } from './events'
import { buildKnowledgeGraph } from './graph'
import type { KnowledgeEvent, KnowledgeIndex, KnowledgePage, SourceRecord } from './types'

export interface KbStore {
  putSource(source: SourceRecord): Promise<void>
  getSource(id: string): Promise<SourceRecord | null>
  listSources(): Promise<SourceRecord[]>
  putPage(page: KnowledgePage): Promise<void>
  getPage(idOrPath: string): Promise<KnowledgePage | null>
  listPages(): Promise<KnowledgePage[]>
  putIndex(index: KnowledgeIndex): Promise<void>
  getIndex(): Promise<KnowledgeIndex | null>
  putEvent(event: KnowledgeEvent): Promise<void>
  listEvents(query?: KnowledgeEventQuery): Promise<KnowledgeEvent[]>
}

export class MemoryKbStore implements KbStore {
  private readonly sources = new Map<string, SourceRecord>()
  private readonly pages = new Map<string, KnowledgePage>()
  private readonly events: KnowledgeEvent[] = []
  private index: KnowledgeIndex | null = null

  async putSource(source: SourceRecord): Promise<void> {
    this.sources.set(source.id, clone(source))
  }

  async getSource(id: string): Promise<SourceRecord | null> {
    return clone(this.sources.get(id) ?? null)
  }

  async listSources(): Promise<SourceRecord[]> {
    return [...this.sources.values()].map(clone)
  }

  async putPage(page: KnowledgePage): Promise<void> {
    this.pages.set(page.id, clone(page))
  }

  async getPage(idOrPath: string): Promise<KnowledgePage | null> {
    return clone(
      this.pages.get(idOrPath) ??
        [...this.pages.values()].find((page) => page.path === idOrPath) ??
        null,
    )
  }

  async listPages(): Promise<KnowledgePage[]> {
    return [...this.pages.values()].map(clone)
  }

  async putIndex(index: KnowledgeIndex): Promise<void> {
    this.index = clone(index)
  }

  async getIndex(): Promise<KnowledgeIndex | null> {
    if (this.index) return clone(this.index)
    const pages = await this.listPages()
    const sources = await this.listSources()
    return {
      root: 'memory',
      generatedAt: new Date().toISOString(),
      sources,
      pages,
      graph: buildKnowledgeGraph(pages),
    }
  }

  async putEvent(event: KnowledgeEvent): Promise<void> {
    this.events.push(clone(event))
  }

  async listEvents(query: KnowledgeEventQuery = {}): Promise<KnowledgeEvent[]> {
    let out = this.events
    if (query.type) out = out.filter((event) => event.type === query.type)
    if (query.target) out = out.filter((event) => event.target === query.target)
    out = [...out].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return out.slice(-(query.limit ?? out.length)).map(clone)
  }
}

export class FileSystemKbStore extends MemoryKbStore {
  constructor(private readonly dir: string) {
    super()
  }

  async putIndex(index: KnowledgeIndex): Promise<void> {
    await super.putIndex(index)
    await writeJson(join(this.dir, 'index.json'), index)
  }

  async getIndex(): Promise<KnowledgeIndex | null> {
    try {
      return JSON.parse(await readFile(join(this.dir, 'index.json'), 'utf8')) as KnowledgeIndex
    } catch {
      return await super.getIndex()
    }
  }

  async putEvent(event: KnowledgeEvent): Promise<void> {
    await super.putEvent(event)
    const events = await this.listEvents()
    await writeJson(join(this.dir, 'events.json'), events)
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function clone<T>(value: T): T {
  return value == null ? value : (JSON.parse(JSON.stringify(value)) as T)
}
