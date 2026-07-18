/**
 * Pluggable knowledge source contract.
 *
 * A `KnowledgeSource` is one external provider of authoritative content that
 * an agent's knowledge base should track over time (e.g. Cornell LII US Code,
 * IRS publications, a state secretary-of-state filing portal). It returns
 * hashable, embed-ready `KnowledgeFragment`s plus enough provenance metadata
 * for downstream consumers to:
 *
 *   1. detect change against a previous snapshot (see `./changes`)
 *   2. score freshness on a per-source-id basis (see `./freshness`)
 *   3. decide which evals to re-run when the underlying authority moves
 *      (the `dimensionHints` field is the binding contract for that decision)
 *
 * Sources MUST be pure with respect to local filesystem state outside the
 * cache directory the caller hands them — they read remote authorities and
 * return data. They MUST mark `verifiable: false` on any fragment they could
 * not fetch and extract (block page, 4xx, parse failure) rather than silently
 * substituting empty or partial content. The control loop downstream uses
 * `verifiable` to refuse promotion of unusable content.
 *
 * @stable
 */

/**
 * Per-fetch options the host (control loop / cron / CLI) passes in.
 *
 * `signal` lets the host abort long-running fetches (rate-limited authority,
 * congested network). `cacheDir` is where the source SHOULD write its disk
 * cache; an undefined value disables caching (useful in tests). `now` is
 * injected for deterministic tests of change-detection windows.
 */
export interface FetchOpts {
  /** Abort signal forwarded to the underlying HTTP fetcher. */
  signal?: AbortSignal
  /** Absolute path under which the source may cache raw bytes. */
  cacheDir?: string
  /** Clock injection for deterministic tests. */
  now?: () => Date
  /**
   * Maximum number of authority pages the source should fetch in this call.
   * Sources MUST respect this bound — exhaustively crawling Cornell LII on
   * every cron tick would be both rude and slow. Default is source-specific.
   */
  limit?: number
  /**
   * Source-specific selector string. Examples:
   *   - cornell-lii: `'uscode/text/18/1836'` or `'wex/non-compete'`
   *   - irs-publications: `'index'` or `'p15'`
   *   - state-sos: opaque, see `StateSosSourceConfig`
   *
   * Sources that don't need a selector ignore this field.
   */
  selector?: string
}

/**
 * The standard provenance shape every fragment carries. Kept separate from
 * `KnowledgeFragment` so freshness/change code can pass it around without
 * also dragging the body text.
 */
export interface FragmentProvenance {
  /** Canonical URL the fragment was extracted from. */
  url: string
  /**
   * Source-attested timestamp: the time the AUTHORITY last updated this
   * content, as reported by the source (Last-Modified header, in-page
   * effective date, registry generated-at, etc). Falls back to the fetch
   * time only when the authority publishes no timestamp.
   */
  sourceUpdatedAt: string
  /** ISO timestamp the fragment was fetched. */
  fetchedAt: string
  /**
   * Jurisdiction the content is binding within, if applicable. Use ISO
   * country code, US state abbreviation, or 'US-FED' for federal scope.
   * Statute sources MUST populate this; reference / encyclopedia sources
   * MAY leave it undefined.
   */
  jurisdiction?: string
  /**
   * True iff the configured URL returned an acceptable response and the
   * expected content was extracted. False on a block page, rate-limit
   * response, 4xx/5xx, or selector miss. This is not publisher authentication
   * or cryptographic content verification. Consumers MUST refuse to promote
   * `verifiable: false` fragments into citable knowledge.
   */
  verifiable: boolean
  /** If `verifiable === false`, the reason — surfaced to operators. */
  unverifiableReason?: string
}

/**
 * One unit of authoritative content. Stable hash on `(id, body)` lets change
 * detection reason about identity across snapshots.
 */
export interface KnowledgeFragment {
  /**
   * Stable identity within (sourceId, selector-space). Two fetches against
   * the same authority section MUST produce the same `id`. The (sourceId,
   * id) pair is the primary key for change detection.
   */
  id: string
  /** Free-form title — section heading, publication name, etc. */
  title: string
  /** Body text, normalised: no HTML tags, line breaks preserved. */
  body: string
  /** SHA-256 of `body`. Pre-computed so consumers don't re-hash on diff. */
  bodyHash: string
  provenance: FragmentProvenance
  /**
   * Eval dimensions an agent-eval campaign should re-score when this
   * fragment changes. Examples: `citation_hygiene`, `jurisdictional_accuracy`,
   * `tax_compliance`, `regulatory_currency`. The eval cron treats this as a
   * set, not a contract — adding a new dimension is non-breaking.
   *
   * This is the load-bearing field for the continuous-ingestion story: a
   * Ryan-LLC-style ruling vacates the FTC non-compete rule → the source
   * returns a fragment with `jurisdictional_accuracy` in this list →
   * `detectChanges()` emits a `KnowledgeChange` carrying that hint → the
   * cron knows exactly which agent-eval campaigns to re-run.
   */
  dimensionHints: string[]
  /** Arbitrary source-specific metadata for debugging / connector wiring. */
  metadata?: Record<string, unknown>
}

/**
 * One pluggable knowledge source.
 *
 * Implementations: see `./cornell-lii`, `./irs-publications`, `./state-sos`.
 * To author a new source, follow the same shape and register it in your
 * application's source list — there is no global registry by design (per
 * the per-tenant isolation contract; see README).
 */
export interface KnowledgeSource {
  /** Stable id — used to key freshness state. MUST NOT change once shipped. */
  id: string
  /** Human-readable name for dashboards. */
  name: string
  /** One-sentence description: what authority + scope. */
  description: string
  /**
   * Pull fragments for this source. Sources MUST:
   *   - rate-limit themselves (>=1 req/sec per source by convention)
   *   - send a polite User-Agent
   *   - cache to disk when `opts.cacheDir` is set
   *   - mark `verifiable: false` rather than throwing on parse/block
   *   - honour `opts.signal`
   *   - honour `opts.limit`
   */
  fetch(opts: FetchOpts): Promise<KnowledgeFragment[]>
}
