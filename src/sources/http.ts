import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sha256 } from '../ids'

/**
 * Polite HTTP fetcher used by every shipped source.
 *
 * Three invariants this enforces — each was a bug found while wiring real
 * authorities; do not regress:
 *
 *   1. Per-host throttling. Cornell LII serves under 1 req/s/origin
 *      politely and will start serving block pages above that. The lock
 *      is per-host (`hostThrottle`) rather than per-source so that two
 *      independent sources targeting the same authority still cooperate.
 *
 *   2. On-disk content cache keyed by URL. Production sources are called
 *      from a cron loop; without a cache, every run re-hits the same
 *      pages and inflates change-detection false-positives (the authority
 *      occasionally serves slightly different boilerplate). The cache is
 *      content-addressed by URL, not by ETag — authorities like IRS.gov
 *      do not consistently send ETag/Last-Modified.
 *
 *   3. Block-page detection on success. A 200 with a captcha body still
 *      means "we couldn't authenticate." Sources downstream rely on
 *      `verifiable` to refuse promotion — losing that signal because the
 *      fetcher said "well, the status code was 200" is the bug class
 *      this exists to prevent.
 *
 * @stable
 */

/** User-Agent string sent on every outbound request. */
export const POLITE_USER_AGENT =
  'agent-knowledge/0.2.0 (+https://github.com/tangle-network/agent-knowledge)'

/** Minimum gap between successive requests to the same origin (ms). */
export const MIN_REQUEST_GAP_MS = 1_000

/** Maximum response body we will buffer in memory (bytes). */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

const hostThrottle = new Map<string, Promise<void>>()

export interface PoliteFetchOptions {
  signal?: AbortSignal
  cacheDir?: string
  /**
   * Cache age beyond which we re-fetch. Default 1 hour — long enough to
   * batch a cron sweep across many selectors, short enough that hourly
   * authoritative-page changes get picked up next tick.
   */
  cacheTtlMs?: number
  /**
   * Extra request headers. The fetcher always sets `User-Agent` and
   * `Accept`; callers can add `Accept-Language` etc.
   */
  headers?: Record<string, string>
}

export interface PoliteFetchResult {
  url: string
  status: number
  /** Decoded UTF-8 body. Truncated to `MAX_RESPONSE_BYTES`. */
  body: string
  /**
   * Best-effort source-attested timestamp. Reads `Last-Modified`,
   * falling back to `Date`, falling back to fetch time. Always ISO 8601.
   */
  sourceUpdatedAt: string
  fetchedAt: string
  /** True iff the response was satisfied from disk cache. */
  fromCache: boolean
  /**
   * False on: non-2xx status, captcha/block page heuristic match, or
   * decoded body below 200 chars from a host known to serve real content
   * (Cornell, IRS, state SOS). `unverifiableReason` carries the why.
   */
  verifiable: boolean
  unverifiableReason?: string
}

/**
 * Fetch one URL with per-host throttling, on-disk cache, and block-page
 * detection. Never throws on network/HTTP failure — returns a result with
 * `verifiable: false` and `unverifiableReason` set so the caller can decide
 * whether to skip, retry, or surface.
 *
 * Throws ONLY on `AbortError` (caller asked to stop) and on cache-write
 * failures that indicate a misconfigured filesystem.
 */
export async function politeFetch(
  url: string,
  options: PoliteFetchOptions = {},
): Promise<PoliteFetchResult> {
  const cacheTtl = options.cacheTtlMs ?? 60 * 60 * 1000
  const cached = options.cacheDir ? await readCache(options.cacheDir, url, cacheTtl) : undefined
  if (cached) return cached

  const host = safeHost(url)
  await throttleHost(host)

  const fetchedAt = new Date().toISOString()
  let response: Response
  try {
    response = await fetch(url, {
      signal: options.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': POLITE_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(options.headers ?? {}),
      },
    })
  } catch (error) {
    if ((error as { name?: string }).name === 'AbortError') throw error
    const result: PoliteFetchResult = {
      url,
      status: 0,
      body: '',
      sourceUpdatedAt: fetchedAt,
      fetchedAt,
      fromCache: false,
      verifiable: false,
      unverifiableReason: `network error: ${(error as Error).message}`,
    }
    if (options.cacheDir) await writeCache(options.cacheDir, url, result)
    return result
  }

  const text = await readBoundedText(response)
  const lastModified = response.headers.get('last-modified')
  const dateHeader = response.headers.get('date')
  const sourceUpdatedAt = parseHttpDate(lastModified) ?? parseHttpDate(dateHeader) ?? fetchedAt

  const result: PoliteFetchResult = {
    url,
    status: response.status,
    body: text,
    sourceUpdatedAt,
    fetchedAt,
    fromCache: false,
    verifiable: true,
  }

  if (response.status < 200 || response.status >= 300) {
    result.verifiable = false
    result.unverifiableReason = `non-2xx status: ${response.status}`
  } else if (looksLikeBlockPage(text)) {
    result.verifiable = false
    result.unverifiableReason = 'block-page heuristic matched'
  } else if (text.length < 200 && knownLargeAuthority(host)) {
    result.verifiable = false
    result.unverifiableReason = `body shorter than expected (${text.length} chars)`
  }

  if (options.cacheDir) await writeCache(options.cacheDir, url, result)
  return result
}

/** Reset the in-process throttle map. Test-only. */
export function __resetHttpThrottle(): void {
  hostThrottle.clear()
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'unknown'
  }
}

async function throttleHost(host: string): Promise<void> {
  const prev = hostThrottle.get(host) ?? Promise.resolve()
  let release: () => void = () => {}
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  hostThrottle.set(
    host,
    prev.then(() => next),
  )
  await prev
  setTimeout(release, MIN_REQUEST_GAP_MS)
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.length
    if (total > MAX_RESPONSE_BYTES) {
      // Stop reading; release the underlying connection.
      await reader.cancel()
      break
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(Math.min(total, MAX_RESPONSE_BYTES))
  let offset = 0
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, merged.length - offset)
    if (take <= 0) break
    merged.set(chunk.subarray(0, take), offset)
    offset += take
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged)
}

function parseHttpDate(value: string | null): string | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

/** Cheap heuristic that catches CAPTCHA, WAF block pages, and "Just a moment" interstitials. */
export function looksLikeBlockPage(body: string): boolean {
  if (!body) return false
  const lower = body.toLowerCase()
  const markers = [
    'verify you are human',
    'please enable javascript and cookies',
    'just a moment',
    'access denied',
    'request unsuccessful',
    'cf-error-details',
    'captcha',
    'incapsula',
    'pardon our interruption',
  ]
  for (const marker of markers) {
    if (lower.includes(marker)) return true
  }
  return false
}

function knownLargeAuthority(host: string): boolean {
  return (
    host.endsWith('law.cornell.edu') ||
    host.endsWith('irs.gov') ||
    host.endsWith('sos.ca.gov') ||
    host.endsWith('sos.state.tx.us') ||
    host.endsWith('sos.state.us')
  )
}

function cachePath(cacheDir: string, url: string): string {
  const key = sha256(url)
  return join(cacheDir, 'http', `${key.slice(0, 2)}`, `${key}.json`)
}

async function readCache(
  cacheDir: string,
  url: string,
  ttlMs: number,
): Promise<PoliteFetchResult | undefined> {
  const path = cachePath(cacheDir, url)
  try {
    const info = await stat(path)
    if (Date.now() - info.mtimeMs > ttlMs) return undefined
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as PoliteFetchResult
    return { ...parsed, fromCache: true }
  } catch {
    return undefined
  }
}

async function writeCache(cacheDir: string, url: string, value: PoliteFetchResult): Promise<void> {
  const path = cachePath(cacheDir, url)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value), 'utf8')
}
