import { readFile } from 'node:fs/promises'
import { contentHash } from '@tangle-network/agent-eval'
import { commitKnowledgeFileMutations } from './file-transaction'
import { withKnowledgeMutation } from './mutation-lock'
import { parseKnowledgeWriteBlocks } from './write-protocol'

export interface ApplyWriteBlocksResult {
  written: string[]
  warnings: string[]
}

export async function applyKnowledgeWriteBlocks(
  root: string,
  proposalText: string,
): Promise<ApplyWriteBlocksResult> {
  const parsed = parseKnowledgeWriteBlocks(proposalText)
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
): Promise<ApplyWriteBlocksResult> {
  return applyKnowledgeWriteBlocks(root, await readFile(proposalPath, 'utf8'))
}
