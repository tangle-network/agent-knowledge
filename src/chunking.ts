export interface ChunkingOptions {
  targetChars: number
  maxChars: number
  minChars: number
  overlapChars: number
  /** Opt in to bounded, overlapping source slices for long paragraphs. Defaults to false. */
  splitOversized?: boolean
}

export interface KnowledgeChunk {
  index: number
  text: string
  headingPath: string
  /** UTF-16 offsets into the original, unnormalized source. */
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

export function chunkMarkdown(
  content: string,
  options?: Partial<ChunkingOptions>,
): KnowledgeChunk[] {
  const opts = normalizeOptions({ ...DEFAULT_OPTIONS, ...(options ?? {}) })
  const { body, bodyOffset } = stripFrontmatter(content)
  if (body.trim() === '') return []

  const originalOffset = sourceOffsetMapper(content)
  const sections = splitSections(body, bodyOffset)
  const chunks: KnowledgeChunk[] = []
  for (const section of sections) {
    for (const part of chunkText(section.text, opts)) {
      const normalizedStart = section.start + part.start
      const start = originalOffset(normalizedStart)
      const end = originalOffset(normalizedStart + part.text.length)
      const intervals: Array<[number, number]> = opts.splitOversized
        ? boundedSourceIntervals(content, start, end, opts.maxChars, opts.overlapChars)
        : [[start, end]]
      for (const [charStart, charEnd] of intervals) {
        const text = content.slice(charStart, charEnd)
        chunks.push({
          index: chunks.length,
          text,
          headingPath: section.headingPath,
          charStart,
          charEnd,
          oversized: text.length > opts.maxChars,
        })
      }
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

/** Translate normalized parsing coordinates back to the original UTF-16 source. */
function sourceOffsetMapper(content: string): (offset: number) => number {
  const removedAt: number[] = []
  for (const match of content.matchAll(/\r\n/g)) {
    removedAt.push(match.index - removedAt.length + 1)
  }
  return (offset) => {
    let low = 0
    let high = removedAt.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (removedAt[middle]! <= offset) low = middle + 1
      else high = middle
    }
    return offset + low
  }
}

/** Bounded mode alone splits indivisible paragraphs. Never synthesize source text. */
function boundedSourceIntervals(
  source: string,
  start: number,
  end: number,
  maximum: number,
  overlap: number,
): Array<[number, number]> {
  const intervals: Array<[number, number]> = []
  const safeBoundary = (at: number) => {
    const previous = source.charCodeAt(at - 1)
    const next = source.charCodeAt(at)
    return (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) ||
      (source[at - 1] === '\r' && source[at] === '\n')
      ? at - 1
      : at
  }
  let cursor = safeBoundary(start)
  while (cursor < end) {
    let stop = Math.min(end, cursor + maximum)
    if (stop < end) {
      stop = safeBoundary(stop)
      const floor = cursor + Math.floor(maximum / 2)
      for (let at = stop - 1; at >= floor; at--) {
        if (/\s/u.test(source[at]!)) {
          stop = safeBoundary(at + 1)
          break
        }
      }
    }
    if (stop <= cursor) throw new Error('Chunk budget cannot hold an atomic source character')
    intervals.push([cursor, stop])
    if (stop === end) break
    const next = safeBoundary(stop - overlap)
    cursor = next > cursor ? next : stop
  }
  return intervals
}

function normalizeOptions(opts: ChunkingOptions): ChunkingOptions {
  if (opts.splitOversized) {
    if (
      ![opts.targetChars, opts.maxChars, opts.minChars, opts.overlapChars].every(
        Number.isSafeInteger,
      ) ||
      opts.targetChars < 2 ||
      opts.maxChars < 2 ||
      opts.minChars < 0 ||
      opts.overlapChars < 0
    ) {
      throw new Error(
        'Bounded chunks require integer budgets of at least two characters and nonnegative overlap',
      )
    }
  }
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
  let current: { lines: string[]; start: number; headingPath: string } = {
    lines: [],
    start: bodyOffset,
    headingPath: '',
  }
  let cursor = bodyOffset
  let fence: string | null = null

  const flush = () => {
    const text = current.lines.join('\n')
    if (text.trim() !== '')
      sections.push({ text, start: current.start, headingPath: current.headingPath })
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
  return mergeTinyChunks(chunks, opts, text)
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

function mergeTinyChunks(
  chunks: Array<{ text: string; start: number }>,
  opts: ChunkingOptions,
  source: string,
): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = []
  for (const chunk of chunks) {
    const prev = out[out.length - 1]
    const end = chunk.start + chunk.text.length
    if (
      prev &&
      chunk.text.length < opts.minChars &&
      Math.max(prev.start + prev.text.length, end) - prev.start <= opts.maxChars
    ) {
      // Merge intervals, not strings with duplicated overlap or artificial separators.
      prev.text = source.slice(prev.start, Math.max(prev.start + prev.text.length, end))
    } else {
      out.push({ ...chunk })
    }
  }
  return out
}
