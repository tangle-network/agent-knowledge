/**
 * Minimal HTML helpers used by the shipped sources.
 *
 * Deliberately not a full DOM parser: every authority we ship against
 * (Cornell LII, IRS.gov, state SOS portals) has well-behaved server-rendered
 * HTML where regex-based extraction is correct and cheap. Bringing in cheerio
 * would add a 1.5MB dependency to a package whose purpose is shipping
 * primitives, not parsing arbitrary web pages.
 *
 * If a future source needs real DOM traversal, it should depend on its own
 * parser locally rather than promoting one into the package-wide deps.
 *
 * @stable
 */

/**
 * Strip HTML tags, collapse whitespace, decode common entities.
 *
 * Preserves paragraph and line breaks (`</p>`, `<br>`, `</li>`, `</div>`,
 * `</h*>`) as `\n` so statute text retains its subsection structure.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--([\s\S]*?)-->/g, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div|tr|h[1-6]|blockquote|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&sect;/gi, '§')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .split('\n')
    .map((line) => line.replace(/[\t  ]+/g, ' ').trim())
    .filter((line, idx, all) => !(line === '' && all[idx - 1] === ''))
    .join('\n')
    .trim()
}

/** Extract the first match of a regex's first capture group, or undefined. */
export function firstMatch(html: string, pattern: RegExp): string | undefined {
  return pattern.exec(html)?.[1]?.trim()
}

/** Extract the inner HTML of the first matching tag with id `id`. */
export function innerHtmlById(html: string, id: string): string | undefined {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tagPattern = new RegExp(
    `<([a-z][a-z0-9]*)\\b[^>]*\\sid=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
    'i',
  )
  return tagPattern.exec(html)?.[2]
}

/**
 * Extract every (href, text) pair matching the URL regex.
 * Returns absolute URLs by resolving against `baseUrl`.
 */
export function extractLinks(
  html: string,
  hrefPattern: RegExp,
  baseUrl: string,
): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = []
  const anchor = /<a\b[^>]*\shref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  for (const match of html.matchAll(anchor)) {
    const href = match[1]
    const inner = match[2]
    if (!href || !inner) continue
    if (!hrefPattern.test(href)) continue
    const text = htmlToText(inner)
    if (!text) continue
    try {
      out.push({ href: new URL(href, baseUrl).toString(), text })
    } catch {
      /* skip malformed URL */
    }
  }
  return out
}
