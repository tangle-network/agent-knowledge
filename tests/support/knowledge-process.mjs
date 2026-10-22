// A second OS process on one Knowledge store, loaded from this checkout's source, for lock tests.
//
//   node --experimental-transform-types knowledge-process.mjs <src dir> <config json>
//
// For each page in `config.pages` it holds the store lock for `config.holdMs` around a real
// knowledge_record of that page, the way one write held it on a saturated disk, and prints
// `holding <page>` once the lock is held and `done` at the end.
//
// With `config.transaction` ({ purpose, recoveryOwner?, researchState?, mutations }) it instead
// prepares that file transaction under the store lock, applies its first entry, prints
// `holding transaction` before committing the second, and waits there to be killed.
//
// With `config.promotion` ({ candidate, activation, attemptedAt, identity }) it instead promotes
// that measured knowledge-improvement candidate under that activation, with `root` the knowledge
// base, and prints `holding promotion` from the activation's createResult, after the files are
// committed and while the run lease, the store lock and the transaction are all held, and waits
// there to be killed.
//
// Every process warning is forwarded to stdout as one line, `warning <code> <message>`, so a
// parent can count recovery warnings that `--no-warnings` keeps off stderr.
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

process.on('warning', (warning) => {
  process.stdout.write(`warning ${warning.code} ${warning.message.replace(/\n/g, ' ')}\n`)
})

const [source, configText] = process.argv.slice(2)
const config = JSON.parse(configText)
const knowledge = await import(pathToFileURL(join(source, 'index.ts')).href)
const lock = await import(pathToFileURL(join(source, 'mutation-lock.ts')).href)
// Absent before the release that added it, so this process also replays against that release.
const labelled = lock.withKnowledgeMutationLabel ?? ((_label, body) => body())

if (config.promotion) {
  const { candidate, ...activation } = config.promotion
  await knowledge.promoteKnowledgeCandidate({
    root: config.root,
    candidate,
    activation: {
      ...activation,
      async createResult() {
        process.stdout.write('holding promotion\n')
        await new Promise(() => setInterval(() => undefined, 60_000))
      },
    },
  })
}

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

if (config.transaction) {
  const files = await import(pathToFileURL(join(source, 'file-transaction.ts')).href)
  const { mutations, ...input } = config.transaction
  await labelled(`killed write of ${input.purpose} by ${config.actorId}`, () =>
    knowledge.withKnowledgeMutation(storeRoot, async (held) => {
      const transaction = await files.prepareKnowledgeFileTransaction({
        root: storeRoot,
        transactionRoot: held.transactionRoot,
        ...input,
        mutations,
      })
      await files.applyKnowledgeFileTransaction({
        root: storeRoot,
        transactionRoot: held.transactionRoot,
        transaction,
        async beforeCommit(entry) {
          if (entry.index === 0) return
          process.stdout.write('holding transaction\n')
          // A pending promise alone lets the process exit, and exit would release the lock.
          await new Promise(() => setInterval(() => undefined, 60_000))
        },
      })
    }),
  )
}

for (const path of config.pages ?? []) {
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
