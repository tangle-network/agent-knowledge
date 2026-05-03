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
      const items: string[] = []
      while (i + 1 < lines.length) {
        const item = /^\s*-\s*(.+?)\s*$/.exec(lines[i + 1]!)
        if (!item) break
        items.push(unquote(item[1]!))
        i++
      }
      out[key] = items
      continue
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      out[key] = rest.slice(1, -1).split(',').map((part) => unquote(part.trim())).filter(Boolean)
    } else if (rest === 'true' || rest === 'false') {
      out[key] = rest === 'true'
    } else if (/^-?\d+(?:\.\d+)?$/.test(rest)) {
      out[key] = Number(rest)
    } else {
      out[key] = unquote(rest)
    }
  }
  return out
}

function formatYamlField(key: string, value: unknown): string[] {
  if (Array.isArray(value)) {
    return [key + ':', ...value.map((item) => `  - ${String(item)}`)]
  }
  if (typeof value === 'string') return [`${key}: ${value}`]
  if (typeof value === 'number' || typeof value === 'boolean') return [`${key}: ${String(value)}`]
  return [`${key}: ${JSON.stringify(value)}`]
}

function unquote(value: string): string {
  return value.replace(/^['"]|['"]$/g, '')
}
