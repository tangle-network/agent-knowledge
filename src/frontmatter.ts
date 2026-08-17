export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>
  body: string
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
  const normalized = content.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { frontmatter: {}, body: normalized }
  const end = normalized.indexOf('\n---', 4)
  if (end < 0) return { frontmatter: {}, body: normalized }
  const raw = normalized.slice(4, end)
  const after = normalized.slice(end).replace(/^\n---\s*\n?/, '')
  return { frontmatter: parseSimpleYaml(raw), body: after }
}

export function formatFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  const lines = Object.entries(frontmatter)
    .filter(([, value]) => value !== undefined)
    .flatMap(([key, value]) => formatYamlField(key, value))
  if (lines.length === 0) return body
  return `---\n${lines.join('\n')}\n---\n${body.replace(/^\n+/, '')}`
}

function parseSimpleYaml(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const scalar = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!scalar) continue
    const key = scalar[1]!
    const rest = scalar[2]!.trim()
    if (rest === '') {
      const items: unknown[] = []
      while (i + 1 < lines.length) {
        const item = /^\s*-\s*(.+?)\s*$/.exec(lines[i + 1]!)
        if (!item) break
        items.push(parseYamlScalar(item[1]!))
        i++
      }
      out[key] = items
      continue
    }
    out[key] = parseYamlScalar(rest)
  }
  return out
}

function parseYamlScalar(value: string): unknown {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
  ) {
    try {
      return JSON.parse(trimmed)
    } catch {
      // The accepted frontmatter syntax predates JSON-aware parsing. Keep reading
      // non-JSON quoted and bracketed values with the original scalar rules.
    }
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((part) => unquote(part.trim()))
      .filter(Boolean)
  }
  if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true'
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed)
  return unquote(trimmed)
}

function formatYamlField(key: string, value: unknown): string[] {
  if (Array.isArray(value)) {
    return [`${key}:`, ...value.map((item) => `  - ${formatYamlScalar(item)}`)]
  }
  return [`${key}: ${formatYamlScalar(value)}`]
}

function formatYamlScalar(value: unknown): string {
  if (typeof value === 'string') {
    return stringNeedsJsonEncoding(value) ? JSON.stringify(value) : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const encoded = JSON.stringify(value)
  if (encoded === undefined) {
    throw new TypeError(`frontmatter value of type ${typeof value} is not JSON-serializable`)
  }
  return encoded
}

function stringNeedsJsonEncoding(value: string): boolean {
  if (value.length === 0 || value !== value.trim()) return true
  if (value.includes('\n') || value.includes('\r')) return true
  if (value === 'true' || value === 'false' || /^-?\d+(?:\.\d+)?$/.test(value)) return true
  return /^[\[\{"']/.test(value) || /["']$/.test(value)
}

function unquote(value: string): string {
  return value.replace(/^['"]|['"]$/g, '')
}
