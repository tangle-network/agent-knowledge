from pathlib import Path
import json

path = Path('src/web-research-worker.ts')
s = path.read_text()
old = ''' * Dependency-free on purpose: it talks to the router over `fetch` directly with
 * the published OpenAI-compatible chat shape and the `/v1/search` shape, so it
 * works whether or not the `tcloud` CLI is installed. Point it at any router by
 * passing `baseUrl`; supply the key via `apiKey` or `TANGLE_API_KEY`.'''
assert old in s
s = s.replace(old, ''' * Model and search requests use the published TCloud SDK. Knowledge owns the
 * research policy, not HTTP, bearer headers, retries or provider rate cards.
 * Point it at any router with `baseUrl`; supply `apiKey` or `TANGLE_API_KEY`.''')
s = s.replace("import { htmlToText } from './sources/html'", "import { TCloudClient, TCloudError, type SearchProvider } from '@tangle-network/tcloud'\nimport { htmlToText } from './sources/html'")
s = s.replace(' * stub the network; the default talks to the live Tangle router over `fetch`.', ' * supply a client; the default uses the published TCloud SDK.')
s = s.replace('  usd: number\n', '  /** Reported cost only. NaN once a successful response omits its cost receipt. */\n  usd: number\n', 1)
a = s.index('  /**\n   * Retries on a TRANSIENT upstream status')
b = s.index('  signal?: AbortSignal', a)
s = s[:a] + '''  /** SDK retries for 429/502/503/504. Default 4. Kept for API compatibility. */
  maxRetries?: number
  /** Initial SDK retry backoff in ms. Default 1500. */
  retryBaseMs?: number
''' + s[b:]
a = s.index('/** Transient upstream statuses worth a retry')
b = s.index('export interface WebResearchWorkerOptions', a)
s = s[:a] + '''/** Compatibility error facade. HTTP execution and classification belong to TCloud. */
export class RouterError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`router ${status}: ${message}`)
    this.name = 'RouterError'
  }
}

/** Adapt Knowledge's public contract to the published SDK, without a second transport. */
export function createTangleRouterClient(options: TangleRouterOptions = {}): RouterClient {
  const apiKey = options.apiKey ?? process.env.TANGLE_API_KEY
  if (!apiKey) throw new RouterError(401, 'no TANGLE_API_KEY (pass apiKey or set the env var)')
  const client = new TCloudClient({
    baseURL: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\\/+$/, ''),
    apiKey,
    model: options.model ?? DEFAULT_MODEL,
    // Preserve the unbounded reasoning timeout. The caller can cancel the actual request.
    timeout: 0,
    retry: {
      maxRetries: Math.max(0, options.maxRetries ?? 4),
      initialBackoffMs: Math.max(1, options.retryBaseMs ?? 1500),
      retryableStatuses: [429, 502, 503, 504],
    },
  })
  const acc: RouterUsage = {
    chatCalls: 0,
    searchCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    usd: 0,
    wallMs: 0,
  }
  // NaN is deliberately not zero: an incomplete bill must not win a cost comparison.
  const recordCost = (cost: number | undefined) => {
    acc.usd += typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : Number.NaN
  }
  const translate = (error: unknown): never => {
    // Preserve the caller's exact abort reason, including non-Error reasons.
    options.signal?.throwIfAborted()
    if (error instanceof TCloudError) throw new RouterError(error.status, error.message)
    throw error
  }

  return {
    async search(query, opts) {
      options.signal?.throwIfAborted()
      const started = Date.now()
      try {
        const response = await client.search({
          query,
          ...(options.searchProvider ? { provider: options.searchProvider as SearchProvider } : {}),
          ...(opts?.maxResults != null ? { maxResults: opts.maxResults } : {}),
          signal: options.signal,
        })
        recordCost(response.usage?.billed_cost)
        return (response.data ?? [])
          .filter((hit) => typeof hit?.url === 'string' && hit.url.length > 0)
          .map((hit) => ({ title: hit.title ?? hit.url, url: hit.url, snippet: hit.snippet }))
      } catch (error) {
        return translate(error)
      } finally {
        acc.searchCalls += 1
        acc.wallMs += Date.now() - started
      }
    },
    async chat(messages, maxTokens) {
      options.signal?.throwIfAborted()
      const started = Date.now()
      try {
        const response = await client.chat({
          messages,
          maxTokens: Math.max(MIN_MAX_TOKENS, maxTokens ?? MIN_MAX_TOKENS),
          temperature: 0.2,
          signal: options.signal,
        })
        acc.chatCalls += 1
        acc.promptTokens += response.usage?.prompt_tokens ?? 0
        acc.completionTokens += response.usage?.completion_tokens ?? 0
        // Per-response cost, not a shared-client usage delta that races parallel calls.
        recordCost(response.tangle?.costUsd)
        return response.choices?.[0]?.message?.content ?? ''
      } catch (error) {
        return translate(error)
      } finally {
        acc.wallMs += Date.now() - started
      }
    },
    usage() {
      return { ...acc }
    },
  }
}

''' + s[b:]
path.write_text(s)
path = Path('package.json')
p = json.loads(path.read_text())
p['version'] = '17.1.9'
p['dependencies']['@tangle-network/tcloud'] = '>=0.6.0 <0.7.0'
p['devDependencies']['@tangle-network/agent-interface'] = '2.13.0'
for name in ['@tangle-network/tcloud', '@tangle-network/sandbox']:
    if name not in p['pnpm']['minimumReleaseAgeExclude']:
        p['pnpm']['minimumReleaseAgeExclude'].append(name)
path.write_text(json.dumps(p, indent=2) + '\n')
path = Path('CHANGELOG.md')
s = path.read_text()
assert s.startswith('# Changelog\n')
s = s.replace('# Changelog\n', '''# Changelog

## 17.1.9

Use published TCloud 0.6 for research chat and search. Remove raw Router HTTP, bearer headers, local retries and hard-coded GLM pricing. Keep `RouterError`, `maxRetries`, `retryBaseMs` and the injectable `RouterClient` contract, so no major-version consumer cutover is needed.

Forward cancellation into the actual SDK transport. Attribute cost from each response, not a shared total that races parallel calls. `usage().usd` is NaN when a successful response has no reported cost; it is never a made-up free call. Search results still reject missing URLs. Reasoning calls retain the caller-controlled timeout.

This change requires the TCloud 0.6 registry release first. That release uses the current Sandbox/Interface/Zod cohort. No published dependency overrides, source aliases or vendored modules are used.
''', 1)
path.write_text(s)
