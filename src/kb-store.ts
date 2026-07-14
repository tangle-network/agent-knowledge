import { z } from 'zod'
import { readRegularFileWithinRoot, writeJsonDurableWithinRoot } from './durable-fs'
import type { KnowledgeEventQuery } from './events'
import { buildKnowledgeGraph } from './graph'
import { withKnowledgeMutation, withKnowledgeRead } from './mutation-lock'
import {
  KnowledgeEventSchema,
  KnowledgeIndexSchema,
  KnowledgePageSchema,
  SourceRecordSchema,
} from './schemas'
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

const knowledgeEventsSchema = z.array(KnowledgeEventSchema)

export class FileSystemKbStore implements KbStore {
  constructor(private readonly dir: string) {}

  async putSource(source: SourceRecord): Promise<void> {
    const parsed = SourceRecordSchema.parse(source) as SourceRecord
    await this.updateIndex((index) => ({
      ...index,
      generatedAt: new Date().toISOString(),
      sources: [parsed, ...index.sources.filter((entry) => entry.id !== parsed.id)],
    }))
  }

  async getSource(id: string): Promise<SourceRecord | null> {
    return withKnowledgeRead(this.dir, async () => {
      const index = await this.readIndex()
      return clone(index?.sources.find((source) => source.id === id) ?? null)
    })
  }

  async listSources(): Promise<SourceRecord[]> {
    return withKnowledgeRead(this.dir, async () => clone((await this.readIndex())?.sources ?? []))
  }

  async putPage(page: KnowledgePage): Promise<void> {
    const parsed = KnowledgePageSchema.parse(page) as KnowledgePage
    await this.updateIndex((index) => {
      const pages = [parsed, ...index.pages.filter((entry) => entry.id !== parsed.id)]
      return {
        ...index,
        generatedAt: new Date().toISOString(),
        pages,
        graph: buildKnowledgeGraph(pages),
      }
    })
  }

  async getPage(idOrPath: string): Promise<KnowledgePage | null> {
    return withKnowledgeRead(this.dir, async () => {
      const index = await this.readIndex()
      return clone(
        index?.pages.find((page) => page.id === idOrPath || page.path === idOrPath) ?? null,
      )
    })
  }

  async listPages(): Promise<KnowledgePage[]> {
    return withKnowledgeRead(this.dir, async () => clone((await this.readIndex())?.pages ?? []))
  }

  async putIndex(index: KnowledgeIndex): Promise<void> {
    const parsed = KnowledgeIndexSchema.parse(index) as KnowledgeIndex
    await withKnowledgeMutation(this.dir, () =>
      writeJsonDurableWithinRoot(this.dir, 'index.json', parsed),
    )
  }

  async getIndex(): Promise<KnowledgeIndex | null> {
    return withKnowledgeRead(this.dir, () => this.readIndex())
  }

  async putEvent(event: KnowledgeEvent): Promise<void> {
    const parsed = KnowledgeEventSchema.parse(event) as KnowledgeEvent
    await withKnowledgeMutation(this.dir, async () => {
      const current = await this.readEvents()
      const next = [...current.filter((entry) => entry.id !== parsed.id), parsed].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      )
      await writeJsonDurableWithinRoot(this.dir, 'events.json', next)
    })
  }

  async listEvents(query: KnowledgeEventQuery = {}): Promise<KnowledgeEvent[]> {
    return withKnowledgeRead(this.dir, async () => {
      let events = await this.readEvents()
      if (query.type) events = events.filter((event) => event.type === query.type)
      if (query.target) events = events.filter((event) => event.target === query.target)
      return clone(events.slice(-(query.limit ?? events.length)))
    })
  }

  private async updateIndex(change: (index: KnowledgeIndex) => KnowledgeIndex): Promise<void> {
    await withKnowledgeMutation(this.dir, async () => {
      const current = (await this.readIndex()) ?? emptyIndex(this.dir)
      const next = KnowledgeIndexSchema.parse(change(current)) as KnowledgeIndex
      await writeJsonDurableWithinRoot(this.dir, 'index.json', next)
    })
  }

  private async readIndex(): Promise<KnowledgeIndex | null> {
    return readJsonFile(
      this.dir,
      'index.json',
      KnowledgeIndexSchema,
    ) as Promise<KnowledgeIndex | null>
  }

  private async readEvents(): Promise<KnowledgeEvent[]> {
    return ((await readJsonFile(this.dir, 'events.json', knowledgeEventsSchema)) ??
      []) as KnowledgeEvent[]
  }
}

function emptyIndex(root: string): KnowledgeIndex {
  return {
    root,
    generatedAt: new Date(0).toISOString(),
    sources: [],
    pages: [],
    graph: { nodes: [], edges: [] },
  }
}

async function readJsonFile<T>(
  root: string,
  relativePath: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    const file = await readRegularFileWithinRoot(root, relativePath)
    return schema.parse(JSON.parse(file.bytes.toString('utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null
    throw error
  }
}

function clone<T>(value: T): T {
  return value == null ? value : (JSON.parse(JSON.stringify(value)) as T)
}
