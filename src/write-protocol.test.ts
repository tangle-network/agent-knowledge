import { describe, expect, it } from 'vitest'
import { malformedKnowledgeRecordCalls } from './knowledge-record.test-fixture'
import { parseKnowledgeProposal, parseKnowledgeWriteBlocks } from './write-protocol'

describe('knowledge FILE boundaries', () => {
  it('does not swallow the next page when the previous block lacks a closer', () => {
    const parsed = parseKnowledgeWriteBlocks(malformedKnowledgeRecordCalls[1].proposal, ['pages/'])

    expect(parsed.blocks).toEqual([
      { path: 'pages/glm-b/tmp-format-probe-b.md', content: 'probe b' },
    ])
    expect(parsed.warnings).toHaveLength(2)
    expect(parsed.warnings[0]).toContain('next FILE block')
    expect(parsed.warnings[0]).toContain('---END FILE---')
  })

  it.each(['```', '~~~'])('preserves FILE delimiters inside %s fences', (fence) => {
    const content = [
      '# Write syntax',
      fence,
      '---FILE: knowledge/example.md---',
      'Example content',
      '---END FILE---',
      fence,
    ].join('\n')
    const parsed = parseKnowledgeWriteBlocks(
      `---FILE: knowledge/syntax.md---\n${content}\n---END FILE---`,
    )

    expect(parsed).toEqual({
      blocks: [{ path: 'knowledge/syntax.md', content }],
      warnings: [],
    })
  })

  it('preserves case-insensitive delimiters, whitespace, CRLF, and valid adjacent pages', () => {
    const parsed = parseKnowledgeWriteBlocks(
      '--- file: knowledge/a.md ---\r\nA\r\n--- end file ---\r\n---FILE: knowledge/b.md---\r\nB\r\n---END FILE---',
    )
    expect(parsed).toEqual({
      blocks: [
        { path: 'knowledge/a.md', content: 'A' },
        { path: 'knowledge/b.md', content: 'B' },
      ],
      warnings: [],
    })
  })
})

describe('knowledge DELETE lines', () => {
  it('parses deletions beside pages and keeps the FILE-only result unchanged', () => {
    const text = [
      '---DELETE: knowledge/old.md---',
      '---FILE: knowledge/new.md---',
      'New page',
      '---DELETE: knowledge/inside.md---',
      '---END FILE---',
      '--- delete:  knowledge/old.md ---',
    ].join('\n')
    const blocks = [
      { path: 'knowledge/new.md', content: 'New page\n---DELETE: knowledge/inside.md---' },
    ]

    expect(parseKnowledgeProposal(text)).toEqual({
      blocks,
      deletes: ['knowledge/old.md'],
      warnings: [],
    })
    expect(parseKnowledgeWriteBlocks(text)).toEqual({ blocks, warnings: [] })
  })

  it('warns on an unsafe deletion and on a page both written and deleted', () => {
    const parsed = parseKnowledgeProposal(
      [
        '---DELETE: ../outside.md---',
        '---DELETE: raw/source.md---',
        '---FILE: knowledge/a.md---',
        'A',
        '---END FILE---',
        '---DELETE: knowledge/a.md---',
      ].join('\n'),
    )

    expect(parsed.deletes).toEqual(['knowledge/a.md'])
    expect(parsed.warnings).toEqual([
      'DELETE block with unsafe path "../outside.md" rejected.',
      'DELETE block with unsafe path "raw/source.md" rejected.',
      'Page "knowledge/a.md" is both written and deleted in one proposal.',
    ])
  })
})
