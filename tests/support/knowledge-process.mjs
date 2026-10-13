// A second OS process on one Knowledge store, loaded from this checkout's source, for lock tests.
//
//   node --experimental-transform-types knowledge-process.mjs <src dir> <config json>
//
// For each page in `config.pages` it holds the store lock for `config.holdMs` around a real
// knowledge_record of that page, the way one write held it on a saturated disk, and prints
// `holding <page>` once the lock is held and `done` at the end.
import { register } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Source imports name siblings without an extension, as the bundler resolves them.
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

const [source, configText] = process.argv.slice(2)
const config = JSON.parse(configText)
const knowledge = await import(pathToFileURL(join(source, 'index.ts')).href)
const lock = await import(pathToFileURL(join(source, 'mutation-lock.ts')).href)
// Absent before the release that added it, so this process also replays against that release.
const labelled = lock.withKnowledgeMutationLabel ?? ((_label, body) => body())

const stores = knowledge.createRunScopedStores({ root: config.root })
const record = knowledge
  .createKnowledgeTools({
    stores,
    runId: config.runId,
    retrieverVersion: 'test',
    actorId: config.actorId,
  })
  .find((tool) => tool.name === 'knowledge_record')
const storeRoot = stores.storePath(config.runId)

for (const path of config.pages) {
  await labelled(`slow write of ${path} by ${config.actorId}`, () =>
    knowledge.withKnowledgeMutation(storeRoot, async () => {
      process.stdout.write(`holding ${path}\n`)
      await record.handler({
        proposal: `---FILE: knowledge/${path}---\n# ${path}\n\nWritten by ${config.actorId}.\n---END FILE---\n`,
      })
      await new Promise((resolve) => setTimeout(resolve, config.holdMs))
    }),
  )
}
process.stdout.write('done\n')
