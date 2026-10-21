import assert from 'node:assert/strict'
import { lstat, readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { join } from 'node:path'

register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (error) {
    if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) {
      return next(specifier + '.ts', context)
    }
    throw error
  }
}`)}`,
)

// A waiter in a second process, contending for a lock its parent holds over a hostile owner path.
const { withKnowledgeMutation, withKnowledgeRead } = await import('../../src/mutation-lock.ts')
const [root, mode] = process.argv.slice(2)
const ownerPath = join(root, '.agent-knowledge', 'mutation.lock.owner.json')
// lstat never opens the path, so checking the plant cannot block on the FIFO itself.
const planted = await lstat(ownerPath)
if (mode === 'fifo') {
  assert.ok(planted.isFIFO())
} else if (mode === 'symlink') {
  assert.ok(planted.isSymbolicLink())
} else if (mode === 'timestamp') {
  assert.ok(Math.abs(JSON.parse(await readFile(ownerPath, 'utf8')).since) > 8.64e15)
} else {
  throw new Error(`unknown owner mode: ${mode}`)
}
await assert.rejects(
  withKnowledgeMutation(root, () => undefined, { retries: 0 }),
  {
    code: 'ELOCKED',
    message: /recorded no owner/,
  },
)
await assert.rejects(
  withKnowledgeRead(root, () => undefined, { retries: 0 }),
  /recorded no owner/,
)
process.stdout.write('owner checks passed\n')
