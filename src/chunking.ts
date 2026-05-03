export interface ChunkingOptions {
  targetChars: number
  maxChars: number
  minChars: number
  overlapChars: number
}

export interface KnowledgeChunk {
  index: number
  text: string
  headingPath: string
  charStart: number
  charEnd: number
  oversized: boolean
}

const DEFAULT_OPTIONS: ChunkingOptions = {
  targetChars: 1000,
  maxChars: 1500,
  minChars: 160,
  overlapChars: 180,
}

export function chunkMarkdown(content: string, options?: Partial<ChunkingOptions>): KnowledgeChunk[] {
  const opts = normalizeOptions({ ...DEFAULT_OPTIONS, ...(options ?? {}) })
  const { body, bodyOffset } = stripFrontmatter(content)
  if (body.trim() === '') return []

  const sections = splitSections(body, bodyOffset)
  const chunks: KnowledgeChunk[] = []
  for (const section of sections) {
    for (const part of chunkText(section.text, opts)) {
      const start = section.start + part.start
      chunks.push({
        index: chunks.length,
        text: part.text,
        headingPath: section.headingPath,
        charStart: start,
        charEnd: start + part.text.length,
        oversized: part.text.length > opts.maxChars,
      })
    }
  }
  return chunks
}

export function stripFrontmatter(content: string): { body: string; bodyOffset: number } {
  const normalized = content.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { body: normalized, bodyOffset: 0 }
  const match = /^---\n[\s\S]*?\n---\s*\n?/.exec(normalized)
  if (!match) return { body: normalized, bodyOffset: 0 }
  return { body: normalized.slice(match[0].length), bodyOffset: match[0].length }
}

function normalizeOptions(opts: ChunkingOptions): ChunkingOptions {
  if (opts.maxChars < opts.targetChars) opts.maxChars = opts.targetChars
  if (opts.overlapChars >= opts.targetChars) opts.overlapChars = Math.floor(opts.targetChars / 2)
  return opts
}

interface Section {
  text: string
  start: number
  headingPath: string
}

function splitSections(body: string, bodyOffset: number): Section[] {
  const lines = body.split('\n')
  const sections: Section[] = []
  const headings: Record<number, string> = {}
  let current: { lines: string[]; start: number; headingPath: string } = { lines: [], start: bodyOffset, headingPath: '' }
  let cursor = bodyOffset
  let fence: string | null = null

  const flush = () => {
    const text = current.lines.join('\n')
    if (text.trim() !== '') sections.push({ text, start: current.start, headingPath: current.headingPath })
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const lineLen = line.length + (i < lines.length - 1 ? 1 : 0)
    const fenceMatch = /^(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]!
      fence = fence === null ? marker : line.startsWith(fence) ? null : fence
      current.lines.push(line)
      cursor += lineLen
      continue
    }
    const heading = fence === null ? /^(#{1,6})\s+(.+?)\s*$/.exec(line) : null
    if (heading) {
      flush()
      const level = heading[1]!.length
      headings[level] = heading[2]!.trim()
      for (let next = level + 1; next <= 6; next++) delete headings[next]
      current = {
        lines: [line],
        start: cursor,
        headingPath: Object.entries(headings)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([levelText, title]) => `${'#'.repeat(Number(levelText))} ${title}`)
          .join(' > '),
      }
      cursor += lineLen
      continue
    }
    current.lines.push(line)
    cursor += lineLen
  }
  flush()
  return sections
}

function chunkText(text: string, opts: ChunkingOptions): Array<{ text: string; start: number }> {
  if (text.length <= opts.targetChars) return [{ text, start: 0 }]
  const atoms = splitAtoms(text)
  const chunks: Array<{ text: string; start: number }> = []
  let buffer = ''
  let bufferStart = 0
  for (const atom of atoms) {
    if (buffer === '') bufferStart = atom.start
    if (buffer.length > 0 && buffer.length + atom.text.length > opts.targetChars) {
      chunks.push({ text: buffer.trimEnd(), start: bufferStart })
      const overlap = buffer.slice(Math.max(0, buffer.length - opts.overlapChars))
      buffer = overlap + atom.text
      bufferStart = Math.max(bufferStart, atom.start - overlap.length)
    } else {
      buffer += atom.text
    }
  }
  if (buffer.trim() !== '') chunks.push({ text: buffer.trimEnd(), start: bufferStart })
  return mergeTinyChunks(chunks, opts)
}

function splitAtoms(text: string): Array<{ text: string; start: number }> {
  const parts: Array<{ text: string; start: number }> = []
  const paragraphs = text.split(/(\n\s*\n)/)
  let cursor = 0
  for (let i = 0; i < paragraphs.length; i += 2) {
    const paragraph = (paragraphs[i] ?? '') + (paragraphs[i + 1] ?? '')
    if (paragraph === '') continue
    parts.push({ text: paragraph, start: cursor })
    cursor += paragraph.length
  }
  return parts
}

function mergeTinyChunks(chunks: Array<{ text: string; start: number }>, opts: ChunkingOptions): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = []
  for (const chunk of chunks) {
    const prev = out[out.length - 1]
    if (prev && chunk.text.length < opts.minChars && prev.text.length + chunk.text.length <= opts.maxChars) {
      prev.text = `${prev.text}\n\n${chunk.text}`
    } else {
      out.push({ ...chunk })
    }
  }
  return out
}
