import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

import {
  addSourcePath,
  buildKnowledgeIndex,
  chunkMarkdown,
  initKnowledgeBase,
  lintKnowledgeIndex,
  parseKnowledgeWriteBlocks,
  reciprocalRankFusion,
  searchKnowledge,
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
        'Attention links to [[Flash Attention]].',
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
      expect(index.pages).toHaveLength(5) // includes index.md and log.md
      expect(index.graph.edges.some((edge) => edge.source === 'attention' && edge.target === 'flash-attention')).toBe(true)

      const fused = reciprocalRankFusion([['a', 'b'], ['b']])
      expect(fused.get('b')).toBeGreaterThan(fused.get('a'))

      const results = searchKnowledge(index, 'memory bandwidth', 2)
      expect(results[0]?.page.title).toBe('Flash Attention')

      const findings = lintKnowledgeIndex(index)
      expect(findings.some((finding) => finding.type === 'orphan')).toBe(true)
      expect(findings.some((finding) => finding.type === 'missing-source')).toBe(false)

      const viz = toKnowledgeVizGraph(index.graph)
      expect(detectKnowledgeGaps(viz).length).toBeGreaterThan(0)
      expect(findSurprisingConnections(viz)).toEqual(expect.any(Array))
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
})
