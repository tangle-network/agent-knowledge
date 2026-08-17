import { describe, expect, it } from 'vitest'
import { formatFrontmatter, parseFrontmatter } from './frontmatter'

function roundTrip(frontmatter: Record<string, unknown>): Record<string, unknown> {
  return parseFrontmatter(formatFrontmatter(frontmatter, '# body\n')).frontmatter
}

describe('frontmatter round-trip', () => {
  it('preserves a multiline command on one physical frontmatter line', () => {
    const check = 'python3 - <<EOF\nprint(1337)\nEOF'
    const encoded = formatFrontmatter({ check }, '# body\n')

    expect(encoded).toContain(`check: ${JSON.stringify(check)}`)
    expect(parseFrontmatter(encoded)).toEqual({
      frontmatter: { check },
      body: '# body\n',
    })
  })

  it('preserves strings that the scalar parser would otherwise coerce or trim', () => {
    const values = {
      empty: '',
      leading: '  retained',
      trailing: 'retained  ',
      booleanText: 'true',
      integerText: '42',
      decimalText: '-1.5',
      quoted: '"literal"',
      singleQuoted: "'literal'",
      bracketed: '[not, an, array]',
      objectText: '{"not":"an object"}',
    }

    expect(roundTrip(values)).toEqual(values)
  })

  it('preserves structured values and unsafe strings inside arrays', () => {
    const values = {
      list: ['plain', 'two\nlines', ' true ', '42', '[literal]'],
      object: { nested: true, count: 2 },
    }

    expect(roundTrip(values)).toEqual(values)
  })

  it('keeps reading the existing simple frontmatter syntax', () => {
    expect(
      parseFrontmatter(`---\ntitle: Example\nenabled: true\ncount: 2\ntags:\n  - alpha\n  - beta\ninline: [alpha, beta]\n---\nBody\n`),
    ).toEqual({
      frontmatter: {
        title: 'Example',
        enabled: true,
        count: 2,
        tags: ['alpha', 'beta'],
        inline: ['alpha', 'beta'],
      },
      body: 'Body\n',
    })
  })
})
