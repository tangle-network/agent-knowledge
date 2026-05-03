#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { buildKnowledgeIndex, writeKnowledgeIndex } from './indexer'
import { lintKnowledgeIndex } from './lint'
import { searchKnowledge } from './search'
import { initKnowledgeBase, layoutFor } from './store'
import { detectKnowledgeGaps, findSurprisingConnections, toKnowledgeVizGraph } from './viz/index'

interface Args {
  command: string
  positional: string[]
  flags: Record<string, string>
}

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = rest[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = 'true'
      }
    } else {
      positional.push(token)
    }
  }
  return { command: command ?? 'help', positional, flags }
}

const HELP = `agent-knowledge — source-grounded knowledge graph CLI.

Commands:
  init [--root .]
      Create raw/sources, knowledge, and cache directories.
  index [--root .] [--json]
      Build .agent-knowledge/index.json from knowledge/**/*.md.
  search <query> [--root .] [--limit 10] [--json]
      Fast local token+graph search over the generated knowledge index.
  graph [--root .] [--format summary|json]
      Emit graph summary or JSON.
  lint [--root .] [--json]
      Run deterministic structural lint.
  viz [--root .] [--json]
      Emit graph gaps and surprising connections.
  version
      Print package version.
`

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const root = resolve(args.flags.root ?? '.')
  switch (args.command) {
    case 'init': {
      const layout = await initKnowledgeBase(root)
      process.stdout.write(`initialized knowledge base at ${layout.root}\n`)
      return 0
    }
    case 'index': {
      const index = await writeKnowledgeIndex(root)
      if (args.flags.json === 'true') process.stdout.write(JSON.stringify(index, null, 2) + '\n')
      else process.stdout.write(`indexed ${index.pages.length} pages, ${index.graph.edges.length} edges\n`)
      return 0
    }
    case 'search': {
      const query = args.positional.join(' ')
      if (!query) {
        process.stderr.write('search requires a query\n')
        return 1
      }
      const index = await loadOrBuildIndex(root)
      const results = searchKnowledge(index, query, Number(args.flags.limit ?? 10))
      if (args.flags.json === 'true') {
        process.stdout.write(JSON.stringify(results, null, 2) + '\n')
      } else {
        for (const result of results) {
          process.stdout.write(`${result.rank}. ${result.page.title} (${result.page.path}) score=${result.score.toFixed(5)}\n`)
          if (result.snippet) process.stdout.write(`   ${result.snippet}\n`)
        }
      }
      return 0
    }
    case 'graph': {
      const index = await loadOrBuildIndex(root)
      if ((args.flags.format ?? 'summary') === 'json') process.stdout.write(JSON.stringify(index.graph, null, 2) + '\n')
      else process.stdout.write(`nodes=${index.graph.nodes.length} edges=${index.graph.edges.length}\n`)
      return 0
    }
    case 'lint': {
      const index = await loadOrBuildIndex(root)
      const findings = lintKnowledgeIndex(index)
      if (args.flags.json === 'true') process.stdout.write(JSON.stringify(findings, null, 2) + '\n')
      else {
        if (findings.length === 0) process.stdout.write('no findings\n')
        for (const finding of findings) {
          process.stdout.write(`${finding.severity.toUpperCase()} ${finding.type}${finding.page ? ` ${finding.page}` : ''}: ${finding.message}\n`)
        }
      }
      return findings.some((finding) => finding.severity === 'error') ? 2 : 0
    }
    case 'viz': {
      const index = await loadOrBuildIndex(root)
      const viz = toKnowledgeVizGraph(index.graph)
      const payload = {
        graph: viz,
        gaps: detectKnowledgeGaps(viz),
        surprisingConnections: findSurprisingConnections(viz),
      }
      if (args.flags.json === 'true') process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
      else {
        process.stdout.write(`communities=${viz.communities.length} gaps=${payload.gaps.length} surprising=${payload.surprisingConnections.length}\n`)
      }
      return 0
    }
    case 'version': {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
      process.stdout.write(`${pkg.version}\n`)
      return 0
    }
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP)
      return 0
    default:
      process.stderr.write(`unknown command: ${args.command}\n${HELP}`)
      return 1
  }
}

async function loadOrBuildIndex(root: string) {
  const path = join(layoutFor(root).cacheDir, 'index.json')
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as Awaited<ReturnType<typeof buildKnowledgeIndex>>
  return await writeKnowledgeIndex(root)
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`agent-knowledge error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    process.exit(1)
  })
