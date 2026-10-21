import assert from 'node:assert/strict'
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
const { readRegularFileWithinRootNonBlocking } = await import('../../src/durable-fs.ts')
const { withKnowledgeMutation, withKnowledgeRead } = await import('../../src/mutation-lock.ts')
const [root, mode] = process.argv.slice(2)
const cache = join(root, '.agent-knowledge')
const owner = readRegularFileWithinRootNonBlocking(cache, 'mutation.lock.owner.json')
if (mode === 'fifo' || mode === 'symlink') {
  await assert.rejects(owner, /not a regular file/)
} else if (mode === 'timestamp') {
  assert.ok(Math.abs(JSON.parse((await owner).bytes.toString('utf8')).since) > 8.64e15)
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
