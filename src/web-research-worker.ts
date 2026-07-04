/**
 * Real web-research worker + verifying driver for `runVerifiedResearchLoop`.
 *
 * This is the GENERAL, any-topic implementation behind the two-agent research
 * loop's live arm. Given the open knowledge gaps the readiness gate surfaces,
 * the worker:
 *
 *   1. asks an LLM (glm-5.2 by default) to turn each gap into focused web
 *      search queries,
 *   2. runs a REAL web search over the Tangle router (`POST /v1/search` — the
 *      same endpoint `tcloud mcp`'s `web_search` tool forwards to), so there is
 *      no hardcoded corpus,
 *   3. fetches the top results with the repo's polite, cached `politeFetch` and
 *      reduces each page to text with `htmlToText`,
 *   4. proposes the readable, verifiable pages as `ResearchSourceProposal`s plus
 *      a `buildPages` that writes citing `knowledge/*.md` pages from the sources
 *      the driver accepts.
 *
 * The verifying DRIVER is the differentiated role from the two-agent loop: a
 * second LLM pass that judges each fetched source's on-topic relevance to the
 * goal + open gaps and rejects off-topic / spam / already-covered material. The
 * worker ADDS; the driver GATES. Together they build a cleaner knowledge base
 * than a single agent at the same compute budget.
 *
 * Dependency-free on purpose: it talks to the router over `fetch` directly with
 * the published OpenAI-compatible chat shape and the `/v1/search` shape, so it
 * works whether or not the `tcloud` CLI is installed. Point it at any router by
 * passing `baseUrl`; supply the key via `apiKey` or `TANGLE_API_KEY`.
 */

import { htmlToText } from './sources/html'
import { politeFetch } from './sources/http'
import type {
  KnowledgeGap,
  ResearchContribution,
  ResearchDriver,
  ResearchSourceProposal,
  ResearchWorker,
  SourceVerdict,
  SourceVerificationContext,
  WorkerResearchContext,
} from './two-agent-research-loop'
import type { SourceRecord } from './types'

/** Default router model. Plain id (no namespace) — see CLAUDE/creds notes. */
const DEFAULT_MODEL = 'glm-5.2'
/** Default router base. */
const DEFAULT_BASE_URL = 'https://router.tangle.tools/v1'
/**
 * glm-5.2 spends its first tokens on hidden `reasoning_content`; below ~1200
 * output tokens it returns EMPTY visible content. Floor every call so a
 * reasoning model never silently yields nothing. (Verified creds note.)
 */
const MIN_MAX_TOKENS = 1200

/** One live web result, as the router's `/v1/search` returns it. */
export interface WebSearchHit {
  title: string
  url: string
  snippet?: string
}

/**
 * The two router capabilities the worker/driver need. Injectable so tests can
 * stub the network; the default talks to the live Tangle router over `fetch`.
 */
export interface RouterClient {
  /** Live web search — returns title/url/snippet hits. */
  search(query: string, opts?: { maxResults?: number }): Promise<WebSearchHit[]>
  /** Chat completion — returns the assistant message's visible text. */
  chat(
    messages: { role: 'system' | 'user'; content: string }[],
    maxTokens?: number,
  ): Promise<string>
  /** Cumulative cost (chat + search) since this client was created. */
  usage(): RouterUsage
}

/**
 * Cumulative router cost — the per-arm signal the A/B reports ALONGSIDE quality,
 * so "2.3 fewer sources" can be read against the token/$/latency it cost. A
 * two-agent round is one worker pass plus N `verifySource` LLM calls; counting
 * each call here is what surfaces that the two-agent loop spends more inference
 * than its "equal passes" budget implies.
 */
export interface RouterUsage {
  chatCalls: number
  searchCalls: number
  promptTokens: number
  completionTokens: number
  usd: number
  wallMs: number
}

export interface TangleRouterOptions {
  /** Router base URL. Defaults to `https://router.tangle.tools/v1`. */
  baseUrl?: string
  /** Bearer key. Defaults to `process.env.TANGLE_API_KEY`. */
  apiKey?: string
  /** Chat model id. Defaults to `glm-5.2`. */
  model?: string
  /** Optional preferred search provider (exa | you | perplexity | …). */
  searchProvider?: string
  /**
   * Retries on a TRANSIENT upstream status (502/503/504/429) with exponential
   * backoff. Default 4. A 4xx that isn't 429, and a 401, are NOT retried — those
   * are not transient. After the budget is exhausted the call still fails loud
   * with the original `RouterError`, so the fail-closed contract holds; this only
   * stops a single upstream-capacity blip from voiding a whole multi-topic run.
   */
  maxRetries?: number
  /** Base backoff in ms (doubled each retry, ±25% jitter). Default 1500. */
  retryBaseMs?: number
  signal?: AbortSignal
}

/** Transient upstream statuses worth a retry (capacity / rate-limit / gateway). */
const transientStatuses = new Set([429, 502, 503, 504])

/**
 * POST with bounded exponential backoff on transient upstream statuses. Returns
 * the first `res.ok` response, or the LAST response (so the caller throws the
 * real status). A non-transient failure returns immediately — only 502/503/504/
 * 429 are retried. Aborts propagate at once.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { maxRetries: number; retryBaseMs: number; signal?: AbortSignal },
): Promise<Response> {
  let lastRes: Response | undefined
  for (let attempt = 0; attempt <= opts.maxRetries; attempt += 1) {
    if (opts.signal?.aborted) throw new RouterError(0, 'aborted')
    const res = await fetch(url, init)
    if (res.ok || !transientStatuses.has(res.status)) return res
    lastRes = res
    if (attempt === opts.maxRetries) break
    // Drain the body so the socket frees before we wait.
    await res.text().catch(() => '')
    const backoff = opts.retryBaseMs * 2 ** attempt
    const jitter = backoff * (0.75 + Math.random() * 0.5)
    await new Promise((resolve) => setTimeout(resolve, jitter))
  }
  // Exhausted: hand back the last transient response so the caller fails loud
  // with its real status.
  if (lastRes) return lastRes
  throw new RouterError(0, 'fetchWithRetry produced no response')
}

/** A small error so a failed router call fails loud rather than returning junk. */
export class RouterError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`router ${status}: ${message}`)
    this.name = 'RouterError'
  }
}

/**
 * Build a dependency-free Tangle router client over `fetch`. This is the same
 * wire surface the `tcloud` SDK + `tcloud mcp` use (`/v1/search` for web search,
 * `/v1/chat/completions` for chat) so it needs no CLI installed.
 */
export function createTangleRouterClient(options: TangleRouterOptions = {}): RouterClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const apiKey = options.apiKey ?? process.env.TANGLE_API_KEY
  if (!apiKey) {
    throw new RouterError(401, 'no TANGLE_API_KEY (pass apiKey or set the env var)')
  }
  const model = options.model ?? DEFAULT_MODEL
  const maxRetries = Math.max(0, options.maxRetries ?? 4)
  const retryBaseMs = Math.max(1, options.retryBaseMs ?? 1500)
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }

  // glm-5.2 pricing (USD per token) + a cumulative accumulator. Read via usage().
  const price = { prompt: 0.95 / 1_000_000, completion: 3.0 / 1_000_000 }
  const acc: RouterUsage = {
    chatCalls: 0,
    searchCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    usd: 0,
    wallMs: 0,
  }

  return {
    async search(query, opts) {
      const t0 = Date.now()
      const res = await fetchWithRetry(
        `${baseUrl}/search`,
        {
          method: 'POST',
          headers,
          signal: options.signal,
          body: JSON.stringify({
            query,
            ...(options.searchProvider ? { provider: options.searchProvider } : {}),
            ...(opts?.maxResults != null ? { maxResults: opts.maxResults } : {}),
          }),
        },
        { maxRetries, retryBaseMs, signal: options.signal },
      )
      acc.searchCalls += 1
      acc.wallMs += Date.now() - t0
      if (!res.ok) {
        throw new RouterError(res.status, await res.text().catch(() => res.statusText))
      }
      const body = (await res.json()) as { data?: WebSearchHit[] }
      return (body.data ?? [])
        .filter((hit) => typeof hit?.url === 'string' && hit.url.length > 0)
        .map((hit) => ({ title: hit.title ?? hit.url, url: hit.url, snippet: hit.snippet }))
    },
    async chat(messages, maxTokens) {
      // Reasoning-model floor: never let glm-5.2 spend the whole budget on
      // hidden reasoning and return empty visible content.
      const max_tokens = Math.max(MIN_MAX_TOKENS, maxTokens ?? MIN_MAX_TOKENS)
      const t0 = Date.now()
      const res = await fetchWithRetry(
        `${baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers,
          signal: options.signal,
          body: JSON.stringify({ model, messages, max_tokens, temperature: 0.2, stream: false }),
        },
        { maxRetries, retryBaseMs, signal: options.signal },
      )
      if (!res.ok) {
        throw new RouterError(res.status, await res.text().catch(() => res.statusText))
      }
      const body = (await res.json()) as {
        choices?: { message?: { content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const promptTokens = body.usage?.prompt_tokens ?? 0
      const completionTokens = body.usage?.completion_tokens ?? 0
      acc.chatCalls += 1
      acc.promptTokens += promptTokens
      acc.completionTokens += completionTokens
      acc.usd += promptTokens * price.prompt + completionTokens * price.completion
      acc.wallMs += Date.now() - t0
      return body.choices?.[0]?.message?.content ?? ''
    },
    usage() {
      return { ...acc }
    },
  }
}

export interface WebResearchWorkerOptions {
  /** Router client. Defaults to a live Tangle router client from env creds. */
  router?: RouterClient
  router_options?: TangleRouterOptions
  /** Max search queries the LLM may form per gap. Default 2. */
  queriesPerGap?: number
  /** Max web results fetched per query. Default 3. */
  resultsPerQuery?: number
  /** Hard cap on sources proposed per round (across all gaps). Default 6. */
  maxSourcesPerRound?: number
  /** Disk cache dir for `politeFetch`. Optional; speeds repeat runs. */
  cacheDir?: string
  /** Minimum readable text length to keep a fetched page. Default 200. */
  minTextChars?: number
  /** Max chars of page text stored per source (keeps pages bounded). Default 4000. */
  maxTextChars?: number
}

/** Resolve the router client lazily so a worker with an injected client never reads env. */
function resolveRouter(opts: {
  router?: RouterClient
  router_options?: TangleRouterOptions
}): RouterClient {
  return opts.router ?? createTangleRouterClient(opts.router_options)
}

/**
 * The real web-research worker. Conforms to the loop's `ResearchWorker`
 * contract: given the open gaps, it returns the sources it found plus a
 * `buildPages` that emits citing pages from the sources the driver accepted.
 */
export function createWebResearchWorker(options: WebResearchWorkerOptions = {}): ResearchWorker {
  const queriesPerGap = Math.max(1, options.queriesPerGap ?? 2)
  const resultsPerQuery = Math.max(1, options.resultsPerQuery ?? 3)
  const maxSourcesPerRound = Math.max(1, options.maxSourcesPerRound ?? 6)
  const minTextChars = Math.max(1, options.minTextChars ?? 200)
  const maxTextChars = Math.max(minTextChars, options.maxTextChars ?? 4000)

  return async (ctx: WorkerResearchContext): Promise<ResearchContribution> => {
    const router = resolveRouter(options)
    // Target the BLOCKING gaps first; fall back to all gaps if none are blocking.
    const targetGaps = ctx.gaps.filter((gap) => gap.blocking)
    const gaps = targetGaps.length > 0 ? targetGaps : ctx.gaps
    if (gaps.length === 0) {
      return { sources: [], notes: 'no open gaps to research' }
    }

    const queries = await formSearchQueries(router, ctx, gaps, queriesPerGap)
    const proposals: ResearchSourceProposal[] = []
    const seenUris = new Set<string>()

    for (const query of queries) {
      if (proposals.length >= maxSourcesPerRound) break
      if (ctx.signal?.aborted) break
      let hits: WebSearchHit[]
      try {
        hits = await router.search(query, { maxResults: resultsPerQuery })
      } catch (error) {
        // A single failed query must not sink the round — record nothing, move on.
        if ((error as { name?: string }).name === 'AbortError') break
        continue
      }
      for (const hit of hits) {
        if (proposals.length >= maxSourcesPerRound) break
        if (seenUris.has(hit.url)) continue
        const fetched = await politeFetch(hit.url, {
          signal: ctx.signal,
          cacheDir: options.cacheDir,
        })
        if (!fetched.verifiable) continue
        const text = htmlToText(fetched.body).slice(0, maxTextChars)
        if (text.length < minTextChars) continue
        seenUris.add(hit.url)
        proposals.push({
          uri: hit.url,
          title: hit.title || hit.url,
          text,
          // We just fetched + verified this page, so stamp `lastVerifiedAt` with
          // fetch time. Do NOT set `validUntil`: a live page has no inherent
          // future expiry, and the readiness freshness check treats any
          // `validUntil <= now` as EXPIRED (score 0). The page's `Last-Modified`
          // is a PAST date, so writing it here would mark every real source stale
          // and zero out coverage. Record it as provenance metadata instead.
          lastVerifiedAt: fetched.fetchedAt,
          metadata: {
            discoveredVia: query,
            snippet: hit.snippet ?? '',
            goal: ctx.goal,
            sourceUpdatedAt: fetched.sourceUpdatedAt,
          },
        })
      }
    }

    return {
      sources: proposals,
      buildPages: buildCitingPages(proposals),
      notes: `web-research worker: ${queries.length} queries → ${proposals.length} fetched sources`,
    }
  }
}

/**
 * Ask the LLM to turn the open gaps into focused web search queries. Falls back
 * to the gap's own readiness query if the model returns nothing parseable, so a
 * model hiccup degrades to a sane search rather than an empty round.
 */
async function formSearchQueries(
  router: RouterClient,
  ctx: WorkerResearchContext,
  gaps: KnowledgeGap[],
  queriesPerGap: number,
): Promise<string[]> {
  const gapLines = gaps
    .map((gap, i) => `${i + 1}. ${gap.description} (readiness query: "${gap.query}")`)
    .join('\n')
  const want = gaps.length * queriesPerGap
  const system =
    'You are a research librarian. Turn knowledge gaps into precise web search queries that will ' +
    'surface authoritative primary sources (papers, docs, standards, official pages). ' +
    'Return ONLY a JSON array of query strings, no prose.'
  const user = [
    `Research goal: ${ctx.goal}`,
    ctx.steer ? `Steer from the coordinator:\n${ctx.steer}` : '',
    `Open knowledge gaps:\n${gapLines}`,
    `Return up to ${want} search query strings as a JSON array (e.g. ["query one","query two"]).`,
  ]
    .filter(Boolean)
    .join('\n\n')

  let raw = ''
  try {
    raw = await router.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      MIN_MAX_TOKENS,
    )
  } catch {
    raw = ''
  }
  const parsed = parseQueryList(raw)
  const fromLlm = parsed.slice(0, want)
  if (fromLlm.length > 0) return dedupeStrings(fromLlm)
  // Degrade to the readiness queries themselves — still a real search.
  return dedupeStrings(gaps.map((gap) => gap.query || gap.description))
}

/** Parse a JSON array of query strings, tolerant of code fences / surrounding prose. */
function parseQueryList(raw: string): string[] {
  const text = raw.trim()
  if (!text) return []
  const candidates: string[] = []
  // Prefer a fenced or bare JSON array.
  const arrayMatch = text.match(/\[[\s\S]*\]/)
  if (arrayMatch) {
    try {
      const arr = JSON.parse(arrayMatch[0]) as unknown[]
      for (const item of arr)
        if (typeof item === 'string' && item.trim()) candidates.push(item.trim())
    } catch {
      /* fall through to line parsing */
    }
  }
  if (candidates.length === 0) {
    for (const line of text.split('\n')) {
      const cleaned = line
        .replace(/^\s*(?:[-*]|\d+[.)])\s*/, '')
        .replace(/^["']|["']$/g, '')
        .trim()
      if (cleaned && cleaned.length > 2 && !cleaned.startsWith('{')) candidates.push(cleaned)
    }
  }
  return candidates
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const key = value.toLowerCase().trim()
    if (key && !seen.has(key)) {
      seen.add(key)
      out.push(value.trim())
    }
  }
  return out
}

/**
 * Build the curated `knowledge/*.md` pages from the sources the driver accepted.
 * Each page cites the registered source by its assigned `record.id` (matched back
 * to the proposal via `metadata.originalUri`, which `addSourceText` stashes).
 */
function buildCitingPages(
  proposals: ResearchSourceProposal[],
): (acceptedSources: SourceRecord[]) => string | undefined {
  return (acceptedSources) => {
    if (acceptedSources.length === 0) return undefined
    const blocks = acceptedSources.map((record) => {
      const proposal = proposals.find((p) => p.uri === record.metadata?.originalUri)
      const uri = proposal?.uri ?? record.id
      const slug =
        uri
          .replace(/^https?:\/\//, '')
          .replace(/[^a-z0-9]+/gi, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 120) || record.id
      const title = proposal?.title ?? record.id
      const body = proposal?.text ?? ''
      return [
        `---FILE: knowledge/${slug}.md---`,
        '---',
        `title: ${escapeYaml(title)}`,
        `sources: ["${record.id}"]`,
        `source_url: ${uri}`,
        '---',
        `# ${title}`,
        '',
        body,
        '',
        `Source: ${uri}`,
        '---END FILE---',
      ].join('\n')
    })
    return blocks.join('\n')
  }
}

function escapeYaml(value: string): string {
  // Keep the frontmatter line single-valued and safe: collapse newlines, strip
  // quotes that would break the scalar.
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, "'")
    .trim()
}

export interface VerifyingDriverOptions {
  router?: RouterClient
  router_options?: TangleRouterOptions
  /**
   * When the LLM verdict can't be parsed, default to REJECT (fail-closed) so a
   * model hiccup never poisons the KB with an unverified source. Set `true` to
   * accept-on-parse-failure only if you have a reason to. Default false.
   */
  acceptOnParseFailure?: boolean
}

/**
 * The verifying driver: a real LLM pass that judges each candidate source's
 * on-topic relevance to the goal + open gaps and whether it duplicates material
 * already accepted this round. This is the differentiated coordinator role — it
 * GATES the worker's additions; it adds nothing itself.
 *
 * The loop already dedups exact-uri duplicates and only calls this on genuinely
 * new candidates, so the verifier focuses on relevance + near-duplicate
 * judgement, not bookkeeping.
 */
export function createVerifyingResearchDriver(
  options: VerifyingDriverOptions = {},
): ResearchDriver {
  const acceptOnParseFailure = options.acceptOnParseFailure ?? false
  return {
    async verifySource(
      source: ResearchSourceProposal,
      ctx: SourceVerificationContext,
    ): Promise<SourceVerdict> {
      const router = resolveRouter(options)
      const gapLines = ctx.gaps
        .map((gap) => `- ${gap.description} (query: "${gap.query}")`)
        .join('\n')
      const acceptedTitles = ctx.acceptedThisRound
        .map((accepted) => `- ${accepted.title ?? accepted.uri}`)
        .join('\n')
      const excerpt = source.text.slice(0, 1500)
      const system =
        'You verify whether a fetched web source belongs in a curated knowledge base. ' +
        'Accept a source ONLY if it is genuinely on-topic for the research goal and helps close ' +
        'one of the open gaps, AND it is not a near-duplicate of an already-accepted source. ' +
        'Reject spam, listicles, off-topic pages, marketing, and near-duplicates. ' +
        'Respond with ONLY a JSON object: {"accept": true|false, "reason": "<short reason>"}.'
      const user = [
        `Research goal: ${ctx.goal}`,
        `Open gaps:\n${gapLines || '(none specified)'}`,
        acceptedTitles
          ? `Already accepted this round:\n${acceptedTitles}`
          : 'Nothing accepted yet this round.',
        `Candidate source:\nURL: ${source.uri}\nTitle: ${source.title ?? '(none)'}\nExcerpt:\n${excerpt}`,
        'Verdict as JSON {"accept": boolean, "reason": string}:',
      ].join('\n\n')

      let raw = ''
      try {
        raw = await router.chat(
          [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          MIN_MAX_TOKENS,
        )
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') throw error
        // Router failure: fail-closed (reject) so an unverified source can't slip in.
        return acceptOnParseFailure
          ? { accept: true }
          : { accept: false, reason: `verifier unavailable: ${(error as Error).message}` }
      }

      const verdict = parseVerdict(raw)
      if (verdict) return verdict
      return acceptOnParseFailure
        ? { accept: true }
        : { accept: false, reason: 'verifier returned an unparseable verdict' }
    },
  }
}

/** Parse the verifier's `{accept, reason}` JSON, tolerant of fences / prose. */
function parseVerdict(raw: string): SourceVerdict | null {
  const text = raw.trim()
  if (!text) return null
  const objMatch = text.match(/\{[\s\S]*\}/)
  if (!objMatch) return null
  try {
    const parsed = JSON.parse(objMatch[0]) as { accept?: unknown; reason?: unknown }
    if (typeof parsed.accept !== 'boolean') return null
    if (parsed.accept) return { accept: true }
    return {
      accept: false,
      reason:
        typeof parsed.reason === 'string' && parsed.reason.trim()
          ? parsed.reason.trim()
          : 'rejected by verifier',
    }
  } catch {
    return null
  }
}
