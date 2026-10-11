#!/usr/bin/env node
/** Verify the actual packed search subpath without any Node built-ins in its import graph. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'knowledge-search-package-'))
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], {
    encoding: 'utf8', env: { ...process.env, npm_config_cache: join(scratch, 'npm-cache') },
  }))
  const target = join(scratch, 'node_modules', '@tangle-network', 'agent-knowledge')
  mkdirSync(target, { recursive: true })
  execFileSync('tar', ['-xzf', join(scratch, packed[0].filename), '--strip-components=1', '-C', target])
  const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
  if (!manifest.exports?.['./search']?.import) throw new Error('Packed search export missing')
  writeFileSync(join(scratch, 'deny-builtins.mjs'), `
export function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('.') && !specifier.startsWith('file:') && specifier !== '@tangle-network/agent-knowledge/search') {
    throw new Error('Search imported a runtime dependency: ' + specifier)
  }
  return nextResolve(specifier, context)
}
`)
  writeFileSync(join(scratch, 'bootstrap.mjs'), `
import { register } from 'node:module'
register(new URL('./deny-builtins.mjs', import.meta.url))
`)
  writeFileSync(join(scratch, 'consumer.mjs'), `
import { searchKnowledgePages, buildKnowledgeLexicalIndex } from '@tangle-network/agent-knowledge/search'
const pages = [{ id:'policy', path:'policy.md', title:'Refund policy', text:'Refunds allowed for thirty days.', frontmatter:{}, sourceIds:['source-v3'], tags:[], outLinks:[] }]
const hits = searchKnowledgePages(pages, 'refund', { lexicalIndex:buildKnowledgeLexicalIndex(pages) })
if (hits.length !== 1 || hits[0].page.sourceIds[0] !== 'source-v3') throw new Error('Packed search returned incorrect evidence')
console.log('Packed search subpath passed without filesystem, Node, or peer runtime imports')
`)
  process.stdout.write(execFileSync(process.execPath, ['--import', join(scratch, 'bootstrap.mjs'), join(scratch, 'consumer.mjs')], { encoding: 'utf8' }))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
