import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { register } from 'node:module'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'

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

const { readRegularFileWithinRoot } = await import('../../src/durable-fs.ts')
const { withKnowledgeMutation, withKnowledgeRead } = await import('../../src/mutation-lock.ts')
const root = process.argv[2]
const cache = join(root, '.agent-knowledge')
await assert.rejects(
  readRegularFileWithinRoot(cache, 'mutation.lock.owner.json'),
  /not a regular file/,
)
assert.equal(await withKnowledgeMutation(root, () => 'written'), 'written')
const release = await lockfile.lock(root, {
  realpath: false,
  lockfilePath: join(cache, 'mutation.lock.durable'),
})
try {
  await writeFile(join(cache, 'mutation-epoch.json'), JSON.stringify({ epoch: 3 }))
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
} finally {
  await release()
}
process.stdout.write('owner checks passed\n')
