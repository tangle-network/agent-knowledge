import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { contentHash } from '@tangle-network/agent-eval'
import type { Sha256Digest } from '@tangle-network/agent-interface'
import { isMissingFile, readRegularFileWithinRoot } from './durable-fs'
import { commitKnowledgeFileMutations, type KnowledgeFileMutation } from './file-transaction'
import { knowledgePageDigest } from './knowledge-visibility'
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
  /** Host-provided identity, never inferred from authored page content. */
  readonly actorId?: string
  readonly runId?: string
  /** Expected page identities by proposal path; null requires a new page. */
  readonly expectedPageDigests?: Readonly<Record<string, Sha256Digest | null>>
  /** Preserve terminal transactions under .agent-knowledge/history; no automatic deletion. */
  readonly retainHistory?: boolean
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
  const identity =
    options.actorId === undefined &&
    options.runId === undefined &&
    options.expectedPageDigests === undefined
      ? parsed.blocks
      : {
          blocks: parsed.blocks,
          actorId: options.actorId ?? null,
          runId: options.runId ?? null,
          expectedPageDigests: options.expectedPageDigests ?? null,
        }
  const purpose = 'knowledge-proposal:' + contentHash(identity)
  const intake = options.intake
  return withKnowledgeMutation(
    root,
    async (lock) => {
      if (parsed.blocks.length > 0) {
        const mutations: Array<KnowledgeFileMutation & { content: string }> = parsed.blocks.map(
          (block) => ({
            path: block.path,
            content: block.content.endsWith('\n') ? block.content : `${block.content}\n`,
          }),
        )
        if (options.expectedPageDigests !== undefined) {
          const paths = new Set(mutations.map((mutation) => mutation.path))
          for (const path of Object.keys(options.expectedPageDigests)) {
            if (!paths.has(path)) throw new Error(`Expected digest has no proposed page: ${path}`)
          }
          for (const mutation of mutations) {
            let before: Awaited<ReturnType<typeof readRegularFileWithinRoot>> | undefined
            try {
              before = await readRegularFileWithinRoot(root, mutation.path)
            } catch (error) {
              if (!isMissingFile(error)) throw error
            }
            const current =
              before === undefined
                ? null
                : knowledgePageDigest(
                    knowledgePageFromMarkdown(
                      mutation.path,
                      Buffer.from(before.bytes).toString('utf8'),
                      pagesDirectory,
                    ),
                  )
            const expected = Object.hasOwn(options.expectedPageDigests, mutation.path)
              ? options.expectedPageDigests[mutation.path]
              : null
            if (expected !== null && !/^sha256:[a-f0-9]{64}$/.test(expected ?? '')) {
              throw new Error(`Invalid expected page digest: ${mutation.path}`)
            }
            // A lost acknowledgement can retry the exact completed write safely.
            if (
              current !== expected &&
              !(
                !(Object.hasOwn(options.expectedPageDigests, mutation.path) && expected === null) &&
                before !== undefined &&
                Buffer.from(before.bytes).equals(Buffer.from(mutation.content ?? ''))
              )
            ) {
              throw new Error(
                `knowledge page changed: ${mutation.path}; current digest: ${current ?? 'absent'}. Read the current page before editing it.`,
              )
            }
            mutation.expectedBeforeHash =
              before === undefined ? null : createHash('sha256').update(before.bytes).digest('hex')
          }
        }
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
          actorId: options.actorId,
          runId: options.runId,
          mutations,
          pagesDirectory,
          retainHistory: options.retainHistory,
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
