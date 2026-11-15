import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { chunkMarkdown, stripFrontmatter } from '../src/chunking'

function verify(content: string, options = {}) {
  const chunks = chunkMarkdown(content, options)
  for (const chunk of chunks) {
    assert.ok(chunk.charStart >= 0 && chunk.charEnd <= content.length)
    assert.equal(chunk.text, content.slice(chunk.charStart, chunk.charEnd))
  }
  return chunks
}

describe('chunk source coordinates', () => {
  it('preserves CRLF in the original-source slice', () => {
    const source = 'Clause A\r\n\r\nClause B'
    const chunk = verify(source)[0]!
    assert.equal(chunk.text, source)
    assert.equal(chunk.charEnd, source.length)
  })

  it('does not duplicate overlap while merging a tiny tail', () => {
    const source = `${'A'.repeat(80)}\n\n${'B'.repeat(5)}`
    const chunks = verify(source, {
      targetChars: 80,
      maxChars: 120,
      minChars: 30,
      overlapChars: 10,
    })
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0]!.text, source)
  })

  it('retains heading and source offsets after CRLF frontmatter', () => {
    const source = '---\r\ntitle: Evidence\r\n---\r\n# Agreement\r\n\r\n## Payment\r\nPay 10.\r\n'
    const chunks = verify(source)
    assert.ok(chunks.length > 0)
    assert.ok(chunks.every((chunk) => chunk.charStart >= source.indexOf('# Agreement')))
    assert.equal(chunks.at(-1)!.headingPath, '# Agreement > ## Payment')
    assert.ok(!stripFrontmatter(source).body.includes('\r\n'))
  })

  it('keeps UTF-16 coordinates and ignores headings inside fences', () => {
    const chunks = verify('# Facts\r\n😀 Evidence\r\n```\r\n## Not a heading\r\n```\r\n')
    assert.ok(chunks.every((chunk) => chunk.headingPath === '# Facts'))
  })

  it('retains exact coordinates across varied paragraph and overlap combinations', () => {
    for (let i = 0; i < 500; i++) {
      const newline = i % 2 ? '\r\n' : '\n'
      const content = Array.from(
        { length: 2 + (i % 11) },
        (_, n) => `${n}: ${(n % 2 ? 'β' : '📄').repeat(1 + ((i * 17 + n * 13) % 180))}`,
      ).join(newline + newline)
      verify(content, {
        targetChars: 40 + (i % 70),
        maxChars: 180,
        minChars: i % 40,
        overlapChars: i % 25,
      })
    }
  })

  it('preserves the legacy indivisible-paragraph default', () => {
    assert.deepEqual(chunkMarkdown(' \r\n '), [])
    const chunk = verify('x'.repeat(3000))[0]!
    assert.equal(chunk.oversized, true)
    assert.equal(chunk.text.length, 3000)
  })

  it('bounds an unbroken paragraph only on opt-in, with no gaps', () => {
    const source = 'Confidential information remains protected. '.repeat(1000).trimEnd()
    const chunks = verify(source, { splitOversized: true })
    assert.ok(chunks.length > 1)
    let covered = 0
    for (const chunk of chunks) {
      assert.ok(chunk.text.length <= 1500)
      assert.equal(chunk.oversized, false)
      assert.ok(chunk.charStart <= covered)
      covered = Math.max(covered, chunk.charEnd)
    }
    assert.equal(covered, source.length)
    assert.equal(chunkMarkdown(source).length, 1)
  })

  it('does not split a CRLF sequence or surrogate pair', () => {
    const source = '📄 Evidence\r\n'.repeat(100)
    const chunks = verify(source, {
      targetChars: 23,
      maxChars: 23,
      overlapChars: 7,
      splitOversized: true,
    })
    for (const chunk of chunks) {
      assert.ok(chunk.text.length <= 23)
      assert.ok(!/^[\uDC00-\uDFFF]/u.test(chunk.text))
      assert.ok(!/[\uD800-\uDBFF]$/u.test(chunk.text))
      assert.ok(!(source[chunk.charStart - 1] === '\r' && source[chunk.charStart] === '\n'))
      assert.ok(!(source[chunk.charEnd - 1] === '\r' && source[chunk.charEnd] === '\n'))
    }
  })

  it('rejects invalid bounded budgets and always makes progress', () => {
    for (const maxChars of [NaN, Infinity, -1, 1, 2.5]) {
      assert.throws(() => chunkMarkdown('long text', { splitOversized: true, maxChars }), /budgets/)
    }
    const source = '😀'.repeat(100)
    const chunks = verify(source, {
      splitOversized: true,
      targetChars: 2,
      maxChars: 2,
      overlapChars: 1,
      minChars: 0,
    })
    assert.equal(chunks.length, 100)
  })

  it('aligns paragraph-overlap starts and internal bounded cuts', () => {
    for (let i = 2; i < 60; i++) {
      const source = `${'😀'.repeat(i)}\r\n\r\n${'β'.repeat(i)}\r\n\r\n`.repeat(3)
      const chunks = verify(source, {
        targetChars: 40,
        maxChars: 60,
        overlapChars: 3,
        minChars: 0,
        splitOversized: true,
      })
      for (const chunk of chunks) {
        assert.ok(!/^[\uDC00-\uDFFF]/u.test(chunk.text))
        assert.ok(!/[\uD800-\uDBFF]$/u.test(chunk.text))
        assert.ok(chunk.text.length <= 60)
      }
    }
  })
})
