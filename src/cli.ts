#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { type buildKnowledgeIndex, writeKnowledgeIndex } from './indexer'
import { explainKnowledgeTarget, inspectKnowledgeIndex } from './inspect'
import { lintKnowledgeIndex } from './lint'
import type { KnowledgePagesOptions } from './pages-directory'
import { type ApplyKnowledgeWriteBlocksOptions, applyKnowledgeWriteBlocksFile } from './proposals'
import { searchKnowledge } from './search'
import { addSourcePath, loadSourceRegistry } from './sources'
import { initKnowledgeBase, layoutFor } from './store'
import { validateKnowledgeIndex } from './validate'
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

Options shared by the commands below:
  --root <dir>        Knowledge-base root. Defaults to the current directory.
  --pages-dir <dir>   Root-relative directory that holds Markdown pages. Defaults to knowledge.
                      Bounds apply-write-blocks and selects what index builds.

Commands:
  init [--root .]
      Create raw/sources, knowledge, and cache directories.
  index [--root .] [--pages-dir knowledge] [--json]
      Build .agent-knowledge/index.json from <pages-dir>/**/*.md.
  source-add <path> [--root .] [--json]
      Copy a file or directory into raw/sources and register immutable source records.
  sources [--root .] [--json]
      List registered sources.
  apply-write-blocks <proposal-file> [--root .] [--pages-dir knowledge] [--intake]
                     [--intake-threshold 0.82] [--json]
      Apply safe ---FILE: <pages-dir>/...--- blocks emitted by an agent.
      --intake refuses the whole proposal when a block duplicates a page already
      in the store without citing it, naming it in contradicts, or reusing its
      id, or when a block cites a page id that exists nowhere.
      --intake-threshold sets the duplicate Jaccard similarity.
  inspect [--root .] [--json]
      Summarize page/source/edge counts, top pages, and lint state.
  explain <page|id|query> [--root .] [--json]
      Explain sources, links, inbound links, and related pages.
  search <query> [--root .] [--pages-dir knowledge] [--limit 10] [--json]
      Local BM25 and link-graph search (RRF fused) over the generated knowledge index.
  graph [--root .] [--format summary|json]
      Emit graph summary or JSON.
  lint [--root .] [--json]
      Run deterministic structural lint.
  validate [--root .] [--strict] [--json]
      Run schema + lint validation. Exits non-zero on blocking findings.
  export [--root .] [--format json]
      Export the current index.
  viz [--root .] [--json]
      Emit graph gaps and surprising connections.
  version
      Print package version.
`

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const root = resolve(args.flags.root ?? '.')
  const pages = pagesOptions(args)
  switch (args.command) {
    case 'init': {
      const layout = await initKnowledgeBase(root)
      process.stdout.write(`initialized knowledge base at ${layout.root}\n`)
      return 0
    }
    case 'index': {
      const index = await writeKnowledgeIndex(root, pages)
      if (args.flags.json === 'true') process.stdout.write(`${JSON.stringify(index, null, 2)}\n`)
      else
        process.stdout.write(
          `indexed ${index.pages.length} pages, ${index.graph.edges.length} edges\n`,
        )
      return 0
    }
    case 'source-add': {
      const [path] = args.positional
      if (!path) {
        process.stderr.write('source-add requires a file or directory path\n')
        return 1
      }
      await initKnowledgeBase(root)
      const sources = await addSourcePath(root, resolve(path))
      if (args.flags.json === 'true') process.stdout.write(`${JSON.stringify(sources, null, 2)}\n`)
      else for (const source of sources) process.stdout.write(`${source.id} ${source.uri}\n`)
      return 0
    }
    case 'sources': {
      const registry = await loadSourceRegistry(root)
      if (args.flags.json === 'true')
        process.stdout.write(`${JSON.stringify(registry.sources, null, 2)}\n`)
      else {
        for (const source of registry.sources)
          process.stdout.write(`${source.id} ${source.title ?? source.uri} ${source.uri}\n`)
      }
      return 0
    }
    case 'apply-write-blocks': {
      const [proposalPath] = args.positional
      if (!proposalPath) {
        process.stderr.write('apply-write-blocks requires a proposal file\n')
        return 1
      }
      await initKnowledgeBase(root)
      const result = await applyKnowledgeWriteBlocksFile(root, resolve(proposalPath), {
        ...pages,
        ...intakeOption(args),
      })
      await writeKnowledgeIndex(root, pages)
      if (args.flags.json === 'true') process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      else {
        for (const path of result.written) process.stdout.write(`wrote ${path}\n`)
        for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`)
      }
      return result.warnings.length > 0 ? 2 : 0
    }
    case 'inspect': {
      const index = await loadOrBuildIndex(root, pages)
      const inspection = inspectKnowledgeIndex(index)
      if (args.flags.json === 'true')
        process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`)
      else {
        process.stdout.write(
          `pages=${inspection.pageCount} sources=${inspection.sourceCount} edges=${inspection.edgeCount} findings=${inspection.findingCount} blocking=${inspection.blockingFindingCount}\n`,
        )
        for (const page of inspection.topPages.slice(0, 5))
          process.stdout.write(`${page.degree} ${page.path} sources=${page.sources}\n`)
      }
      return inspection.blockingFindingCount > 0 ? 2 : 0
    }
    case 'explain': {
      const target = args.positional.join(' ')
      if (!target) {
        process.stderr.write('explain requires a page path, id, title, or query\n')
        return 1
      }
      const explanation = explainKnowledgeTarget(await loadOrBuildIndex(root, pages), target)
      if (args.flags.json === 'true')
        process.stdout.write(`${JSON.stringify(explanation, null, 2)}\n`)
      else {
        process.stdout.write(`${explanation.page ? explanation.page.title : target}\n`)
        for (const source of explanation.sources)
          process.stdout.write(`source ${source.id} ${source.title ?? source.uri}\n`)
        for (const link of explanation.links) process.stdout.write(`out ${link}\n`)
        for (const inbound of explanation.inbound) process.stdout.write(`in ${inbound}\n`)
        for (const related of explanation.related.slice(0, 5))
          process.stdout.write(`related ${related.path} score=${related.score.toFixed(5)}\n`)
      }
      return 0
    }
    case 'search': {
      const query = args.positional.join(' ')
      if (!query) {
        process.stderr.write('search requires a query\n')
        return 1
      }
      const index = await loadOrBuildIndex(root, pages)
      const results = searchKnowledge(index, query, Number(args.flags.limit ?? 10))
      if (args.flags.json === 'true') {
        process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
      } else {
        for (const result of results) {
          process.stdout.write(
            `${result.rank}. ${result.page.title} (${result.page.path}) score=${result.score.toFixed(5)}\n`,
          )
          if (result.snippet) process.stdout.write(`   ${result.snippet}\n`)
        }
      }
      return 0
    }
    case 'graph': {
      const index = await loadOrBuildIndex(root, pages)
      if ((args.flags.format ?? 'summary') === 'json')
        process.stdout.write(`${JSON.stringify(index.graph, null, 2)}\n`)
      else
        process.stdout.write(
          `nodes=${index.graph.nodes.length} edges=${index.graph.edges.length}\n`,
        )
      return 0
    }
    case 'lint': {
      const index = await loadOrBuildIndex(root, pages)
      const findings = lintKnowledgeIndex(index)
      if (args.flags.json === 'true') process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`)
      else {
        if (findings.length === 0) process.stdout.write('no findings\n')
        for (const finding of findings) {
          process.stdout.write(
            `${finding.severity.toUpperCase()} ${finding.type}${finding.page ? ` ${finding.page}` : ''}: ${finding.message}\n`,
          )
        }
      }
      return findings.some((finding) => finding.severity === 'error') ? 2 : 0
    }
    case 'validate': {
      const result = validateKnowledgeIndex(await loadOrBuildIndex(root, pages), {
        strict: args.flags.strict === 'true',
      })
      if (args.flags.json === 'true') process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      else {
        process.stdout.write(result.ok ? 'valid\n' : 'invalid\n')
        for (const finding of result.findings)
          process.stdout.write(
            `${finding.severity.toUpperCase()} ${finding.type}${finding.page ? ` ${finding.page}` : ''}: ${finding.message}\n`,
          )
      }
      return result.ok ? 0 : 2
    }
    case 'export': {
      const index = await loadOrBuildIndex(root, pages)
      const format = args.flags.format ?? 'json'
      if (format !== 'json') {
        process.stderr.write('export currently supports --format json\n')
        return 1
      }
      process.stdout.write(`${JSON.stringify(index, null, 2)}\n`)
      return 0
    }
    case 'viz': {
      const index = await loadOrBuildIndex(root, pages)
      const viz = toKnowledgeVizGraph(index.graph)
      const payload = {
        graph: viz,
        gaps: detectKnowledgeGaps(viz),
        surprisingConnections: findSurprisingConnections(viz),
      }
      if (args.flags.json === 'true') process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
      else {
        process.stdout.write(
          `communities=${viz.communities.length} gaps=${payload.gaps.length} surprising=${payload.surprisingConnections.length}\n`,
        )
      }
      return 0
    }
    case 'version': {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        version: string
      }
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

function pagesOptions(args: Args): KnowledgePagesOptions {
  const pagesDirectory = args.flags['pages-dir']
  if (pagesDirectory === undefined) return {}
  if (pagesDirectory === 'true') throw new Error('--pages-dir requires a directory')
  return { pagesDirectory }
}

function intakeOption(args: Args): Pick<ApplyKnowledgeWriteBlocksOptions, 'intake'> {
  const threshold = args.flags['intake-threshold']
  if (args.flags.intake !== 'true') {
    if (threshold !== undefined) throw new Error('--intake-threshold requires --intake')
    return {}
  }
  if (threshold === undefined) return { intake: {} }
  if (threshold === 'true') throw new Error('--intake-threshold requires a number')
  const parsed = Number(threshold)
  if (!Number.isFinite(parsed)) throw new Error(`--intake-threshold is not a number: ${threshold}`)
  return { intake: { nearDuplicates: { threshold: parsed } } }
}

async function loadOrBuildIndex(root: string, pages: KnowledgePagesOptions) {
  const path = join(layoutFor(root).cacheDir, 'index.json')
  if (existsSync(path))
    return JSON.parse(readFileSync(path, 'utf8')) as Awaited<ReturnType<typeof buildKnowledgeIndex>>
  return await writeKnowledgeIndex(root, pages)
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `agent-knowledge error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    )
    process.exit(1)
  })
