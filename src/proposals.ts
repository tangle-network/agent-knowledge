import { readFile } from 'node:fs/promises'
import { contentHash } from '@tangle-network/agent-eval'
import { commitKnowledgeFileMutations } from './file-transaction'
import { withKnowledgeMutation } from './mutation-lock'
import { type KnowledgePagesOptions, normalizePagesDirectory } from './pages-directory'
import { parseKnowledgeWriteBlocks } from './write-protocol'

export interface ApplyWriteBlocksResult {
  written: string[]
  warnings: string[]
}

/**
 * Apply the FILE blocks of a proposal under the pages directory.
 *
 * A block whose path lies outside `<pagesDirectory>/` is refused by the parser
 * and again by the file transaction, so one option value bounds the whole
 * write.
 */
export async function applyKnowledgeWriteBlocks(
  root: string,
  proposalText: string,
  options: KnowledgePagesOptions = {},
): Promise<ApplyWriteBlocksResult> {
  const pagesDirectory = normalizePagesDirectory(options.pagesDirectory)
  const parsed = parseKnowledgeWriteBlocks(proposalText, [`${pagesDirectory}/`])
  const purpose = `knowledge-proposal:${contentHash(parsed.blocks)}`
  return withKnowledgeMutation(
    root,
    async (lock) => {
      if (parsed.blocks.length > 0) {
        await commitKnowledgeFileMutations({
          root,
          transactionRoot: lock.transactionRoot,
          purpose,
          mutations: parsed.blocks.map((block) => ({
            path: block.path,
            content: block.content.endsWith('\n') ? block.content : `${block.content}\n`,
          })),
          pagesDirectory,
          assertOwned: lock.assertOwned,
        })
      }
      return { written: parsed.blocks.map((block) => block.path), warnings: parsed.warnings }
    },
    { resumeTransaction: { purpose } },
  )
}

export async function applyKnowledgeWriteBlocksFile(
  root: string,
  proposalPath: string,
  options: KnowledgePagesOptions = {},
): Promise<ApplyWriteBlocksResult> {
  return applyKnowledgeWriteBlocks(root, await readFile(proposalPath, 'utf8'), options)
}
