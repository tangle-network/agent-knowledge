export const WIKILINK_REGEX = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g

export function extractWikilinks(content: string): string[] {
  const links: string[] = []
  const regex = new RegExp(WIKILINK_REGEX.source, 'g')
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1]!.trim())
  }
  return [...new Set(links)]
}

export function normalizeLinkTarget(target: string): string {
  return target.trim().replace(/\.md$/i, '').toLowerCase().replace(/\s+/g, '-')
}
