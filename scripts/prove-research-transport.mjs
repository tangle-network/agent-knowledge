#!/usr/bin/env node
// Local HTTP proof of failures found in #222. No mocked fetch or unit runner.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { createTangleRouterClient, RouterError } from '../dist/index.js'

const abort = new AbortController()
const timers = new Set()
let cancelledSocket = false
const observed = []
const server = createServer(async (req, res) => {
  let text = ''
  for await (const chunk of req) text += chunk
  const body = JSON.parse(text)
  observed.push({ path: req.url, client: req.headers['x-tangle-client'], hasSignalField: 'signal' in body })
  if (body.query) {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: [{ title: 'source', url: 'https://example.com/proof' }, {}], usage: { billed_cost: 0.003 } }))
    return
  }
  const prompt = body.messages[0].content
  if (prompt === 'denied') {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end('{"error":{"message":"proof denial"}}')
    return
  }
  if (prompt === 'cancel') {
    res.once('close', () => { cancelledSocket = true })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.write('{"choices":[')
    timers.add(setTimeout(() => abort.abort(new DOMException('proof cancelled', 'AbortError')), 30))
    timers.add(setTimeout(() => res.end(']}'), 2500))
    return
  }
  await sleep(prompt === 'first' ? 50 : 5)
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-Tangle-Cost-USD': prompt === 'first' ? '0.01' : '0.02' })
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: prompt } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }))
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const options = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-proof-only', maxRetries: 0, retryBaseMs: 1 }
const client = createTangleRouterClient(options)
try {
  const answers = await Promise.all(['first', 'second'].map(content => client.chat([{ role: 'user', content }])))
  assert.deepEqual(answers, ['first', 'second'])
  const hits = await client.search('proof', { maxResults: 2 })
  assert.equal(hits.length, 1)
  assert.ok(Math.abs(client.usage().usd - 0.033) < 1e-10, 'concurrent requests double-counted cost')
  assert.equal(client.usage().promptTokens, 4)
  await assert.rejects(client.chat([{ role: 'user', content: 'denied' }]), error => error instanceof RouterError && error.status === 401)
  const cancellable = createTangleRouterClient({ ...options, signal: abort.signal })
  await assert.rejects(cancellable.chat([{ role: 'user', content: 'cancel' }]), { name: 'AbortError' })
  for (let i = 0; i < 50 && !cancelledSocket; i++) await sleep(10)
  assert.equal(cancelledSocket, true, 'aborted caller left the HTTP request alive')
  assert.ok(observed.every(request => request.client?.startsWith('tcloud-sdk/') && !request.hasSignalField))
  console.log(JSON.stringify({ proof: 'research-adapter-real-http', observed, usage: client.usage(), cancelledSocket, errorFacade: 'RouterError(401)' }, null, 2))
} finally {
  for (const timer of timers) clearTimeout(timer)
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
