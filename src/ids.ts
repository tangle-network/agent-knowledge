import { createHash } from 'node:crypto'

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function slugify(input: string): string {
  const out = input
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return out || 'untitled'
}

export function stableId(prefix: string, content: string): string {
  return `${prefix}_${sha256(content).slice(0, 16)}`
}

/** Canonical registry id for exact text submitted at one original URI. */
export function textSourceId(uri: string, contentHash: string): string {
  return stableId('src', `${contentHash}:${uri}`)
}
