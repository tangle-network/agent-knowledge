import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
import {
  KNOWLEDGE_RESEARCH_STATE_PATHS,
  type KnowledgeStateScope,
  normalizeKnowledgeStateScope,
} from '../knowledge-state-scope'
import { withKnowledgeRead } from '../mutation-lock'
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
      withBaselineSnapshot(
        runDir,
        reference.baseHash,
        (baselineRoot) =>
          withIsolatedKnowledgeCopy(
            baselineRoot,
            reference.baseHash,
            'baseline',
            (baseline) =>
              withIsolatedKnowledgeCopy(
                resolved.root,
                reference.candidateHash,
                'candidate',
                (candidate) =>
                  use(
                    Object.freeze({
                      reference,
                      stateScope: Object.freeze(normalizeKnowledgeStateScope(state.stateScope)),
                      evaluation: immutableJsonValue(structuredClone(resolved.evidence.evaluation)),
                      baseline: Object.freeze({ root: baseline, hash: reference.baseHash }),
                      candidate: Object.freeze({ root: candidate, hash: reference.candidateHash }),
                    }),
                  ),
                state.stateScope,
              ),
            state.stateScope,
          ),
        state.stateScope,
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
      withIsolatedKnowledgeCopy(
        resolved.root,
        candidateRef.candidateHash,
        'candidate',
        (root) =>
          use(
            Object.freeze({
              root,
              candidate: candidateRef,
              stateScope: Object.freeze(normalizeKnowledgeStateScope(state.stateScope)),
              evaluation: immutableJsonValue(structuredClone(resolved.evidence.evaluation)),
            }),
          ),
        state.stateScope,
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
    if ((await hashKnowledgeBase(root, state.stateScope)) !== candidateRef.candidateHash) {
      throw new Error('knowledge candidate snapshot changed after approval')
    }
    const result = await use({ root, candidate, evidence })
    if ((await hashKnowledgeBase(root, state.stateScope)) !== candidateRef.candidateHash) {
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
  scope?: KnowledgeStateScope,
): Promise<T> {
  const isolationRoot = await mkdtemp(join(tmpdir(), 'agent-knowledge-snapshot-'))
  const snapshotRoot = join(isolationRoot, 'snapshot')
  try {
    await copyKnowledgeWorkspace(sourceRoot, snapshotRoot, scope)
    if ((await hashKnowledgeBase(snapshotRoot, scope)) !== expectedHash) {
      throw new Error(`isolated knowledge ${target} does not match its measured content`)
    }
    const result = await use(snapshotRoot)
    if ((await hashKnowledgeBase(snapshotRoot, scope)) !== expectedHash) {
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
  await copyKnowledgeWorkspace(root, candidateRoot, state.stateScope)
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
  scope?: KnowledgeStateScope,
): Promise<void> {
  const target = baselineSnapshotPath(runDir)
  try {
    await assertBaselineSnapshot(runDir, expectedHash, scope)
    return
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
  const preparation = await mkdtemp(join(runDir, 'baseline-prepare-'))
  let activated = false
  try {
    await copyKnowledgeWorkspace(root, preparation, scope)
    const actualHash = await hashKnowledgeBase(preparation, scope)
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
  scope?: KnowledgeStateScope,
): Promise<void> {
  try {
    await assertBaselineSnapshot(runDir, expectedHash, scope)
  } catch (error) {
    if (!isMissingFile(error)) throw error
    const liveHash = await hashKnowledgeBase(root, scope)
    if (liveHash !== expectedHash) {
      throw new Error(
        'knowledge improvement baseline snapshot is missing and cannot be reconstructed',
      )
    }
    await createBaselineSnapshot(runDir, root, expectedHash, scope)
  }
}

async function assertBaselineSnapshot(
  runDir: string,
  expectedHash: string,
  scope?: KnowledgeStateScope,
): Promise<void> {
  await withBaselineSnapshot(runDir, expectedHash, () => undefined, scope)
}

export async function withBaselineSnapshot<T>(
  runDir: string,
  expectedHash: string,
  use: (baselineRoot: string) => Promise<T> | T,
  scope?: KnowledgeStateScope,
): Promise<T> {
  return withSafeDirectory(runDir, 'baseline', false, async (baselineRoot) => {
    const actualHash = await hashKnowledgeBase(baselineRoot, scope)
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
  scope?: KnowledgeStateScope,
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
      await copyKnowledgeWorkspace(candidateRoot, preparation, scope)
      const hash = await hashKnowledgeBase(preparation, scope)
      try {
        const result = await withSafeDirectory(snapshotsDir, hash, false, async (existing) => {
          if ((await hashKnowledgeBase(existing, scope)) !== hash) {
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

async function copyKnowledgeWorkspace(
  sourceRoot: string,
  targetRoot: string,
  scope?: KnowledgeStateScope,
): Promise<void> {
  const normalized = normalizeKnowledgeStateScope(scope)
  await withKnowledgeRead(sourceRoot, async () => {
    await rm(targetRoot, { recursive: true, force: true })
    await mkdir(join(targetRoot, normalized.pagesDirectory), { recursive: true })
    await mkdir(join(targetRoot, 'raw', 'sources'), { recursive: true })
    for (const path of knowledgeScopePaths(normalized)) {
      await copyIfExists(join(sourceRoot, path), join(targetRoot, path))
    }
  })
  await writeKnowledgeIndex(targetRoot, { pagesDirectory: normalized.pagesDirectory })
}

function knowledgeScopePaths(scope: KnowledgeStateScope): string[] {
  const normalized = normalizeKnowledgeStateScope(scope)
  return [
    normalized.pagesDirectory,
    'raw',
    '.agent-knowledge/sources.json',
    ...(normalized.researchState ? KNOWLEDGE_RESEARCH_STATE_PATHS : []),
  ]
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

export async function hashKnowledgeBase(
  root: string,
  scope?: KnowledgeStateScope,
): Promise<string> {
  return withKnowledgeRead(root, () => hashKnowledgeBaseUnlocked(root, scope))
}

async function hashKnowledgeBaseUnlocked(
  root: string,
  scope?: KnowledgeStateScope,
): Promise<string> {
  const normalized = normalizeKnowledgeStateScope(scope)
  const entries = await knowledgeHashEntries(root, normalized)
  const files = entries.map(({ path, hash, mode }) => ({ path, hash, mode }))
  return sha256(
    JSON.stringify(
      normalized.pagesDirectory === 'knowledge' && !normalized.researchState
        ? files
        : { scope: normalized, files },
    ),
  )
}

export interface KnowledgeFileIdentity {
  path: string
  hash: string
  transactionHash: string
  mode: number
}

export async function knowledgeHashEntries(
  root: string,
  scope?: KnowledgeStateScope,
): Promise<KnowledgeFileIdentity[]> {
  const entries: KnowledgeFileIdentity[] = []
  for (const path of knowledgeScopePaths(scope ?? {})) {
    try {
      const files =
        path === '.agent-knowledge/sources.json' || path === '.agent-knowledge/events.json'
          ? [{ ...(await readRegularFileWithinRoot(root, path)), path }]
          : await listRegularFilesWithinRoot(root, path)
      for (const file of files)
        entries.push(knowledgeFileIdentity(file.path, file.bytes, file.mode))
    } catch (error) {
      if (!isMissingFile(error)) throw error
    }
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
