import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256 } from '../src/ids'
import { __resetHttpThrottle, politeFetch } from '../src/sources/index'

/**
 * Bug class each test defends against:
 *
 *   - 4xx swallowed as verifiable ⇒ downstream eval gates promote
 *     un-grounded fragments.
 *   - cache write missing ⇒ cron tick re-hits the authority every loop.
 *   - cache TTL ignored ⇒ stale fragments persist after authority change.
 *   - throttle not actually serialising ⇒ second request fires before
 *     1 req/s gap, Cornell starts block-paging.
 *   - block-page heuristic miss ⇒ verifiable=true on captcha snapshots.
 */

let cacheDir: string
const originalFetch = globalThis.fetch

beforeEach(async () => {
  __resetHttpThrottle()
  cacheDir = await mkdtemp(join(tmpdir(), 'agent-knowledge-http-cache-'))
})

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true })
  globalThis.fetch = originalFetch
})

function mockFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    return handler(url, init)
  }) as unknown as typeof globalThis.fetch
}

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html', ...headers },
  })
}

describe('politeFetch', () => {
  it('returns verifiable=true for a normal 200', async () => {
    mockFetch(() =>
      html(`<html><body>${'X'.repeat(500)}</body></html>`, 200, {
        'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
      }),
    )
    const result = await politeFetch('https://www.law.cornell.edu/uscode/text/18/1836')
    expect(result.status).toBe(200)
    expect(result.verifiable).toBe(true)
    expect(result.unverifiableReason).toBeUndefined()
    expect(result.sourceUpdatedAt).toBe('2025-01-01T00:00:00.000Z')
  })

  it('returns verifiable=false on 404 with reason', async () => {
    mockFetch(() => html('Not Found', 404))
    const result = await politeFetch('https://www.law.cornell.edu/uscode/text/99/9999')
    expect(result.verifiable).toBe(false)
    expect(result.unverifiableReason).toMatch(/non-2xx status: 404/)
  })

  it('returns verifiable=false on block page even with 200', async () => {
    mockFetch(() =>
      html(
        `<html><body>${'pad '.repeat(100)}Just a moment — please enable JavaScript</body></html>`,
      ),
    )
    const result = await politeFetch('https://www.law.cornell.edu/wex/non-compete')
    expect(result.status).toBe(200)
    expect(result.verifiable).toBe(false)
    expect(result.unverifiableReason).toMatch(/block-page heuristic/)
  })

  it('returns verifiable=false on short body from known authority', async () => {
    mockFetch(() => html('too short'))
    const result = await politeFetch('https://www.irs.gov/publications')
    expect(result.verifiable).toBe(false)
    expect(result.unverifiableReason).toMatch(/body shorter than expected/)
  })

  it('writes to disk cache and serves the second call from cache', async () => {
    const calls: string[] = []
    mockFetch((url) => {
      calls.push(url)
      return html(`<html><body>${'X'.repeat(500)}</body></html>`)
    })
    const url = 'https://www.law.cornell.edu/uscode/text/18/1836'
    const a = await politeFetch(url, { cacheDir })
    const b = await politeFetch(url, { cacheDir })
    expect(calls).toHaveLength(1)
    expect(a.fromCache).toBe(false)
    expect(b.fromCache).toBe(true)
    expect(b.body).toBe(a.body)
  })

  it('respects cache TTL — expired entry re-fetches', async () => {
    // Plant a stale cache file directly: TTL of 1ms ensures it's stale.
    const url = 'https://www.law.cornell.edu/uscode/text/18/1836'
    const key = sha256(url)
    const path = join(cacheDir, 'http', key.slice(0, 2), `${key}.json`)
    await mkdir(join(cacheDir, 'http', key.slice(0, 2)), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        url,
        status: 200,
        body: 'STALE',
        sourceUpdatedAt: '2020-01-01T00:00:00.000Z',
        fetchedAt: '2020-01-01T00:00:00.000Z',
        fromCache: false,
        verifiable: true,
      }),
    )
    // Force the mtime to be 1 day old so any positive TTL ≤ 1d will reject it.
    const { utimes } = await import('node:fs/promises')
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
    await utimes(path, dayAgo, dayAgo)

    mockFetch(() => html(`<html><body>${'FRESH'.repeat(100)}</body></html>`))
    const result = await politeFetch(url, { cacheDir, cacheTtlMs: 60_000 })
    expect(result.fromCache).toBe(false)
    expect(result.body).toContain('FRESH')
  })

  it("caches failures too so a transient block doesn't storm the authority", async () => {
    mockFetch(() => html('Just a moment', 200))
    const url = 'https://www.law.cornell.edu/wex/non-compete'
    const first = await politeFetch(url, { cacheDir })
    expect(first.verifiable).toBe(false)
    const cached = await readdir(join(cacheDir, 'http'), { recursive: true }).catch(() => [])
    expect(cached.length).toBeGreaterThan(0)
  })

  it('serialises requests to the same host (>=1s gap)', async () => {
    const timestamps: number[] = []
    mockFetch(() => {
      timestamps.push(Date.now())
      return html(`<html><body>${'X'.repeat(500)}</body></html>`)
    })
    // Two distinct URLs on the same host bypass the URL cache but should
    // still be throttled by the host gate.
    const t0 = Date.now()
    await Promise.all([
      politeFetch('https://throttle.test/a'),
      politeFetch('https://throttle.test/b'),
    ])
    const gap = (timestamps[1] ?? 0) - (timestamps[0] ?? 0)
    expect(gap).toBeGreaterThanOrEqual(900) // some leeway for timer precision
    // Sanity: throttle is on a per-host basis — total elapsed at least gap.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
  }, 10_000)

  it('never throws on a network error — returns verifiable=false', async () => {
    mockFetch(() => {
      throw new TypeError('network unreachable')
    })
    const result = await politeFetch('https://throw.test/x')
    expect(result.verifiable).toBe(false)
    expect(result.unverifiableReason).toMatch(/network error: network unreachable/)
    expect(result.status).toBe(0)
  })

  it('cache entry on success is reusable via subsequent fetches without remocking', async () => {
    mockFetch(() => html(`<html><body>${'X'.repeat(500)}</body></html>`))
    const url = 'https://www.law.cornell.edu/uscode/text/18/1836'
    await politeFetch(url, { cacheDir })

    // Re-mock to ensure the next call would 500 if it weren't served from cache.
    mockFetch(() => html('boom', 500))
    const second = await politeFetch(url, { cacheDir })
    expect(second.status).toBe(200)
    expect(second.fromCache).toBe(true)
  })

  it('cache files are organised by URL hash prefix', async () => {
    mockFetch(() => html(`<html><body>${'Y'.repeat(500)}</body></html>`))
    await politeFetch('https://hash.test/foo', { cacheDir })
    const entries = await readdir(join(cacheDir, 'http'), { recursive: true })
    expect(entries.some((e) => e.toString().endsWith('.json'))).toBe(true)
    const jsons = entries.filter((e) => e.toString().endsWith('.json'))
    const content = await readFile(join(cacheDir, 'http', jsons[0]!.toString()), 'utf8')
    expect(JSON.parse(content).url).toBe('https://hash.test/foo')
  })
})
