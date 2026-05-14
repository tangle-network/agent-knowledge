import { sha256 } from '../ids'
import { htmlToText, innerHtmlById } from './html'
import { politeFetch } from './http'
import type { FetchOpts, KnowledgeFragment, KnowledgeSource } from './types'

/**
 * Cornell Legal Information Institute (LII) source.
 *
 * Pulls federal US Code sections and Wex encyclopedia entries — the two
 * Cornell LII surfaces an agent typically grounds against. The Wex
 * "non-compete" page is the canonical test case for the Ryan-LLC v. FTC
 * vacatur drift the continuous-ingestion story is designed to catch.
 *
 * @stable
 */

const BASE_URL = 'https://www.law.cornell.edu'

export interface CornellLiiSelector {
  /** Either 'uscode' or 'wex'. */
  kind: 'uscode' | 'wex'
  /**
   * For `uscode`: `<title>/<section>` (e.g. `'18/1836'` for DTSA).
   * For `wex`: the slug (e.g. `'non-compete'`).
   */
  path: string
  /**
   * Optional pre-declared eval dimensions affected by this section. If
   * omitted, defaults are chosen from `kind` + path heuristics.
   */
  dimensionHints?: string[]
}

export interface CornellLiiSourceOptions {
  /**
   * Selectors to fetch on each `fetch()` call. The caller (a per-tenant
   * workspace config, typically) lists exactly the authorities they need
   * tracked. There is no auto-discovery; that would crawl Cornell at
   * cron speed, which is what the polite-fetch contract exists to avoid.
   */
  selectors: CornellLiiSelector[]
  /** Source id override; default is `'cornell-lii'`. */
  id?: string
}

/**
 * Build a Cornell LII source for the listed selectors.
 *
 * Example: track DTSA + non-compete:
 * ```
 * createCornellLiiSource({
 *   selectors: [
 *     { kind: 'uscode', path: '18/1836' },
 *     { kind: 'wex', path: 'non-compete', dimensionHints: ['jurisdictional_accuracy'] },
 *   ],
 * })
 * ```
 */
export function createCornellLiiSource(options: CornellLiiSourceOptions): KnowledgeSource {
  const id = options.id ?? 'cornell-lii'
  return {
    id,
    name: 'Cornell Legal Information Institute',
    description:
      'Federal US Code sections (uscode/text/...) and Wex legal encyclopedia entries from law.cornell.edu.',
    async fetch(opts: FetchOpts): Promise<KnowledgeFragment[]> {
      const limit = opts.limit ?? options.selectors.length
      const selectors = options.selectors.slice(0, limit)
      const out: KnowledgeFragment[] = []
      for (const selector of selectors) {
        out.push(await fetchOne(id, selector, opts))
      }
      return out
    },
  }
}

async function fetchOne(
  sourceId: string,
  selector: CornellLiiSelector,
  opts: FetchOpts,
): Promise<KnowledgeFragment> {
  const path = selector.path.replace(/^\/+/, '')
  const url =
    selector.kind === 'uscode' ? `${BASE_URL}/uscode/text/${path}` : `${BASE_URL}/wex/${path}`

  const response = await politeFetch(url, {
    signal: opts.signal,
    cacheDir: opts.cacheDir,
  })

  const fragmentId = `${selector.kind}:${selector.path}`
  const dimensionHints = selector.dimensionHints ?? defaultDimensionHints(selector)

  if (!response.verifiable) {
    return {
      id: fragmentId,
      title: `Cornell LII ${selector.kind} ${selector.path}`,
      body: '',
      bodyHash: sha256(''),
      provenance: {
        url,
        sourceUpdatedAt: response.sourceUpdatedAt,
        fetchedAt: response.fetchedAt,
        jurisdiction: 'US-FED',
        verifiable: false,
        unverifiableReason: response.unverifiableReason,
      },
      dimensionHints,
      metadata: { sourceId, status: response.status, fromCache: response.fromCache },
    }
  }

  const html = response.body
  const title = extractTitle(html, selector)
  const body = extractBody(html, selector)
  const effective = extractEffectiveDate(html) ?? response.sourceUpdatedAt

  const verifiable = body.length > 50
  return {
    id: fragmentId,
    title,
    body,
    bodyHash: sha256(body),
    provenance: {
      url,
      sourceUpdatedAt: effective,
      fetchedAt: response.fetchedAt,
      jurisdiction: 'US-FED',
      verifiable,
      unverifiableReason: verifiable ? undefined : 'extracted body too short',
    },
    dimensionHints,
    metadata: { sourceId, status: response.status, fromCache: response.fromCache },
  }
}

function extractTitle(html: string, selector: CornellLiiSelector): string {
  const h1 = /<h1[^>]*\bid=["']page_title["'][^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]
  if (h1) return htmlToText(h1)
  const t = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  if (t) return htmlToText(t).split(' | ')[0] ?? `Cornell LII ${selector.path}`
  return `Cornell LII ${selector.kind} ${selector.path}`
}

function extractBody(html: string, selector: CornellLiiSelector): string {
  if (selector.kind === 'uscode') {
    // The statute text lives inside a <text><div class="text">…</div></text>
    // block on US Code section pages. Prefer it; fall back to #tab_default_1
    // which always contains the section body.
    const text = /<text>([\s\S]*?)<\/text>/i.exec(html)?.[1]
    if (text) return htmlToText(text)
    const tab = innerHtmlById(html, 'tab_default_1')
    if (tab) return htmlToText(tab)
  }
  // Wex pages wrap the encyclopedia entry under <div id="main-content"> (newer
  // Drupal template) or directly inside <div id="extracted-content"> (older
  // template). Try both — lazy regex matching against a nested-div container
  // returns the wrong (shorter) slice, so we anchor on the leaf containers.
  const mainContent = innerHtmlById(html, 'main-content')
  if (mainContent) {
    return htmlToText(mainContent.replace(/<h1[\s\S]*?<\/h1>/i, ''))
  }
  const extracted = innerHtmlById(html, 'extracted-content')
  if (extracted) {
    return htmlToText(extracted.replace(/<h1[\s\S]*?<\/h1>/i, ''))
  }
  return htmlToText(html)
}

function extractEffectiveDate(html: string): string | undefined {
  // Cornell LII includes "Editorial Notes" / "Amendments" blocks with
  // dates; the most reliable machine-readable signal is the last
  // amendment year embedded near the section text.
  const amend = /Amendments[\s\S]{0,200}?(\d{4})/i.exec(html)?.[1]
  if (amend) {
    const y = Number.parseInt(amend, 10)
    if (Number.isFinite(y) && y > 1900 && y <= new Date().getUTCFullYear() + 1) {
      return new Date(Date.UTC(y, 11, 31)).toISOString()
    }
  }
  return undefined
}

function defaultDimensionHints(selector: CornellLiiSelector): string[] {
  if (selector.kind === 'uscode') return ['jurisdictional_accuracy', 'citation_hygiene']
  return ['citation_hygiene']
}
