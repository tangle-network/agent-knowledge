import { sha256 } from '../ids'
import { htmlToText } from './html'
import { politeFetch } from './http'
import type { FetchOpts, KnowledgeFragment, KnowledgeSource } from './types'

/**
 * Generic Secretary-of-State source.
 *
 * Every US state SOS surfaces LLC/Corp formation requirements differently
 * (CA via static forms pages, DE via division of corporations pages, TX
 * via SOSDirect content pages). Rather than baking 50 state-specific
 * parsers into this package, the source takes a config that names the URL
 * pattern + CSS-equivalent selector + jurisdiction tag. Callers supply one
 * config per state they need tracked.
 *
 * The selector is interpreted as a substring/regex of an HTML element id
 * or class — see `StateSosSourceConfig` for the contract. This is
 * intentionally minimal; richer extraction belongs in a state-specific
 * adapter the consumer authors.
 *
 * @experimental Interface will likely grow as we add more state coverage.
 */

export interface StateSosEntity {
  /** Stable id for this fragment within the state (e.g. 'llc-formation', 'corp-formation'). */
  id: string
  /** Path under the configured `baseUrl` for this entity. */
  path: string
  /**
   * Extraction selector. Choose one:
   *   - `{ kind: 'id', value: 'main-content' }` — innermost match of element with that id
   *   - `{ kind: 'class', value: 'field--name-body' }` — innermost match of element with that class
   *   - `{ kind: 'regex', value: /<article[\s\S]*?<\/article>/i }` — raw regex
   *   - `{ kind: 'whole' }` — full body, tags stripped (fallback for unstructured pages)
   */
  selector:
    | { kind: 'id'; value: string }
    | { kind: 'class'; value: string }
    | { kind: 'regex'; value: RegExp }
    | { kind: 'whole' }
  title: string
  /** Eval dimensions this entity feeds. */
  dimensionHints?: string[]
}

export interface StateSosSourceConfig {
  /** US state postal code, e.g. 'CA', 'DE', 'TX'. */
  state: string
  /** Base URL for the state SOS — e.g. 'https://www.sos.ca.gov'. */
  baseUrl: string
  /** Entities this state exposes (LLC, Corp, etc). */
  entities: StateSosEntity[]
  /** Source id; default `state-sos:<state>`. */
  id?: string
  /** Display name; default `<state> Secretary of State`. */
  name?: string
}

export function createStateSosSource(config: StateSosSourceConfig): KnowledgeSource {
  const id = config.id ?? `state-sos:${config.state.toLowerCase()}`
  const name = config.name ?? `${config.state} Secretary of State`
  return {
    id,
    name,
    description: `${config.state} Secretary of State filings and formation guidance pages.`,
    async fetch(opts: FetchOpts): Promise<KnowledgeFragment[]> {
      const limit = opts.limit ?? config.entities.length
      const entities = config.entities.slice(0, limit)
      const out: KnowledgeFragment[] = []
      for (const entity of entities) {
        out.push(await fetchEntity(id, config, entity, opts))
      }
      return out
    },
  }
}

async function fetchEntity(
  sourceId: string,
  config: StateSosSourceConfig,
  entity: StateSosEntity,
  opts: FetchOpts,
): Promise<KnowledgeFragment> {
  const url = joinUrl(config.baseUrl, entity.path)
  const response = await politeFetch(url, { signal: opts.signal, cacheDir: opts.cacheDir })

  const body = response.verifiable ? extractBySelector(response.body, entity.selector) : ''
  const verifiable = response.verifiable && body.length > 100

  return {
    id: entity.id,
    title: entity.title,
    body,
    bodyHash: sha256(body),
    provenance: {
      url,
      sourceUpdatedAt: response.sourceUpdatedAt,
      fetchedAt: response.fetchedAt,
      jurisdiction: `US-${config.state.toUpperCase()}`,
      verifiable,
      unverifiableReason:
        response.unverifiableReason ?? (verifiable ? undefined : 'extracted body too short'),
    },
    dimensionHints: entity.dimensionHints ?? [
      'jurisdictional_accuracy',
      'corporate_formation',
      'citation_hygiene',
    ],
    metadata: {
      sourceId,
      status: response.status,
      fromCache: response.fromCache,
      state: config.state,
    },
  }
}

function extractBySelector(html: string, selector: StateSosEntity['selector']): string {
  if (selector.kind === 'whole') {
    const main = /<main\b[\s\S]*?<\/main>/i.exec(html)?.[0]
    return htmlToText(main ?? html).slice(0, 200_000)
  }
  if (selector.kind === 'regex') {
    const m = selector.value.exec(html)?.[0]
    return m ? htmlToText(m).slice(0, 200_000) : ''
  }
  if (selector.kind === 'id') {
    const escaped = selector.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(
      `<([a-z][a-z0-9]*)\\b[^>]*\\sid=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
      'i',
    )
    const inner = pattern.exec(html)?.[2]
    return inner ? htmlToText(inner).slice(0, 200_000) : ''
  }
  const escaped = selector.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `<([a-z][a-z0-9]*)\\b[^>]*\\sclass=["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
    'i',
  )
  const inner = pattern.exec(html)?.[2]
  return inner ? htmlToText(inner).slice(0, 200_000) : ''
}

function joinUrl(base: string, path: string): string {
  try {
    return new URL(path, base.endsWith('/') ? base : `${base}/`).toString()
  } catch {
    return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
  }
}
