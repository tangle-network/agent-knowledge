import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatFrontmatter } from './frontmatter'
import { lintKnowledgeIndex } from './lint'
import { initKnowledgeBase, loadKnowledgePages } from './store'
import type { KnowledgeIndex, KnowledgePage } from './types'

function page(
  id: string,
  frontmatter: Record<string, unknown> = {},
  overrides: Partial<KnowledgePage> = {},
): KnowledgePage {
  return {
    id,
    path: `knowledge/${id}.md`,
    title: id,
    text: 'Measured result.',
    frontmatter: { id, ...frontmatter },
    sourceIds: [],
    tags: [],
    outLinks: [],
    ...overrides,
  }
}

function index(pages: KnowledgePage[]): KnowledgeIndex {
  return {
    root: '/kb',
    generatedAt: '2026-08-17T00:00:00.000Z',
    sources: [],
    pages,
    graph: { nodes: [], edges: [] },
  }
}

function findingTypes(pages: KnowledgePage[]): string[] {
  return lintKnowledgeIndex(index(pages)).map((finding) => finding.type)
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'page-evidence-integrity-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('page evidence lint', () => {
  it('accepts gradeable, portable rung-four evidence', () => {
    const findings = lintKnowledgeIndex(
      index([
        page('verified', {
          rung: 4,
          check: 'python3 checks/result.py',
          expect: 'value=42',
          evidencePath: 'results/value.json',
        }),
      ]),
    )

    expect(findings.filter((finding) => finding.type.includes('evidence'))).toEqual([])
  })

  it('reports evidence that claims a checkable rung without gradeable fields', () => {
    const findings = lintKnowledgeIndex(index([page('self-graded', { rung: 5 })]))

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'ungradeable-evidence', severity: 'error' }),
        expect.objectContaining({ type: 'missing-evidence-path', severity: 'warning' }),
      ]),
    )
  })

  it('reports author-machine absolute paths without confusing them with a contradiction', () => {
    const findings = lintKnowledgeIndex(
      index([
        page('nonportable', {
          rung: 4,
          check: 'python3 /Users/example/work/check.py',
          expect: 'value=42',
          evidencePath: '/tmp/run/result.json',
        }),
      ]),
    )

    expect(findings.filter((finding) => finding.type === 'nonportable-evidence')).toHaveLength(2)
    expect(findings.some((finding) => finding.type === 'ungradeable-evidence')).toBe(false)
  })
})

describe('page contradiction and invalidation lint', () => {
  it('accepts an existing contradiction target and a calibrated invalidation', () => {
    const invalidation = {
      verdict: 'contradicted' as const,
      observedAt: '2026-08-17T00:00:00.000Z',
      reason: 'The independently executed check printed value=43, not value=42.',
      evidencePath: 'oracle/claim.json',
      grader: 'blind-oracle-v1',
    }
    const target = page('old-claim', { invalidation }, { invalidation })
    const refuter = page('new-claim', { contradicts: ['old-claim'] }, { contradicts: ['old-claim'] })

    const types = findingTypes([target, refuter])

    expect(types).not.toContain('broken-contradiction')
    expect(types).not.toContain('invalid-invalidation')
  })

  it('refuses missing and self contradiction targets', () => {
    const findings = lintKnowledgeIndex(
      index([
        page(
          'claim-a',
          { contradicts: ['claim-a', 'missing'] },
          { contradicts: ['claim-a', 'missing'] },
        ),
      ]),
    )

    expect(findings.filter((finding) => finding.type === 'broken-contradiction')).toHaveLength(2)
  })

  it('refuses an invalidation that does not record an actual contradiction', () => {
    const findings = lintKnowledgeIndex(
      index([
        page('unknown-claim', {
          invalidation: {
            verdict: 'unrunnable',
            observedAt: 'yesterday',
            reason: '',
          },
        }),
      ]),
    )

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'invalid-invalidation', severity: 'error' }),
      ]),
    )
  })
})

describe('page metadata loading', () => {
  it('loads string or array contradiction pointers and a typed invalidation', async () => {
    await initKnowledgeBase(root)
    await mkdir(join(root, 'knowledge', 'line'), { recursive: true })
    const invalidation = {
      verdict: 'contradicted' as const,
      observedAt: '2026-08-17T00:00:00.000Z',
      reason: 'Independent check refuted the page.',
      grader: 'blind-oracle-v1',
    }
    await writeFile(
      join(root, 'knowledge', 'line', 'claim.md'),
      formatFrontmatter(
        {
          id: 'claim',
          title: 'Claim',
          contradicts: 'older-claim',
          invalidation,
        },
        '# Claim\n',
      ),
    )

    const pages = await loadKnowledgePages(root)

    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({
      id: 'claim',
      contradicts: ['older-claim'],
      invalidation,
    })
  })
})
