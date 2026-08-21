import { readFile } from 'node:fs/promises'
import { contentHash } from '@tangle-network/agent-eval'
import { commitKnowledgeFileMutations } from './file-transaction'
import { withKnowledgeMutation } from './mutation-lock'
import { type KnowledgePagesOptions, normalizePagesDirectory } from './pages-directory'
import { type OriginatedPage, originatedPages } from './run-scoped'
import { isKnowledgePagePath, knowledgePageFromMarkdown, loadKnowledgePages } from './store'
import { assertKnowledgeWriteIntake, type KnowledgeWriteIntakeOptions } from './write-intake'
import { parseKnowledgeWriteBlocks } from './write-protocol'

export interface ApplyWriteBlocksResult {
  written: string[]
  warnings: string[]
}

/** Intake settings for a write, minus the pages the target root supplies itself. */
export type KnowledgeWriteIntakeRequest = Omit<KnowledgeWriteIntakeOptions, 'visiblePages'> & {
  /**
   * Pages visible to the write beyond the target root, such as the inherited
   * and shared entries of a run-scoped chain. The target root's own pages are
   * read under the same lock and are always part of the corpus.
   */
  readonly inheritedPages?: readonly OriginatedPage[]
}

export interface ApplyKnowledgeWriteBlocksOptions extends KnowledgePagesOptions {
  /**
   * Refuse the write when a block duplicates visible knowledge without relating
   * itself to it, or cites a page that exists nowhere. The whole proposal is
   * refused, so a refused batch leaves no partial write behind.
   */
  intake?: KnowledgeWriteIntakeRequest
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
  options: ApplyKnowledgeWriteBlocksOptions = {},
): Promise<ApplyWriteBlocksResult> {
  const pagesDirectory = normalizePagesDirectory(options.pagesDirectory)
  const parsed = parseKnowledgeWriteBlocks(proposalText, [`${pagesDirectory}/`])
  const purpose = `knowledge-proposal:${contentHash(parsed.blocks)}`
  const intake = options.intake
  return withKnowledgeMutation(
    root,
    async (lock) => {
      if (parsed.blocks.length > 0) {
        const mutations = parsed.blocks.map((block) => ({
          path: block.path,
          content: block.content.endsWith('\n') ? block.content : `${block.content}\n`,
        }))
        if (intake) {
          const { inheritedPages = [], ...settings } = intake
          const here = await loadKnowledgePages(root, { pagesDirectory })
          assertKnowledgeWriteIntake(
            mutations
              .filter((mutation) => isKnowledgePagePath(mutation.path))
              .map((mutation) =>
                knowledgePageFromMarkdown(mutation.path, mutation.content, pagesDirectory),
              ),
            {
              ...settings,
              visiblePages: [...originatedPages(here), ...inheritedPages],
            },
          )
        }
        await commitKnowledgeFileMutations({
          root,
          transactionRoot: lock.transactionRoot,
          purpose,
          mutations,
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
  options: ApplyKnowledgeWriteBlocksOptions = {},
): Promise<ApplyWriteBlocksResult> {
  return applyKnowledgeWriteBlocks(root, await readFile(proposalPath, 'utf8'), options)
}
