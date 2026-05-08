import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

import {
  addSourcePath,
  applyKnowledgeWriteBlocks,
  buildKnowledgeIndex,
  buildEvalKnowledgeBundle,
  defineReadinessSpec,
  READINESS_SPEC_DEFAULTS,
  chunkMarkdown,
  createKnowledgeEvent,
  createLocalDiscoveryDispatcher,
  explainKnowledgeTarget,
  initKnowledgeBase,
  inspectKnowledgeIndex,
  KnowledgeIndexSchema,
  MemoryKbStore,
  runKnowledgeResearchLoop,
  lintKnowledgeIndex,
  parseKnowledgeWriteBlocks,
  reciprocalRankFusion,
  searchKnowledge,
  validateKnowledgeIndex,
  writeSourceRegistry,
} from '../src/index'
import { detectKnowledgeGaps, findSurprisingConnections, toKnowledgeVizGraph } from '../src/viz/index'

async function withProject(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-knowledge-'))
  try {
    await initKnowledgeBase(root)
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('knowledge write protocol', () => {
  it('parses safe FILE blocks and rejects path traversal', () => {
    const parsed = parseKnowledgeWriteBlocks([
      '---FILE: knowledge/concepts/attention.md---',
      '# Attention',
      '```',
      '---END FILE---',
      '```',
      '---END FILE---',
      '---FILE: ../escape.md---',
      'bad',
      '---END FILE---',
    ].join('\n'))

    expect(parsed.blocks).toHaveLength(1)
    expect(parsed.blocks[0]?.path).toBe('knowledge/concepts/attention.md')
    expect(parsed.blocks[0]?.content).toContain('---END FILE---')
    expect(parsed.warnings[0]).toContain('unsafe path')
  })
})

describe('chunkMarkdown', () => {
  it('preserves heading breadcrumbs and strips frontmatter', () => {
    const chunks = chunkMarkdown('---\ntitle: Test\n---\n# Alpha\n\none\n\n## Beta\n\ntwo', {
      targetChars: 20,
      maxChars: 30,
      minChars: 1,
      overlapChars: 2,
    })
    expect(chunks.some((chunk) => chunk.text.includes('title: Test'))).toBe(false)
    expect(chunks.map((chunk) => chunk.headingPath)).toContain('# Alpha > ## Beta')
  })
})

describe('index/search/lint/viz', () => {
  it('builds graph, searches with RRF, and reports structural findings', async () => {
    await withProject(async (root) => {
      await mkdir(join(root, 'knowledge', 'concepts'), { recursive: true })
      const sourcePath = join(root, 'seed.md')
      await writeFile(sourcePath, '# Seed\n\nEvidence about attention.')
      const [source] = await addSourcePath(root, sourcePath, { now: () => new Date('2026-01-01T00:00:00.000Z') })
      await writeSourceRegistry(root, {
        generatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
        sources: [{
          ...source!,
          validUntil: '2026-05-04T00:00:00.000Z',
          lastVerifiedAt: '2026-04-01T00:00:00.000Z',
        }],
      })
      await writeFile(join(root, 'knowledge', 'concepts', 'attention.md'), [
        '---',
        'id: attention',
        'title: Attention',
        'sources:',
        `  - ${source!.id}`,
        'tags:',
        '  - transformer',
        '---',
        '# Attention',
        `Attention links to [[Flash Attention]] and cites an anchor [^${source!.id}#all].`,
      ].join('\n'))
      await writeFile(join(root, 'knowledge', 'concepts', 'flash-attention.md'), [
        '---',
        'id: flash-attention',
        'title: Flash Attention',
        'sources:',
        `  - ${source!.id}`,
        '---',
        '# Flash Attention',
        'IO aware claim about memory bandwidth.',
      ].join('\n'))
      await writeFile(join(root, 'knowledge', 'concepts', 'orphan.md'), '# Orphan\n\nNo links here.')

      const index = await buildKnowledgeIndex(root)
      expect(index.sources).toHaveLength(1)
      // 3 authored pages: attention, flash-attention, orphan. Scaffold files
      // (knowledge/index.md, knowledge/log.md) are excluded by isScaffoldPath.
      expect(index.pages).toHaveLength(3)
      expect(index.pages.map((page) => page.path)).not.toContain('knowledge/index.md')
      expect(index.pages.map((page) => page.path)).not.toContain('knowledge/log.md')
      expect(index.graph.edges.some((edge) => edge.source === 'attention' && edge.target === 'flash-attention')).toBe(true)

      const fused = reciprocalRankFusion([['a', 'b'], ['b']])
      expect(fused.get('b')).toBeGreaterThan(fused.get('a'))

      const results = searchKnowledge(index, 'memory bandwidth', 2)
      expect(results[0]?.page.title).toBe('Flash Attention')

      // Score contract: `score` and `rrfScore` are the raw RRF value
      // (~0.01–0.05 absolute), `normalizedScore` is in [0, 1] relative to the
      // top hit so callers can use natural thresholds.
      const top = results[0]!
      expect(top.score).toBe(top.rrfScore)
      expect(top.score).toBeGreaterThan(0)
      expect(top.score).toBeLessThan(0.1)
      expect(top.normalizedScore).toBe(1)
      for (const hit of results) {
        expect(hit.normalizedScore).toBeGreaterThan(0)
        expect(hit.normalizedScore).toBeLessThanOrEqual(1)
        expect(hit.rrfScore).toBe(hit.score)
        // normalizedScore matches score / topScore exactly.
        expect(hit.normalizedScore).toBeCloseTo(hit.score / top.score, 12)
      }

      const readiness = buildEvalKnowledgeBundle({
        taskId: 'coding-task',
        index,
        now: new Date('2026-05-03T00:00:00.000Z'),
        specs: [{
          id: 'attention-doc',
          description: 'Attention implementation note',
          query: 'memory bandwidth',
          requiredFor: ['coding-task'],
          category: 'codebase_specific',
          acquisitionMode: 'inspect_repo',
          importance: 'blocking',
          freshness: 'weekly',
          sensitivity: 'public',
          confidenceNeeded: 0.8,
          minSources: 1,
        }, {
          id: 'missing-secret',
          description: 'Deployment token',
          query: 'deployment token',
          requiredFor: ['deploy-task'],
          category: 'credential_or_secret',
          acquisitionMode: 'ask_user',
          importance: 'blocking',
          freshness: 'daily',
          sensitivity: 'secret',
          confidenceNeeded: 1,
        }],
      })
      expect(readiness.report.blockingMissingRequirements.map((r) => r.id)).toEqual(['missing-secret'])
      expect(readiness.questions[0]?.answerType).toBe('credential')
      expect(readiness.acquisitionPlans.some((plan) => plan.mode === 'ask_user')).toBe(true)
      expect(readiness.bundle.wikiPageIds).toContain('flash-attention')

      const staleReadiness = buildEvalKnowledgeBundle({
        taskId: 'stale-tax-task',
        index,
        now: new Date('2026-05-05T00:00:00.000Z'),
        specs: [{
          id: 'current-source',
          description: 'Current source-backed page',
          query: 'memory bandwidth',
          requiredFor: ['stale-tax-task'],
          category: 'regulatory',
          acquisitionMode: 'search_web',
          importance: 'blocking',
          freshness: 'daily',
          sensitivity: 'public',
          confidenceNeeded: 0.8,
          minSources: 1,
        }],
      })
      expect(staleReadiness.report.blockingMissingRequirements.map((requirement) => requirement.id)).toEqual(['current-source'])
      expect(staleReadiness.requirements[0]?.metadata?.expiredSourceIds).toEqual([source!.id])

      const findings = lintKnowledgeIndex(index)
      expect(findings.some((finding) => finding.type === 'orphan')).toBe(true)
      expect(findings.some((finding) => finding.type === 'missing-source')).toBe(false)

      const inspection = inspectKnowledgeIndex(index, { now: new Date('2026-05-05T00:00:00.000Z') })
      expect(inspection.sourceCount).toBe(1)
      expect(inspection.expiredSourceCount).toBe(1)
      expect(inspection.sourceFreshness[0]).toMatchObject({ id: source!.id, status: 'expired' })
      expect(KnowledgeIndexSchema.parse(index).pages.length).toBe(index.pages.length)
      const explanation = explainKnowledgeTarget(index, 'attention')
      expect(explanation.sources[0]?.id).toBe(source!.id)

      const viz = toKnowledgeVizGraph(index.graph)
      expect(detectKnowledgeGaps(viz).length).toBeGreaterThan(0)
      expect(findSurprisingConnections(viz)).toEqual(expect.any(Array))
    })
  })

  it('defineReadinessSpec fills sane defaults and round-trips through buildEvalKnowledgeBundle', async () => {
    // Defaults are applied verbatim when omitted.
    const slim = defineReadinessSpec({
      id: 'topic/grounding',
      description: 'Required grounding for the agent',
      query: 'memory bandwidth attention',
      requiredFor: ['some-agent'],
    })
    expect(slim).toMatchObject({
      ...READINESS_SPEC_DEFAULTS,
      id: 'topic/grounding',
      description: 'Required grounding for the agent',
      query: 'memory bandwidth attention',
      requiredFor: ['some-agent'],
    })

    // Overrides win — every defaulted field is overridable.
    const overridden = defineReadinessSpec({
      id: 'medical/dosing',
      description: 'Dosing guidance',
      query: 'compounding dose',
      requiredFor: ['DosingAgent'],
      importance: 'blocking',
      freshness: 'daily',
      sensitivity: 'private',
      confidenceNeeded: 0.95,
      minSources: 3,
      minHits: 5,
      acquisitionMode: 'ask_user',
      category: 'regulatory',
    })
    expect(overridden.importance).toBe('blocking')
    expect(overridden.freshness).toBe('daily')
    expect(overridden.sensitivity).toBe('private')
    expect(overridden.confidenceNeeded).toBe(0.95)
    expect(overridden.minSources).toBe(3)
    expect(overridden.minHits).toBe(5)
    expect(overridden.acquisitionMode).toBe('ask_user')
    expect(overridden.category).toBe('regulatory')

    // Round-trips through buildEvalKnowledgeBundle without surprises.
    await withProject(async (root) => {
      const index = await buildKnowledgeIndex(root)
      const result = buildEvalKnowledgeBundle({
        taskId: 'define-readiness-spec-roundtrip',
        index,
        specs: [
          defineReadinessSpec({
            id: 'topic/a',
            description: 'A',
            query: 'unmatched',
            requiredFor: ['agent'],
          }),
        ],
      })
      expect(result.requirements[0]?.id).toBe('topic/a')
      // Default importance is "high" — non-blocking, so this should appear in
      // nonBlockingGaps when the KB is empty (default test corpus).
      expect(result.report.blockingMissingRequirements.find((r) => r.id === 'topic/a')).toBeUndefined()
      expect(result.report.nonBlockingGaps.find((r) => r.id === 'topic/a')).toBeDefined()
    })
  })

  it('excludes scaffold files (index.md, log.md) from the page index after init', async () => {
    // Regression: initKnowledgeBase writes knowledge/index.md and knowledge/log.md
    // as human-navigation scaffolds. They must not appear as searchable pages,
    // because that inflates page/chunk counts and pollutes search results.
    await withProject(async (root) => {
      const index = await buildKnowledgeIndex(root)
      expect(index.pages).toHaveLength(0)

      await mkdir(join(root, 'knowledge', 'concepts'), { recursive: true })
      await writeFile(join(root, 'knowledge', 'concepts', 'real.md'), '# Real\n\nAuthored content.\n')
      // Subdirectory scaffolds (e.g. knowledge/concepts/index.md) are also excluded.
      await writeFile(join(root, 'knowledge', 'concepts', 'index.md'), '# Concepts Index\n\n')

      const next = await buildKnowledgeIndex(root)
      expect(next.pages).toHaveLength(1)
      expect(next.pages[0]?.path).toBe('knowledge/concepts/real.md')

      // Search results never surface scaffold paths.
      const hits = searchKnowledge(next, 'Knowledge Index', 5)
      expect(hits.every((hit) => !hit.page.path.endsWith('/index.md') && !hit.page.path.endsWith('/log.md'))).toBe(true)
    })
  })

  it('fails lint on pages citing unregistered sources', async () => {
    await withProject(async (root) => {
      await mkdir(join(root, 'knowledge', 'concepts'), { recursive: true })
      await writeFile(join(root, 'knowledge', 'concepts', 'bad-source.md'), [
        '---',
        'id: bad-source',
        'title: Bad Source',
        'sources:',
        '  - made_up_source',
        '---',
        '# Bad Source',
        'A claim with fake provenance.',
      ].join('\n'))

      const index = await buildKnowledgeIndex(root)
      const findings = lintKnowledgeIndex(index)
      expect(findings.some((finding) => finding.type === 'missing-source' && finding.severity === 'error')).toBe(true)
    })
  })

  it('applies safe write blocks and rejects invalid anchors', async () => {
    await withProject(async (root) => {
      const [source] = await addSourcePath(root, join(root, 'knowledge', 'index.md'), { now: () => new Date('2026-01-01T00:00:00.000Z') })
      await applyKnowledgeWriteBlocks(root, [
        '---FILE: knowledge/concepts/generated.md---',
        '---',
        'id: generated',
        'title: Generated',
        'sources:',
        `  - ${source!.id}`,
        '---',
        '# Generated',
        `Claim with invalid anchor [^${source!.id}#missing].`,
        '---END FILE---',
      ].join('\n'))

      const findings = lintKnowledgeIndex(await buildKnowledgeIndex(root))
      expect(findings.some((finding) => finding.type === 'missing-source' && String(finding.message).includes('#missing'))).toBe(true)
    })
  })

  it('validates strict frontmatter and exposes store/event contracts', async () => {
    await withProject(async (root) => {
      expect(validateKnowledgeIndex(await buildKnowledgeIndex(root), { strict: true }).ok).toBe(true)

      await mkdir(join(root, 'knowledge', 'notes'), { recursive: true })
      await writeFile(join(root, 'knowledge', 'notes', 'draft.md'), '# Draft\n\nMissing required strict metadata.\n')

      const index = await buildKnowledgeIndex(root)
      const validation = validateKnowledgeIndex(index, { strict: true })
      expect(validation.ok).toBe(false)

      const store = new MemoryKbStore()
      for (const page of index.pages) await store.putPage(page)
      for (const source of index.sources) await store.putSource(source)
      const event = createKnowledgeEvent({ type: 'index.built', target: root, now: () => new Date('2026-01-01T00:00:00.000Z') })
      await store.putEvent(event)
      expect(await store.getIndex()).toBeTruthy()
      expect((await store.listEvents({ type: 'index.built' }))[0]?.id).toBe(event.id)
    })
  })

  it('runs local discovery tasks with bounded concurrency', async () => {
    const dispatcher = createLocalDiscoveryDispatcher({
      run: async (task) => ({ taskId: task.id, summary: `done ${task.goal}` }),
    })
    const results = await dispatcher.dispatch([
      { id: 'a', goal: 'alpha' },
      { id: 'b', goal: 'beta' },
    ], { concurrency: 2 })
    expect(results.map((result) => result.taskId)).toEqual(['a', 'b'])
  })

  it('runs a small researcher-driven wiki growth loop without owning researcher judgment', async () => {
    await withProject(async (root) => {
      const result = await runKnowledgeResearchLoop({
        root,
        goal: 'Build a compact wiki page about refund policy',
        maxIterations: 2,
        readinessSpecs: [defineReadinessSpec({
          id: 'refund-policy',
          description: 'Refund policy grounding',
          query: 'refund policy customer request',
          requiredFor: ['support-agent'],
          minSources: 0,
          minHits: 1,
        })],
        step: ({ iteration, readiness }) => {
          if (iteration === 1) {
            return {
              notes: 'Collected source text and wrote one cited-ready page.',
              sourceTexts: [{
                uri: 'memory://support/refunds',
                title: 'Refund Policy Notes',
                text: 'Customers may request a refund within 30 days when the product has not been used.',
              }],
              proposalText: [
                '---FILE: knowledge/support/refund-policy.md---',
                '---',
                'id: refund-policy',
                'title: Refund Policy',
                'tags:',
                '  - support',
                '---',
                '# Refund Policy',
                'Customers may request a refund within 30 days when the product has not been used.',
                '---END FILE---',
              ].join('\n'),
            }
          }
          return {
            notes: `Readiness score ${readiness?.report.readinessScore ?? 0}`,
            done: true,
          }
        },
      })

      expect(result.done).toBe(true)
      expect(result.iterations).toBe(2)
      expect(result.index.sources).toHaveLength(1)
      expect(result.index.pages.map((page) => page.id)).toContain('refund-policy')
      expect(result.steps[0]?.applied?.written).toEqual(['knowledge/support/refund-policy.md'])
      expect(result.steps[1]?.readiness?.report.blockingMissingRequirements).toEqual([])
      expect(result.steps[0]?.event.type).toBe('research.iteration')
    })
  })
})
