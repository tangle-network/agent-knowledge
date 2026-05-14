import { sha256 } from '../ids'
import { htmlToText } from './html'
import { politeFetch } from './http'
import type { FetchOpts, KnowledgeFragment, KnowledgeSource } from './types'

/**
 * IRS publications source.
 *
 * Two surfaces:
 *
 *   1. The publications index at https://www.irs.gov/publications enumerates
 *      every active publication with its revision year — a single fragment
 *      with the full table lets change detection notice when a publication
 *      year flips (e.g. Pub 15 (2025) → Pub 15 (2026)).
 *
 *   2. Individual publication landing pages at /publications/p<N>[<suffix>]
 *      return one fragment per publication with summary text. Callers list
 *      the publications they need tracked via `selectors`.
 *
 * Revenue procedures are fetched under their numbered URLs; the IRS does
 * not maintain a stable HTML index of rev-procs, so the caller passes the
 * specific rev-proc paths they care about.
 *
 * @stable
 */

const BASE_URL = 'https://www.irs.gov'
const INDEX_URL = `${BASE_URL}/publications`

export interface IrsPublicationsSourceOptions {
  /**
   * Specific publication slugs to fetch (e.g. `['p15', 'p17', 'p463']`).
   * When `includeIndex` is true (default), the publications index page is
   * also fetched as a single fragment so change detection can notice
   * year/revision shifts across the whole catalogue.
   */
  publications?: string[]
  /**
   * Revenue procedure paths to fetch (e.g. `['/irb/2024-31_IRB']`). The
   * caller passes the exact path; this source does not auto-discover.
   */
  revenueProcedures?: string[]
  includeIndex?: boolean
  id?: string
}

/** Default eval dimensions for IRS-sourced fragments. */
export const IRS_DIMENSION_HINTS = ['tax_compliance', 'regulatory_currency', 'citation_hygiene']

export function createIrsPublicationsSource(
  options: IrsPublicationsSourceOptions = {},
): KnowledgeSource {
  const id = options.id ?? 'irs-publications'
  const includeIndex = options.includeIndex ?? true
  return {
    id,
    name: 'IRS Publications',
    description:
      'Internal Revenue Service publications index and individual publication landing pages from irs.gov.',
    async fetch(opts: FetchOpts): Promise<KnowledgeFragment[]> {
      const out: KnowledgeFragment[] = []
      const limit = opts.limit ?? Number.POSITIVE_INFINITY

      if (includeIndex && out.length < limit) {
        out.push(await fetchIndex(id, opts))
      }
      for (const slug of options.publications ?? []) {
        if (out.length >= limit) break
        out.push(await fetchPublication(id, slug, opts))
      }
      for (const path of options.revenueProcedures ?? []) {
        if (out.length >= limit) break
        out.push(await fetchRevenueProcedure(id, path, opts))
      }
      return out
    },
  }
}

async function fetchIndex(sourceId: string, opts: FetchOpts): Promise<KnowledgeFragment> {
  const response = await politeFetch(INDEX_URL, { signal: opts.signal, cacheDir: opts.cacheDir })
  const tablePattern = /<table[\s\S]*?<\/table>/gi
  const matches = response.body.match(tablePattern) ?? []
  // Extract the table that lists current-year publications. IRS publishes
  // one table per year on the index; the most recent table is always the
  // first that mentions a year ≥ current.
  const tables = matches.map((t) => htmlToText(t))
  const body = tables
    .filter((t) => /Publication\s*\d+/i.test(t))
    .join('\n\n')
    .slice(0, 200_000)

  const verifiable = response.verifiable && body.length > 200
  return {
    id: 'index',
    title: 'IRS Publications Index',
    body,
    bodyHash: sha256(body),
    provenance: {
      url: INDEX_URL,
      sourceUpdatedAt: response.sourceUpdatedAt,
      fetchedAt: response.fetchedAt,
      jurisdiction: 'US-FED',
      verifiable,
      unverifiableReason:
        response.unverifiableReason ?? (verifiable ? undefined : 'no publication rows extracted'),
    },
    dimensionHints: IRS_DIMENSION_HINTS,
    metadata: { sourceId, status: response.status, fromCache: response.fromCache, kind: 'index' },
  }
}

async function fetchPublication(
  sourceId: string,
  slug: string,
  opts: FetchOpts,
): Promise<KnowledgeFragment> {
  const url = `${BASE_URL}/publications/${slug.replace(/^\/+/, '')}`
  const response = await politeFetch(url, { signal: opts.signal, cacheDir: opts.cacheDir })

  const title = extractTitle(response.body, `IRS Publication ${slug}`)
  const body = extractMainContent(response.body)
  const verifiable = response.verifiable && body.length > 200

  return {
    id: `publication:${slug}`,
    title,
    body,
    bodyHash: sha256(body),
    provenance: {
      url,
      sourceUpdatedAt: extractRevisionDate(response.body) ?? response.sourceUpdatedAt,
      fetchedAt: response.fetchedAt,
      jurisdiction: 'US-FED',
      verifiable,
      unverifiableReason:
        response.unverifiableReason ?? (verifiable ? undefined : 'no publication body extracted'),
    },
    dimensionHints: IRS_DIMENSION_HINTS,
    metadata: {
      sourceId,
      status: response.status,
      fromCache: response.fromCache,
      kind: 'publication',
      slug,
    },
  }
}

async function fetchRevenueProcedure(
  sourceId: string,
  path: string,
  opts: FetchOpts,
): Promise<KnowledgeFragment> {
  const url = `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`
  const response = await politeFetch(url, { signal: opts.signal, cacheDir: opts.cacheDir })
  const body = extractMainContent(response.body)
  const verifiable = response.verifiable && body.length > 200
  return {
    id: `rev-proc:${path}`,
    title: extractTitle(response.body, `IRS Revenue Procedure ${path}`),
    body,
    bodyHash: sha256(body),
    provenance: {
      url,
      sourceUpdatedAt: response.sourceUpdatedAt,
      fetchedAt: response.fetchedAt,
      jurisdiction: 'US-FED',
      verifiable,
      unverifiableReason:
        response.unverifiableReason ??
        (verifiable ? undefined : 'no revenue-procedure body extracted'),
    },
    dimensionHints: [...IRS_DIMENSION_HINTS, 'procedural_currency'],
    metadata: {
      sourceId,
      status: response.status,
      fromCache: response.fromCache,
      kind: 'rev-proc',
      path,
    },
  }
}

function extractTitle(html: string, fallback: string): string {
  const og = /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i.exec(html)?.[1]
  if (og) return decodeHtml(og)
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  if (title) return htmlToText(title).split(' | ')[0] ?? fallback
  return fallback
}

function extractMainContent(html: string): string {
  // IRS uses Drupal — the main publication body is inside <main role="main">
  // or under .field--name-body. We try main first; on miss, body.
  const main = /<main\b[\s\S]*?<\/main>/i.exec(html)?.[0]
  if (main) {
    const noNav = main
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    return htmlToText(noNav).slice(0, 200_000)
  }
  const body = /<body\b[\s\S]*?<\/body>/i.exec(html)?.[0]
  return body ? htmlToText(body).slice(0, 200_000) : htmlToText(html).slice(0, 200_000)
}

function extractRevisionDate(html: string): string | undefined {
  // IRS publication pages typically show "Publication X (YYYY)" in the title;
  // pulling the year gives a stable revision marker.
  const m = /Publication\s+\S+\s*\((\d{4})\)/i.exec(html)
  if (m?.[1]) {
    const year = Number.parseInt(m[1], 10)
    if (Number.isFinite(year) && year >= 2000 && year <= new Date().getUTCFullYear() + 1) {
      return new Date(Date.UTC(year, 0, 1)).toISOString()
    }
  }
  return undefined
}

function decodeHtml(value: string): string {
  return htmlToText(value)
}
