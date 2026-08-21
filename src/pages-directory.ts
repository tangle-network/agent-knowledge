/** Root-relative directory that holds Markdown pages when a caller names none. */
export const DEFAULT_PAGES_DIRECTORY = 'knowledge'

/**
 * Selects the root-relative directory that holds Markdown pages.
 *
 * The same option drives the reader, the indexer, the search provider, the
 * run-scoped chain, and the write protocol, so a store laid out as
 * `kb/pages/<line>/` is read and written through one value.
 */
export interface KnowledgePagesOptions {
  /** Root-relative directory that holds Markdown pages. Defaults to `knowledge`. */
  pagesDirectory?: string
}

/**
 * Validate a pages directory and return its canonical root-relative form.
 *
 * The result is a write allowlist prefix as well as a read location, so the
 * check refuses every value that could reach outside the pages tree: absolute
 * paths, drive letters, `..` or `.` segments, empty segments, control
 * characters, and the package-owned `.agent-knowledge` and `raw` trees.
 */
export function normalizePagesDirectory(value: string = DEFAULT_PAGES_DIRECTORY): string {
  if (typeof value !== 'string') throw new Error('pagesDirectory must be a string')
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (normalized.length === 0 || normalized === '.') {
    throw new Error('pagesDirectory must name a root-relative directory')
  }
  // Built via String.fromCharCode so biome's control-character regex rule
  // does not flag an inline escape.
  const controlRange = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}]`)
  if (controlRange.test(normalized)) {
    throw new Error('pagesDirectory must not contain control characters')
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`pagesDirectory must be root-relative, not absolute: ${value}`)
  }
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`pagesDirectory must not contain empty or dot segments: ${value}`)
  }
  if (segments[0] === '.agent-knowledge' || segments[0] === 'raw') {
    throw new Error(`pagesDirectory must not name the package-owned ${segments[0]} tree: ${value}`)
  }
  return normalized
}
