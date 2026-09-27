#!/usr/bin/env node
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createTangleRouterClient, RouterError } from '../dist/index.js'

assert.ok(process.env.TANGLE_API_KEY, 'Set a funded TANGLE_API_KEY without printing it')
const marker = `knowledge-tcloud-ok-${randomUUID()}`
const model = process.env.TANGLE_PROOF_MODEL || 'gpt-4o-mini'
const client = createTangleRouterClient({
  apiKey: process.env.TANGLE_API_KEY,
  baseUrl: process.env.TANGLE_ROUTER_URL || 'https://router.tangle.tools/v1',
  model,
  maxRetries: 0,
  ...(process.env.TANGLE_SEARCH_PROVIDER ? { searchProvider: process.env.TANGLE_SEARCH_PROVIDER } : {}),
  signal: AbortSignal.timeout(120000),
})
const query = 'Tangle Sandbox SDK official documentation'
const hits = await client.search(query, { maxResults: 1 })
assert.ok(hits.length > 0 && hits.every(hit => hit.url), 'No live search results')
const messages = [{ role: 'user', content: `Reply with exactly ${marker}` }]
const answer = await client.chat(messages, 1200)
assert.ok(answer.includes(marker), 'Chat omitted the unique request marker')
const usage = client.usage()
assert.equal(usage.chatCalls, 1)
assert.equal(usage.searchCalls, 1)
assert.ok(Number.isFinite(usage.usd) && usage.usd >= 0, 'Router omitted a cost receipt')
console.log(JSON.stringify({ proof: 'built-knowledge-router', model, marker, query, hits, messages, answer, usage }, null, 2))
// Existing public compatibility facade remains constructible.
assert.equal(new RouterError(401, 'proof').status, 401)
