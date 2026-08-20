import { describe, expect, it } from 'vitest'
import { DEFAULT_PAGES_DIRECTORY, normalizePagesDirectory } from './pages-directory'

describe('normalizePagesDirectory', () => {
  it('returns the default when no directory is named', () => {
    expect(normalizePagesDirectory()).toBe(DEFAULT_PAGES_DIRECTORY)
    expect(normalizePagesDirectory(undefined)).toBe('knowledge')
  })

  it('canonicalizes a relative directory to a bare root-relative form', () => {
    expect(normalizePagesDirectory('./kb/pages/')).toBe('kb/pages')
    expect(normalizePagesDirectory('kb\\pages\\line-a')).toBe('kb/pages/line-a')
    expect(normalizePagesDirectory('knowledge')).toBe('knowledge')
  })

  it.each([
    ['', /root-relative directory/],
    ['.', /root-relative directory/],
    ['./', /root-relative directory/],
    ['/', /root-relative directory/],
    ['/abs/pages', /root-relative, not absolute/],
    ['\\\\server\\share', /root-relative, not absolute/],
    ['C:/pages', /root-relative, not absolute/],
    ['../escape', /dot segments/],
    ['kb/../pages', /dot segments/],
    ['kb/./pages', /dot segments/],
    ['kb//pages', /empty or dot segments/],
    ['.agent-knowledge', /package-owned \.agent-knowledge/],
    ['.agent-knowledge/pages', /package-owned \.agent-knowledge/],
    ['raw', /package-owned raw/],
    ['raw/sources', /package-owned raw/],
    ['kb\u0000pages', /control characters/],
  ])('refuses %j', (value, message) => {
    expect(() => normalizePagesDirectory(value)).toThrow(message)
  })
})
