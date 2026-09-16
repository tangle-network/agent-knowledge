import { describe, expect, it } from 'vitest'
import { malformedKnowledgeRecordCalls } from './knowledge-record.test-fixture'
import { parseKnowledgeWriteBlocks } from './write-protocol'

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
