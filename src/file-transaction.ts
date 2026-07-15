import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { contentHash } from '@tangle-network/agent-eval'
import { z } from 'zod'
import {
  isKernelAnchoredPath,
  isMissingFile,
  readRegularFileNoFollow,
  removeDurable,
  renameDurable,
  syncDirectory,
  withSafeDescendant,
  withSafeDirectory,
  writeFileDurable,
  writeJsonDurable,
} from './durable-fs'

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const fileModeSchema = z.number().int().min(0).max(0o777)
const DEFAULT_FILE_MODE = 0o644
const transactionEntrySchema = z
  .object({
    index: z.number().int().nonnegative(),
    path: z.string().min(1),
    beforeHash: digestSchema.nullable(),
    afterHash: digestSchema.nullable(),
    beforeMode: fileModeSchema.optional(),
    afterMode: fileModeSchema.optional(),
  })
  .strict()
const transactionSchema = z
  .object({
    kind: z.literal('knowledge-file-transaction'),
    transactionId: z.string().uuid(),
    purpose: z.string().min(1),
    createdAt: z.string().min(1),
    entries: z.array(transactionEntrySchema).min(1),
  })
  .strict()
const transactionDirectionSchema = z
  .object({
    transactionId: z.string().uuid(),
    direction: z.literal('rollback'),
  })
  .strict()

export type KnowledgeFileTransaction = z.infer<typeof transactionSchema>

export interface KnowledgeFileTransactionState {
  transaction: KnowledgeFileTransaction
  direction: 'apply' | 'rollback'
}

export interface KnowledgeFileTransactionPlanEntry {
  path: string
  beforeHash: string | null
  afterHash: string | null
  beforeMode?: number
  afterMode?: number
}

export function knowledgeFileTransactionPlanHash(
  entries: readonly KnowledgeFileTransactionPlanEntry[],
): string {
  const normalized = entries
    .map((entry) => normalizePlanEntry(entry))
    .sort((left, right) => left.path.localeCompare(right.path))
  if (new Set(normalized.map((entry) => entry.path)).size !== normalized.length) {
    throw new Error('knowledge transaction plan repeats a path')
  }
  return contentHash(normalized)
}

export interface KnowledgeFileMutation {
  path: string
  content: string | Buffer | null
  mode?: number
}

export async function prepareKnowledgeFileTransaction(input: {
  root: string
  transactionRoot: string
  purpose: string
  mutations: readonly KnowledgeFileMutation[]
  includeUnchanged?: boolean
  now?: () => Date
}): Promise<KnowledgeFileTransaction | null> {
  if (input.mutations.length === 0) throw new Error('knowledge file transaction has no mutations')
  return withTransactionRoot(input.root, input.transactionRoot, true, async (transactionRoot) => {
    const activeTransactions = await activeTransactionDirectoryNames(transactionRoot)
    if (activeTransactions.length > 0) {
      throw new Error(
        `knowledge file transaction is already active: ${activeTransactions.join(', ')}`,
      )
    }

    const paths = new Set<string>()
    const prepared = await Promise.all(
      input.mutations.map(async (mutation, index) => {
        const path = assertKnowledgeMutationPath(mutation.path)
        if (paths.has(path)) throw new Error(`knowledge file transaction repeats path: ${path}`)
        if (mutation.content === null && mutation.mode !== undefined) {
          throw new Error(`deleted knowledge file cannot declare a mode: ${path}`)
        }
        paths.add(path)
        const before = await withSafeDescendant(input.root, path, readRegularFile)
        const after =
          mutation.content === null
            ? null
            : Buffer.isBuffer(mutation.content)
              ? mutation.content
              : Buffer.from(mutation.content, 'utf8')
        const afterMode = after
          ? fileModeSchema.parse(mutation.mode ?? before?.mode ?? DEFAULT_FILE_MODE)
          : undefined
        if (
          !input.includeUnchanged &&
          sameBytes(before?.bytes ?? null, after) &&
          before?.mode === afterMode
        ) {
          return null
        }
        return {
          entry: {
            index,
            path,
            beforeHash: before ? hashBytes(before.bytes) : null,
            afterHash: after ? hashBytes(after) : null,
            ...(before ? { beforeMode: before.mode } : {}),
            ...(afterMode === undefined ? {} : { afterMode }),
          },
          before: before?.bytes ?? null,
          after,
        }
      }),
    )
    const changed = prepared.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    if (changed.length === 0) return null

    const preparationDir = await mkdtemp(join(transactionRoot, 'prepare-'))
    let activated = false
    try {
      for (const item of changed) {
        if (item.before) {
          await writeFileDurable(
            snapshotPath(preparationDir, 'before', item.entry.index),
            item.before,
          )
        }
        if (item.after) {
          await writeFileDurable(
            snapshotPath(preparationDir, 'after', item.entry.index),
            item.after,
          )
        }
      }
      const transaction = transactionSchema.parse({
        kind: 'knowledge-file-transaction',
        transactionId: randomUUID(),
        purpose: input.purpose,
        createdAt: (input.now ?? (() => new Date()))().toISOString(),
        entries: changed.map((item) => item.entry),
      })
      await writeJsonDurable(join(preparationDir, 'transaction.json'), transaction)
      const activeDir = join(
        transactionRoot,
        activeTransactionDirectoryName(transaction.transactionId),
      )
      await renameDurable(preparationDir, activeDir)
      activated = true
      const competingTransactions = await activeTransactionDirectoryNames(transactionRoot)
      if (competingTransactions.length > 1) {
        await rm(activeDir, { recursive: true, force: true })
        await syncDirectory(transactionRoot)
        throw new Error('multiple knowledge file transactions became active concurrently')
      }
      return transaction
    } finally {
      if (!activated) await rm(preparationDir, { recursive: true, force: true })
    }
  })
}

export async function commitKnowledgeFileMutations(input: {
  root: string
  transactionRoot: string
  purpose: string
  mutations: readonly KnowledgeFileMutation[]
  assertOwned?: () => void
  now?: () => Date
}): Promise<boolean> {
  if (
    await loadKnowledgeFileTransaction({
      root: input.root,
      transactionRoot: input.transactionRoot,
    })
  ) {
    throw new Error('recover the pending knowledge transaction before planning another write')
  }
  const transaction = await prepareKnowledgeFileTransaction({
    root: input.root,
    transactionRoot: input.transactionRoot,
    purpose: input.purpose,
    mutations: input.mutations,
    now: input.now,
  })
  if (!transaction) return false
  input.assertOwned?.()
  await applyKnowledgeFileTransaction({
    root: input.root,
    transactionRoot: input.transactionRoot,
    transaction,
    beforeCommit: input.assertOwned,
  })
  await finishKnowledgeFileTransaction({
    root: input.root,
    transactionRoot: input.transactionRoot,
    transaction,
    assertOwned: input.assertOwned,
  })
  return true
}

export async function recoverKnowledgeFileTransaction(input: {
  root: string
  transactionRoot: string
  expectedPurpose: string
  direction?: 'apply' | 'rollback'
  validate?: (transaction: KnowledgeFileTransaction) => void
  assertOwned?: () => void
}): Promise<boolean> {
  const pending = await inspectKnowledgeFileTransaction({
    root: input.root,
    transactionRoot: input.transactionRoot,
  })
  if (!pending) return false
  const { transaction, direction } = pending
  if (transaction.purpose !== input.expectedPurpose) {
    throw new Error(`knowledge transaction '${transaction.purpose}' requires its owner to resume`)
  }
  input.validate?.(transaction)
  input.assertOwned?.()
  if (input.direction === 'apply' && direction === 'rollback') {
    throw new Error(`knowledge transaction '${transaction.transactionId}' is already rolling back`)
  }
  const requestedDirection = input.direction ?? direction
  if (requestedDirection === 'rollback') {
    await rollbackKnowledgeFileTransaction({
      root: input.root,
      transactionRoot: input.transactionRoot,
      transaction,
      beforeCommit: input.assertOwned,
    })
  } else {
    await applyKnowledgeFileTransaction({
      root: input.root,
      transactionRoot: input.transactionRoot,
      transaction,
      beforeCommit: input.assertOwned,
    })
  }
  await finishKnowledgeFileTransaction({
    root: input.root,
    transactionRoot: input.transactionRoot,
    transaction,
    assertOwned: input.assertOwned,
  })
  return true
}

export async function loadKnowledgeFileTransaction(input: {
  root: string
  transactionRoot: string
}): Promise<KnowledgeFileTransaction | null> {
  return (await inspectKnowledgeFileTransaction(input))?.transaction ?? null
}

export async function inspectKnowledgeFileTransaction(input: {
  root: string
  transactionRoot: string
}): Promise<KnowledgeFileTransactionState | null> {
  return loadKnowledgeFileTransactionState(input)
}

export async function applyKnowledgeFileTransaction(input: {
  root: string
  transactionRoot: string
  transaction: KnowledgeFileTransaction
  beforeCommit?: (entry: KnowledgeFileTransaction['entries'][number]) => Promise<void> | void
}): Promise<void> {
  const transaction = transactionSchema.parse(input.transaction)
  assertTransactionEntries(transaction)
  await withTransactionDirectory(
    input.root,
    input.transactionRoot,
    transaction,
    async (transactionDir) => {
      await assertActiveTransaction(transactionDir, transaction)
      if ((await readTransactionDirection(transactionDir, transaction)) === 'rollback') {
        throw new Error(`knowledge transaction '${transaction.transactionId}' is rolling back`)
      }
      for (const entry of transaction.entries) {
        await withSafeDescendant(input.root, entry.path, async (target) => {
          const current = await readRegularFile(target)
          if (fileMatches(current, entry.afterHash, entry.afterMode)) return
          if (!fileMatches(current, entry.beforeHash, entry.beforeMode)) {
            throw new Error(`knowledge file changed outside transaction: ${entry.path}`)
          }
          await input.beforeCommit?.(entry)
          if (entry.afterHash === null) {
            await removeDurable(target)
            return
          }
          const after = (
            await readRegularFileNoFollow(snapshotPath(transactionDir, 'after', entry.index))
          ).bytes
          if (hashBytes(after) !== entry.afterHash) {
            throw new Error(`knowledge transaction snapshot changed: ${entry.path}`)
          }
          await writeFileDurable(target, after, { mode: entry.afterMode! })
        })
      }
      await assertKnowledgeFileTransactionApplied(input.root, transaction)
    },
  )
}

export async function assertKnowledgeFileTransactionApplied(
  root: string,
  transaction: KnowledgeFileTransaction,
): Promise<void> {
  for (const entry of transaction.entries) {
    await withSafeDescendant(root, entry.path, async (target) => {
      const current = await readRegularFile(target)
      if (!fileMatches(current, entry.afterHash, entry.afterMode)) {
        throw new Error(`knowledge file transaction did not commit: ${entry.path}`)
      }
    })
  }
}

export async function finishKnowledgeFileTransaction(input: {
  root: string
  transactionRoot: string
  transaction: KnowledgeFileTransaction
  assertOwned?: () => void
}): Promise<void> {
  const transaction = transactionSchema.parse(input.transaction)
  assertTransactionEntries(transaction)
  await withTransactionRoot(input.root, input.transactionRoot, false, async (transactionRoot) => {
    const activeName = activeTransactionDirectoryName(transaction.transactionId)
    await withTransactionDirectory(
      input.root,
      input.transactionRoot,
      transaction,
      async (transactionDir) => {
        await assertActiveTransaction(transactionDir, transaction)
        input.assertOwned?.()
        const direction = await readTransactionDirection(transactionDir, transaction)
        await assertKnowledgeFileTransactionTerminal(input.root, transaction, direction)
        await withSafeDirectory(transactionRoot, activeName, false, async (currentDir) => {
          await assertActiveTransaction(currentDir, transaction)
          const currentDirection = await readTransactionDirection(currentDir, transaction)
          if (currentDirection !== direction) {
            throw new Error(
              `knowledge transaction '${transaction.transactionId}' changed direction`,
            )
          }
          await assertKnowledgeFileTransactionTerminal(input.root, transaction, currentDirection)
        })
      },
    )
    await rm(join(transactionRoot, activeName), { recursive: true, force: false })
    await syncDirectory(transactionRoot)
  })
}

export async function rollbackKnowledgeFileTransaction(input: {
  root: string
  transactionRoot: string
  transaction: KnowledgeFileTransaction
  beforeCommit?: (entry: KnowledgeFileTransaction['entries'][number]) => Promise<void> | void
}): Promise<void> {
  await withTransactionDirectory(
    input.root,
    input.transactionRoot,
    input.transaction,
    async (transactionDir) => {
      const transaction = transactionSchema.parse(input.transaction)
      assertTransactionEntries(transaction)
      await assertActiveTransaction(transactionDir, transaction)
      await input.beforeCommit?.(transaction.entries.at(-1)!)
      const direction = await readTransactionDirection(transactionDir, transaction)
      if (direction !== 'rollback') {
        await writeJsonDurable(join(transactionDir, 'direction.json'), {
          transactionId: transaction.transactionId,
          direction: 'rollback',
        })
      }
      for (const entry of [...transaction.entries].reverse()) {
        await withSafeDescendant(input.root, entry.path, async (target) => {
          const current = await readRegularFile(target)
          if (fileMatches(current, entry.beforeHash, entry.beforeMode)) return
          if (!fileMatches(current, entry.afterHash, entry.afterMode)) {
            throw new Error(`knowledge file changed outside rollback: ${entry.path}`)
          }
          await input.beforeCommit?.(entry)
          if (entry.beforeHash === null) {
            await removeDurable(target)
            return
          }
          const before = (
            await readRegularFileNoFollow(snapshotPath(transactionDir, 'before', entry.index))
          ).bytes
          if (hashBytes(before) !== entry.beforeHash) {
            throw new Error(`knowledge rollback snapshot changed: ${entry.path}`)
          }
          await writeFileDurable(target, before, { mode: entry.beforeMode! })
        })
      }
      await input.beforeCommit?.(transaction.entries[0]!)
      for (const entry of transaction.entries) {
        await withSafeDescendant(input.root, entry.path, async (target) => {
          const current = await readRegularFile(target)
          if (!fileMatches(current, entry.beforeHash, entry.beforeMode)) {
            throw new Error(`knowledge file transaction did not roll back: ${entry.path}`)
          }
        })
      }
    },
  )
}

async function loadKnowledgeFileTransactionState(input: {
  root: string
  transactionRoot: string
}): Promise<KnowledgeFileTransactionState | null> {
  try {
    return await withTransactionRoot(input.root, input.transactionRoot, false, async (root) => {
      const activeTransactions = await activeTransactionDirectoryNames(root)
      if (activeTransactions.length === 0) return null
      if (activeTransactions.length > 1) {
        throw new Error('multiple knowledge file transactions are active')
      }
      return withSafeDirectory(root, activeTransactions[0]!, false, async (transactionDir) => {
        const transaction = await readActiveTransaction(transactionDir)
        return {
          transaction,
          direction: await readTransactionDirection(transactionDir, transaction),
        }
      })
    })
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  }
}

async function readActiveTransaction(transactionDir: string): Promise<KnowledgeFileTransaction> {
  const transaction = transactionSchema.parse(
    JSON.parse(
      (await readRegularFileNoFollow(join(transactionDir, 'transaction.json'))).bytes.toString(
        'utf8',
      ),
    ),
  )
  assertTransactionEntries(transaction)
  return transaction
}

async function assertActiveTransaction(
  transactionDir: string,
  expected: KnowledgeFileTransaction,
): Promise<void> {
  const active = await readActiveTransaction(transactionDir)
  if (
    active.transactionId !== expected.transactionId ||
    contentHash(active) !== contentHash(transactionSchema.parse(expected))
  ) {
    throw new Error(`active knowledge transaction does not match '${expected.transactionId}'`)
  }
}

async function readTransactionDirection(
  transactionDir: string,
  transaction: KnowledgeFileTransaction,
): Promise<'apply' | 'rollback'> {
  try {
    const direction = transactionDirectionSchema.parse(
      JSON.parse(
        (await readRegularFileNoFollow(join(transactionDir, 'direction.json'))).bytes.toString(
          'utf8',
        ),
      ),
    )
    if (direction.transactionId !== transaction.transactionId) {
      throw new Error('knowledge transaction direction belongs to another transaction')
    }
    return direction.direction
  } catch (error) {
    if (isMissingFile(error)) return 'apply'
    throw error
  }
}

function snapshotPath(root: string, side: 'before' | 'after', index: number): string {
  return join(root, side, `${index}.bin`)
}

async function withTransactionDirectory<T>(
  root: string,
  transactionRoot: string,
  transaction: KnowledgeFileTransaction,
  use: (transactionDir: string) => Promise<T> | T,
): Promise<T> {
  const parsed = transactionSchema.parse(transaction)
  try {
    return await withTransactionRoot(root, transactionRoot, false, (safeRoot) =>
      withSafeDirectory(safeRoot, activeTransactionDirectoryName(parsed.transactionId), false, use),
    )
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error(`active knowledge transaction does not match '${parsed.transactionId}'`, {
        cause: error,
      })
    }
    throw error
  }
}

async function activeTransactionDirectoryNames(transactionRoot: string): Promise<string[]> {
  const active: string[] = []
  for (const entry of await readdir(transactionRoot, { withFileTypes: true })) {
    if (entry.name === 'active') {
      throw new Error('knowledge transaction store contains an unsupported active journal')
    }
    if (!entry.name.startsWith('active-')) continue
    if (!entry.isDirectory()) {
      throw new Error(`knowledge transaction journal is not a directory: ${entry.name}`)
    }
    activeTransactionDirectoryName(entry.name.slice('active-'.length))
    active.push(entry.name)
  }
  return active.sort()
}

function activeTransactionDirectoryName(transactionId: string): string {
  return `active-${z.string().uuid().parse(transactionId)}`
}

async function assertKnowledgeFileTransactionTerminal(
  root: string,
  transaction: KnowledgeFileTransaction,
  direction: 'apply' | 'rollback',
): Promise<void> {
  if (direction === 'apply') {
    await assertKnowledgeFileTransactionApplied(root, transaction)
    return
  }
  for (const entry of transaction.entries) {
    await withSafeDescendant(root, entry.path, async (target) => {
      const current = await readRegularFile(target)
      if (!fileMatches(current, entry.beforeHash, entry.beforeMode)) {
        throw new Error(`knowledge file transaction did not roll back: ${entry.path}`)
      }
    })
  }
}

async function withTransactionRoot<T>(
  root: string,
  transactionRoot: string,
  create: boolean,
  use: (transactionRoot: string) => Promise<T> | T,
): Promise<T> {
  if (isKernelAnchoredPath(transactionRoot)) {
    const match = transactionRoot.match(/^(\/proc\/self\/fd\/\d+)(?:\/(.*))?$/)
    if (!match?.[1]) throw new Error('knowledge transaction directory has an invalid anchor')
    return withSafeDirectory(match[1], match[2] ?? '', create, use)
  }
  const resolvedRoot = resolve(root)
  const resolvedTransactionRoot = resolve(transactionRoot)
  if (!resolvedTransactionRoot.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error('knowledge transaction directory escaped its root')
  }
  return withSafeDirectory(
    root,
    relative(resolvedRoot, resolvedTransactionRoot).replace(/\\/g, '/'),
    create,
    use,
  )
}

function assertTransactionEntries(transaction: KnowledgeFileTransaction): void {
  const indexes = new Set<number>()
  const paths = new Set<string>()
  for (const entry of transaction.entries) {
    const normalized = assertKnowledgeMutationPath(entry.path)
    if (entry.path !== normalized || indexes.has(entry.index) || paths.has(entry.path)) {
      throw new Error('knowledge file transaction has duplicate or unsafe entries')
    }
    assertHashModePair(entry.path, 'before', entry.beforeHash, entry.beforeMode)
    assertHashModePair(entry.path, 'after', entry.afterHash, entry.afterMode)
    indexes.add(entry.index)
    paths.add(entry.path)
  }
}

function normalizePlanEntry(entry: KnowledgeFileTransactionPlanEntry) {
  const path = assertKnowledgeMutationPath(entry.path)
  assertHashModePair(path, 'before', entry.beforeHash, entry.beforeMode)
  assertHashModePair(path, 'after', entry.afterHash, entry.afterMode)
  return {
    path,
    beforeHash: entry.beforeHash,
    afterHash: entry.afterHash,
    ...(entry.beforeMode === undefined
      ? {}
      : { beforeMode: fileModeSchema.parse(entry.beforeMode) }),
    ...(entry.afterMode === undefined ? {} : { afterMode: fileModeSchema.parse(entry.afterMode) }),
  }
}

function assertHashModePair(
  path: string,
  side: 'before' | 'after',
  hash: string | null,
  mode: number | undefined,
): void {
  if ((hash === null) !== (mode === undefined)) {
    throw new Error(`knowledge transaction ${side} hash and mode disagree: ${path}`)
  }
  if (mode !== undefined) fileModeSchema.parse(mode)
}

export function assertKnowledgeMutationPath(path: string): string {
  const normalized = normalizeTransactionPath(path)
  if (
    normalized === '.agent-knowledge/sources.json' ||
    normalized.startsWith('knowledge/') ||
    normalized.startsWith('raw/')
  ) {
    return normalized
  }
  throw new Error(`knowledge transaction contains an unsupported path: ${path}`)
}

function normalizeTransactionPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`knowledge file transaction has an unsafe path: ${path}`)
  }
  return normalized
}

async function readRegularFile(path: string): Promise<{ bytes: Buffer; mode: number } | null> {
  try {
    return await readRegularFileNoFollow(path)
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  }
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sameBytes(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) return left === right
  return left.equals(right)
}

function fileMatches(
  file: { bytes: Buffer; mode: number } | null,
  hash: string | null,
  mode: number | undefined,
): boolean {
  return (file ? hashBytes(file.bytes) : null) === hash && file?.mode === mode
}
