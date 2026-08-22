#!/usr/bin/env node
/**
 * Fail a path comparison that does not canonicalize the paths it compares.
 *
 * `resolve` is lexical. It expands `.` and `..` and makes a path absolute, and
 * it stops there: it cannot read a symbolic link. Two strings that name one
 * directory therefore compare as different whenever one of them has been
 * through `realpath` and the other has not.
 *
 * That state is not rare in this package. `openSafeDirectoryTree` canonicalizes
 * the root it opens, so every path a caller receives through `withSafeDirectory`
 * is canonical, while a path the same caller builds with `join` is not. On macOS
 * the operating system supplies the asymmetry unaided: `os.tmpdir()` is
 * `/var/folders/...`, a link to `/private/var/folders/...`.
 *
 * The failure is silent in CI. Linux `/tmp` is a real directory, so the two
 * forms coincide and a lexical comparison looks correct on the machine that
 * gates the merge, while it rejects a directory that is genuinely inside the
 * root on the machine that runs the code.
 *
 * So path comparison has one owner, `src/durable-fs.ts`, which canonicalizes
 * both sides before it compares them:
 *
 *   - `relativeWithinRoot(root, candidate)` — lexical, for two paths that
 *     already share one basis.
 *   - `canonicalRelativeWithinRoot(root, candidate)` — canonicalizes both sides.
 *   - `canonicalPathsEqual(left, right)` — the same, for equality.
 *
 * This check rejects the three shapes that reimplement one of those inline.
 *
 * Usage: pnpm run check:path-containment
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'

const repoRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const sourceRoot = join(repoRoot, 'src')

/** The one module allowed to compare two filesystem paths. */
const owner = join(sourceRoot, 'durable-fs.ts')

const files = []
const collect = (directory) => {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      collect(path)
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(path)
    }
  }
}
collect(sourceRoot)

const findings = []

function walk(node, visit) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  if (typeof node.type === 'string') visit(node)
  for (const key of Object.keys(node)) {
    if (key === 'type') continue
    walk(node[key], visit)
  }
}

const isCallTo = (node, name) =>
  node?.type === 'CallExpression' &&
  node.callee?.type === 'Identifier' &&
  node.callee.name === name

const isStringLiteral = (node, value) =>
  node?.type === 'Literal' && node.value === value

/** A template that interpolates the path separator builds a prefix to compare against. */
const interpolatesSeparator = (node) =>
  node?.type === 'TemplateLiteral' &&
  node.expressions.some(
    (expression) => expression.type === 'Identifier' && expression.name === 'sep',
  )

for (const file of files) {
  if (file === owner) continue
  const source = readFileSync(file, 'utf8')
  const parsed = parseSync(file, source, { lang: 'ts' })
  if (parsed.errors.length > 0) {
    throw new Error(`${file} failed to parse: ${parsed.errors[0].message}`)
  }
  const where = (node) => `${relative(repoRoot, file)}:${source.slice(0, node.start).split('\n').length}`

  walk(parsed.program, (node) => {
    // `candidate.startsWith(`${root}${sep}`)` — a prefix test standing in for containment.
    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'MemberExpression' &&
      node.callee.property?.name === 'startsWith' &&
      node.arguments.length === 1
    ) {
      if (interpolatesSeparator(node.arguments[0])) {
        findings.push(
          `${where(node)}: a path prefix test built from \`sep\`. Call relativeWithinRoot or canonicalRelativeWithinRoot from durable-fs instead.`,
        )
      }
      if (isStringLiteral(node.arguments[0], '../')) {
        findings.push(
          `${where(node)}: an inline escape test on a relative path. Call relativeWithinRoot or canonicalRelativeWithinRoot from durable-fs instead.`,
        )
      }
    }

    // `relative(a, b) === '..'` — the same escape test written as a comparison.
    if (
      node.type === 'BinaryExpression' &&
      ['===', '!==', '==', '!='].includes(node.operator) &&
      (isStringLiteral(node.right, '..') || isStringLiteral(node.left, '..'))
    ) {
      const other = isStringLiteral(node.right, '..') ? node.left : node.right
      if (isCallTo(other, 'relative')) {
        findings.push(
          `${where(node)}: an inline escape test on relative(). Call relativeWithinRoot or canonicalRelativeWithinRoot from durable-fs instead.`,
        )
      }
    }

    // `resolve(a) === resolve(b)` — two paths compared without canonicalizing either.
    if (
      node.type === 'BinaryExpression' &&
      ['===', '!==', '==', '!='].includes(node.operator) &&
      isCallTo(node.left, 'resolve') &&
      isCallTo(node.right, 'resolve')
    ) {
      findings.push(
        `${where(node)}: two resolved paths compared for equality. Call canonicalPathsEqual from durable-fs instead.`,
      )
    }
  })
}

if (findings.length > 0) {
  console.error('A path comparison must canonicalize both sides.\n')
  for (const finding of findings) console.error(`  ${finding}`)
  console.error(
    `\n${findings.length} finding(s). src/durable-fs.ts owns path comparison; see the header of scripts/check-path-containment.mjs.`,
  )
  process.exit(1)
}

console.log(
  `Path comparison is owned by src/durable-fs.ts: ${files.length} source file(s) carry no inline path comparison.`,
)
