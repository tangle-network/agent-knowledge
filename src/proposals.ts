import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { contentHash } from '@tangle-network/agent-eval'
import type { Sha256Digest } from '@tangle-network/agent-interface'
import { isMissingFile, readRegularFileWithinRoot } from './durable-fs'
import { commitKnowledgeFileMutations, type KnowledgeFileMutation } from './file-transaction'
import { knowledgePageDigest } from './knowledge-visibility'
import { KNOWLEDGE_PROPOSAL_PURPOSE_PREFIX, withKnowledgeMutation } from './mutation-lock'
import { type KnowledgePagesOptions, normalizePagesDirectory } from './pages-directory'
import { type OriginatedPage, originatedPages } from './run-scoped'
import { isKnowledgePagePath, knowledgePageFromMarkdown, readKnowledgePageViews } from './store'
import { assertKnowledgeWriteIntake, type KnowledgeWriteIntakeOptions } from './write-intake'
import { parseKnowledgeProposal } from './write-protocol'

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
  /**
   * Expected page identities by proposal path; null requires a new page. A
   * `---DELETE: <path>---` block requires the current page's digest.
   */
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
 * Apply the FILE and DELETE blocks of a proposal under the pages directory, as
 * one transaction. A deletion is journaled with `afterHash: null`.
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
  const parsed = parseKnowledgeProposal(proposalText, [`${pagesDirectory}/`])
  const deleted = new Set(parsed.deletes)
  if (parsed.blocks.some((block) => deleted.has(block.path))) {
    throw new Error('A knowledge proposal cannot write and delete the same page.')
  }
  // A FILE-only proposal keeps its prior identity, so an interrupted write still resumes.
  const blocks =
    parsed.deletes.length === 0 ? parsed.blocks : { blocks: parsed.blocks, deletes: parsed.deletes }
  const identity =
    options.actorId === undefined &&
    options.runId === undefined &&
    options.expectedPageDigests === undefined
      ? blocks
      : {
          blocks,
          actorId: options.actorId ?? null,
          runId: options.runId ?? null,
          expectedPageDigests: options.expectedPageDigests ?? null,
        }
  const purpose = KNOWLEDGE_PROPOSAL_PURPOSE_PREFIX + contentHash(identity)
  const intake = options.intake
  return withKnowledgeMutation(
    root,
    async (lock) => {
      if (parsed.blocks.length > 0 || parsed.deletes.length > 0) {
        const mutations: Array<KnowledgeFileMutation & { content: string | null }> = [
          ...parsed.blocks.map((block) => ({
            path: block.path,
            content: block.content.endsWith('\n') ? block.content : `${block.content}\n`,
          })),
          ...parsed.deletes.map((path) => ({ path, content: null })),
        ]
        if (options.expectedPageDigests !== undefined || parsed.deletes.length > 0) {
          const expectedPageDigests = options.expectedPageDigests ?? {}
          const paths = new Set(mutations.map((mutation) => mutation.path))
          for (const path of Object.keys(expectedPageDigests)) {
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
            const expected = Object.hasOwn(expectedPageDigests, mutation.path)
              ? expectedPageDigests[mutation.path]
              : null
            if (expected !== null && !/^sha256:[a-f0-9]{64}$/.test(expected ?? '')) {
              throw new Error(`Invalid expected page digest: ${mutation.path}`)
            }
            if (mutation.content === null && (expected ?? null) === null) {
              throw new Error(
                `Deleting ${mutation.path} requires its pageDigest from knowledge_read in expectedPageDigests.`,
              )
            }
            // A lost acknowledgement can retry the exact completed write safely.
            if (
              current !== expected &&
              !(
                !(Object.hasOwn(expectedPageDigests, mutation.path) && expected === null) &&
                before !== undefined &&
                mutation.content !== null &&
                Buffer.from(before.bytes).equals(Buffer.from(mutation.content))
              )
            ) {
              throw new Error(
                `knowledge page changed: ${mutation.path}; current digest: ${current ?? 'absent'}. Read the current page before editing or deleting it.`,
              )
            }
            mutation.expectedBeforeHash =
              before === undefined ? null : createHash('sha256').update(before.bytes).digest('hex')
          }
        }
        if (intake) {
          const { inheritedPages = [], ...settings } = intake
          const { views } = await readKnowledgePageViews([root], { pagesDirectory })
          assertKnowledgeWriteIntake(
            mutations.flatMap((mutation) =>
              mutation.content !== null && isKnowledgePagePath(mutation.path)
                ? [knowledgePageFromMarkdown(mutation.path, mutation.content, pagesDirectory)]
                : [],
            ),
            {
              ...settings,
              visiblePages: [
                ...originatedPages(views[0]!.pages.filter((page) => !deleted.has(page.path))),
                ...inheritedPages,
              ],
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
