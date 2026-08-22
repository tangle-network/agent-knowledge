import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { canonicalJson, contentHash } from '@tangle-network/agent-eval'
import {
  canonicalPathsEqual,
  isMissingFile,
  listRegularFilesWithinRoot,
  readRegularFileWithinRoot,
  renameDurable,
  withSafeDirectory,
} from '../durable-fs'
import { sha256, stableId } from '../ids'
import { writeKnowledgeIndex } from '../indexer'
import { withKnowledgeRead } from '../mutation-lock'
import { layoutFor } from '../store'
import { immutableJsonValue } from './activation'
import type {
  KnowledgeImprovementCandidateRecord,
  KnowledgeImprovementCandidateRef,
  KnowledgeImprovementEvidence,
  KnowledgeImprovementResult,
  KnowledgeImprovementRunState,
  KnowledgeImprovementTarget,
  ResolvedKnowledgeImprovementCandidate,
  ResolvedKnowledgeImprovementComparison,
  UseKnowledgeImprovementCandidateOptions,
} from './contracts'
import {
  KnowledgeImprovementCandidateRefSchema,
  KnowledgeImprovementEvidenceSchema,
  safePathSegmentSchema,
} from './contracts'
import {
  assertExactCandidatePlatform,
  candidateEvidenceRelativePath,
  loadKnowledgeImprovementStateFromRun,
  withKnowledgeImprovementRun,
} from './state'

/** Freeze the exact knowledge bytes and measured evidence a later approval may promote. */
export function knowledgeImprovementCandidateRef(
  result: Pick<KnowledgeImprovementResult, 'runId' | 'state' | 'candidate'>,
): KnowledgeImprovementCandidateRef {
  if (!result.candidate) throw new Error('knowledge improvement result has no candidate')
  return candidateRefFor(result.runId, result.state, result.candidate)
}

/** Use both frozen sides of one measured comparison in isolated, integrity-checked copies. */
export async function withKnowledgeImprovementComparison<T>(
  options: UseKnowledgeImprovementCandidateOptions,
  use: (comparison: ResolvedKnowledgeImprovementComparison) => Promise<T> | T,
): Promise<T> {
  assertExactCandidatePlatform()
  const reference = Object.freeze(KnowledgeImprovementCandidateRefSchema.parse(options.candidate))
  return withKnowledgeImprovementRun(options.root, reference.runId, false, async (runDir) => {
    const state = await loadKnowledgeImprovementStateFromRun(options.root, reference.runId, runDir)
    return withMeasuredCandidateSnapshot(options.root, runDir, state, reference, (resolved) =>
      withBaselineSnapshot(runDir, reference.baseHash, (baselineRoot) =>
        withIsolatedKnowledgeCopy(baselineRoot, reference.baseHash, 'baseline', (baseline) =>
          withIsolatedKnowledgeCopy(
            resolved.root,
            reference.candidateHash,
            'candidate',
            (candidate) =>
              use(
                Object.freeze({
                  reference,
                  evaluation: immutableJsonValue(structuredClone(resolved.evidence.evaluation)),
                  baseline: Object.freeze({ root: baseline, hash: reference.baseHash }),
                  candidate: Object.freeze({ root: candidate, hash: reference.candidateHash }),
                }),
              ),
          ),
        ),
      ),
    )
  })
}

/** Use the frozen candidate side of one measured comparison. */
export async function withKnowledgeImprovementCandidate<T>(
  options: UseKnowledgeImprovementCandidateOptions,
  use: (candidate: ResolvedKnowledgeImprovementCandidate) => Promise<T> | T,
): Promise<T> {
  assertExactCandidatePlatform()
  const candidateRef = Object.freeze(
    KnowledgeImprovementCandidateRefSchema.parse(options.candidate),
  )
  return withKnowledgeImprovementRun(options.root, candidateRef.runId, false, async (runDir) => {
    const state = await loadKnowledgeImprovementStateFromRun(
      options.root,
      candidateRef.runId,
      runDir,
    )
    return withMeasuredCandidateSnapshot(options.root, runDir, state, candidateRef, (resolved) =>
      withIsolatedKnowledgeCopy(resolved.root, candidateRef.candidateHash, 'candidate', (root) =>
        use(
          Object.freeze({
            root,
            candidate: candidateRef,
            evaluation: immutableJsonValue(structuredClone(resolved.evidence.evaluation)),
          }),
        ),
      ),
    )
  })
}

export function candidateRefFor(
  runId: string,
  state: KnowledgeImprovementRunState,
  candidate: KnowledgeImprovementCandidateRecord,
): KnowledgeImprovementCandidateRef {
  if (candidate.status !== 'candidate-ready' && candidate.status !== 'promoted') {
    throw new Error(`knowledge candidate '${candidate.candidateId}' is not ready`)
  }
  return candidateIdentityFor(runId, state, candidate)
}

export function candidateIdentityFor(
  runId: string,
  state: KnowledgeImprovementRunState,
  candidate: KnowledgeImprovementCandidateRecord,
): KnowledgeImprovementCandidateRef {
  if (!candidate.candidateHash) {
    throw new Error(`knowledge candidate '${candidate.candidateId}' has no content hash`)
  }
  if (!candidate.evidenceHash) {
    throw new Error(`knowledge candidate '${candidate.candidateId}' has no evidence hash`)
  }
  if (!candidate.promotionPlanHash) {
    throw new Error(`knowledge candidate '${candidate.candidateId}' has no promotion plan hash`)
  }
  return Object.freeze({
    kind: 'knowledge-improvement-candidate',
    runId,
    candidateId: candidate.candidateId,
    goalHash: sha256(state.goal),
    baseHash: candidate.baseHash,
    candidateHash: candidate.candidateHash,
    evidenceHash: candidate.evidenceHash,
    promotionPlanHash: candidate.promotionPlanHash,
  })
}

export async function withMeasuredCandidateSnapshot<T>(
  liveRoot: string,
  runDir: string,
  state: KnowledgeImprovementRunState,
  candidateRef: KnowledgeImprovementCandidateRef,
  use: (snapshot: {
    root: string
    candidate: KnowledgeImprovementCandidateRecord
    evidence: KnowledgeImprovementEvidence
  }) => Promise<T> | T,
): Promise<T> {
  await assertStateIdentity(liveRoot, candidateRef, state)
  const candidate = state.candidates.find((entry) => entry.candidateId === candidateRef.candidateId)
  if (!candidate) {
    throw new Error(`knowledge candidate '${candidateRef.candidateId}' does not exist`)
  }
  const expectedRef = candidateRefFor(candidateRef.runId, state, candidate)
  if (canonicalJson(expectedRef) !== canonicalJson(candidateRef)) {
    throw new Error('knowledge candidate approval does not match the measured candidate')
  }
  const evidence = await assertCandidateEvidence(runDir, candidateRef, state.implementationRef)
  const relativePath = join(
    'candidates',
    candidate.candidateId,
    'snapshots',
    candidateRef.candidateHash,
  )
  return withSafeDirectory(runDir, relativePath, false, async (root) => {
    if ((await hashKnowledgeBase(root)) !== candidateRef.candidateHash) {
      throw new Error('knowledge candidate snapshot changed after approval')
    }
    const result = await use({ root, candidate, evidence })
    if ((await hashKnowledgeBase(root)) !== candidateRef.candidateHash) {
      throw new Error('knowledge candidate snapshot changed during use')
    }
    return result
  })
}

async function withIsolatedKnowledgeCopy<T>(
  sourceRoot: string,
  expectedHash: string,
  target: KnowledgeImprovementTarget,
  use: (root: string) => Promise<T> | T,
): Promise<T> {
  const isolationRoot = await mkdtemp(join(tmpdir(), 'agent-knowledge-snapshot-'))
  const snapshotRoot = join(isolationRoot, 'snapshot')
  try {
    await copyKnowledgeWorkspace(sourceRoot, snapshotRoot)
    if ((await hashKnowledgeBase(snapshotRoot)) !== expectedHash) {
      throw new Error(`isolated knowledge ${target} does not match its measured content`)
    }
    const result = await use(snapshotRoot)
    if ((await hashKnowledgeBase(snapshotRoot)) !== expectedHash) {
      throw new Error(`knowledge ${target} snapshot changed during use`)
    }
    return result
  } finally {
    await rm(isolationRoot, { recursive: true, force: true })
  }
}

export async function assertCandidateEvidence(
  runDir: string,
  candidate: KnowledgeImprovementCandidateRef,
  expectedImplementationRef: string,
): Promise<KnowledgeImprovementEvidence> {
  const evidence = KnowledgeImprovementEvidenceSchema.parse(
    JSON.parse(
      (
        await readRegularFileWithinRoot(
          runDir,
          candidateEvidenceRelativePath(candidate.candidateId),
        )
      ).bytes.toString('utf8'),
    ),
  )
  const actualHash = contentHash(evidence)
  if (actualHash !== candidate.evidenceHash) {
    throw new Error(
      `knowledge candidate evidence changed after approval: expected ${candidate.evidenceHash}, got ${actualHash}`,
    )
  }
  if (
    evidence.runId !== candidate.runId ||
    evidence.candidateId !== candidate.candidateId ||
    evidence.goalHash !== candidate.goalHash ||
    evidence.implementationRef !== expectedImplementationRef ||
    evidence.baseHash !== candidate.baseHash ||
    evidence.candidateHash !== candidate.candidateHash ||
    evidence.promotionPlanHash !== candidate.promotionPlanHash ||
    evidence.evaluation.passed !== true
  ) {
    throw new Error('knowledge candidate evidence does not match the approved candidate')
  }
  return evidence
}

export async function assertStateIdentity(
  root: string,
  candidateRef: KnowledgeImprovementCandidateRef,
  state: KnowledgeImprovementRunState,
): Promise<void> {
  if (state.runId !== candidateRef.runId) {
    throw new Error('knowledge candidate run identity does not match persisted state')
  }
  if (!(await canonicalPathsEqual(state.root, root))) {
    throw new Error('knowledge candidate root does not match persisted state')
  }
  if (sha256(state.goal) !== candidateRef.goalHash) {
    throw new Error('knowledge candidate goal does not match persisted state')
  }
  if (state.baseHash !== candidateRef.baseHash) {
    throw new Error('knowledge candidate base does not match persisted state')
  }
}

export async function createCandidateWorkspace(
  runDir: string,
  state: KnowledgeImprovementRunState,
  root: string,
  now: () => Date,
): Promise<KnowledgeImprovementCandidateRecord> {
  const iteration = state.candidates.length + 1
  const candidateId = stableId('kcand', `${state.runId}:${iteration}:${now().toISOString()}`)
  const candidateRoot = candidateWorkspacePath(runDir, candidateId)
  await copyKnowledgeWorkspace(root, candidateRoot)
  const createdAt = now().toISOString()
  return {
    iteration,
    candidateId,
    baseHash: state.baseHash,
    status: 'running',
    createdAt,
    updatedAt: createdAt,
  }
}

function candidateWorkspacePath(runDir: string, candidateId: string): string {
  return join(runDir, 'candidates', safePathSegmentSchema.parse(candidateId), 'workspace')
}

function baselineSnapshotPath(runDir: string): string {
  return join(runDir, 'baseline')
}

export async function createBaselineSnapshot(
  runDir: string,
  root: string,
  expectedHash: string,
): Promise<void> {
  const target = baselineSnapshotPath(runDir)
  try {
    await assertBaselineSnapshot(runDir, expectedHash)
    return
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
  const preparation = await mkdtemp(join(runDir, 'baseline-prepare-'))
  let activated = false
  try {
    await copyKnowledgeWorkspace(root, preparation)
    const actualHash = await hashKnowledgeBase(preparation)
    if (actualHash !== expectedHash) {
      throw new Error(
        `knowledge base changed while baseline was frozen: expected ${expectedHash}, got ${actualHash}`,
      )
    }
    await renameDurable(preparation, target)
    activated = true
  } finally {
    if (!activated) await rm(preparation, { recursive: true, force: true })
  }
}

export async function ensureBaselineSnapshot(
  runDir: string,
  root: string,
  expectedHash: string,
): Promise<void> {
  try {
    await assertBaselineSnapshot(runDir, expectedHash)
  } catch (error) {
    if (!isMissingFile(error)) throw error
    const liveHash = await hashKnowledgeBase(root)
    if (liveHash !== expectedHash) {
      throw new Error(
        'knowledge improvement baseline snapshot is missing and cannot be reconstructed',
      )
    }
    await createBaselineSnapshot(runDir, root, expectedHash)
  }
}

async function assertBaselineSnapshot(runDir: string, expectedHash: string): Promise<void> {
  await withBaselineSnapshot(runDir, expectedHash, () => undefined)
}

export async function withBaselineSnapshot<T>(
  runDir: string,
  expectedHash: string,
  use: (baselineRoot: string) => Promise<T> | T,
): Promise<T> {
  return withSafeDirectory(runDir, 'baseline', false, async (baselineRoot) => {
    const actualHash = await hashKnowledgeBase(baselineRoot)
    if (actualHash !== expectedHash) {
      throw new Error(
        `knowledge improvement baseline changed: expected ${expectedHash}, got ${actualHash}`,
      )
    }
    return use(baselineRoot)
  })
}

export async function withFrozenCandidateWorkspace<T>(
  runDir: string,
  candidate: KnowledgeImprovementCandidateRecord,
  candidateRoot: string,
  use: (snapshot: { root: string; hash: string }) => Promise<T> | T,
): Promise<T> {
  const snapshotsPath = join(
    'candidates',
    safePathSegmentSchema.parse(candidate.candidateId),
    'snapshots',
  )
  return withSafeDirectory(runDir, snapshotsPath, true, async (snapshotsDir) => {
    const preparation = await mkdtemp(join(snapshotsDir, 'prepare-'))
    let activated = false
    try {
      await copyKnowledgeWorkspace(candidateRoot, preparation)
      const hash = await hashKnowledgeBase(preparation)
      try {
        const result = await withSafeDirectory(snapshotsDir, hash, false, async (existing) => {
          if ((await hashKnowledgeBase(existing)) !== hash) {
            throw new Error('knowledge candidate snapshot does not match its content identity')
          }
          return use({ root: existing, hash })
        })
        await rm(preparation, { recursive: true, force: true })
        activated = true
        return result
      } catch (error) {
        if (!isMissingFile(error)) throw error
      }
      await renameDurable(preparation, join(snapshotsDir, hash))
      activated = true
      return withSafeDirectory(snapshotsDir, hash, false, (root) => use({ root, hash }))
    } finally {
      if (!activated) await rm(preparation, { recursive: true, force: true })
    }
  })
}

export function clearCandidateMeasurement(candidate: KnowledgeImprovementCandidateRecord): void {
  delete candidate.candidateHash
  delete candidate.evidenceHash
  delete candidate.promotionPlanHash
}

async function copyKnowledgeWorkspace(sourceRoot: string, targetRoot: string): Promise<void> {
  await rm(targetRoot, { recursive: true, force: true })
  await mkdir(join(targetRoot, 'knowledge'), { recursive: true })
  await mkdir(join(targetRoot, 'raw', 'sources'), { recursive: true })
  await copyIfExists(join(sourceRoot, 'knowledge'), join(targetRoot, 'knowledge'))
  await copyIfExists(join(sourceRoot, 'raw'), join(targetRoot, 'raw'))
  await copyIfExists(
    join(layoutFor(sourceRoot).cacheDir, 'sources.json'),
    join(layoutFor(targetRoot).cacheDir, 'sources.json'),
  )
  await writeKnowledgeIndex(targetRoot)
}

async function copyIfExists(source: string, target: string): Promise<void> {
  let sourceStat: Awaited<ReturnType<typeof lstat>>
  try {
    sourceStat = await lstat(source)
  } catch (error) {
    if (isMissingFile(error)) return
    throw error
  }
  if (!sourceStat.isDirectory() && !sourceStat.isFile()) {
    throw new Error(`knowledge surface contains an unsupported filesystem entry: ${source}`)
  }
  await mkdir(dirname(target), { recursive: true })
  await cp(source, target, { recursive: sourceStat.isDirectory(), dereference: false })
}

export async function hashKnowledgeBase(root: string): Promise<string> {
  return withKnowledgeRead(root, () => hashKnowledgeBaseUnlocked(root))
}

async function hashKnowledgeBaseUnlocked(root: string): Promise<string> {
  const entries = await knowledgeHashEntries(root)
  return sha256(JSON.stringify(entries.map(({ path, hash, mode }) => ({ path, hash, mode }))))
}

export interface KnowledgeFileIdentity {
  path: string
  hash: string
  transactionHash: string
  mode: number
}

export async function knowledgeHashEntries(root: string): Promise<KnowledgeFileIdentity[]> {
  const entries: KnowledgeFileIdentity[] = []
  for (const rel of ['knowledge', 'raw']) {
    try {
      for (const file of await listRegularFilesWithinRoot(root, rel)) {
        entries.push(knowledgeFileIdentity(file.path, file.bytes, file.mode))
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error
    }
  }
  const sourceRegistry = relative(root, layoutFor(root).sourceRegistryPath).replace(/\\/g, '/')
  try {
    const file = await readRegularFileWithinRoot(root, sourceRegistry)
    entries.push(knowledgeFileIdentity(sourceRegistry, file.bytes, file.mode))
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return entries
}

function knowledgeFileIdentity(path: string, bytes: Buffer, mode: number): KnowledgeFileIdentity {
  return {
    path,
    hash: sha256(bytes.toString('base64')),
    transactionHash: createHash('sha256').update(bytes).digest('hex'),
    mode,
  }
}
