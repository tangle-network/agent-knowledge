import { stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { canonicalJson, contentHash } from '@tangle-network/agent-eval'
import {
  isMissingFile,
  listRegularFilesWithinRoot,
  readRegularFileWithinRoot,
  withSafeDirectory,
  writeJsonDurableWithinRoot,
} from '../durable-fs'
import { sha256, slugify, stableId } from '../ids'
import { acquireDurableFileLock } from '../mutation-lock'
import { layoutFor } from '../store'
import type {
  KnowledgeImprovementCandidateRecord,
  KnowledgeImprovementOptions,
  KnowledgeImprovementRunState,
  LeaseHandle,
} from './contracts'
import { KnowledgeImprovementRunStateSchema, runIdSchema, safePathSegmentSchema } from './contracts'

export function knowledgeImprovementRunId(root: string, goal: string): string {
  return stableId('kimpr', `${root}:${goal}`)
}

export function knowledgeImprovementRunDir(root: string, runId: string): string {
  const parsedRunId = runIdSchema.parse(runId)
  const safeRunId = safePathSegmentSchema.safeParse(parsedRunId)
  const runSegment = safeRunId.success
    ? safeRunId.data
    : `${slugify(parsedRunId).slice(0, 72)}-${sha256(parsedRunId).slice(0, 16)}`
  const improvementsDir = join(layoutFor(root).cacheDir, 'improvements')
  const runDir = join(improvementsDir, runSegment)
  const resolvedImprovementsDir = resolve(improvementsDir)
  const resolvedRunDir = resolve(runDir)
  if (!resolvedRunDir.startsWith(`${resolvedImprovementsDir}${sep}`)) {
    throw new Error('knowledge improvement run directory escaped its root')
  }
  return runDir
}

export async function withKnowledgeImprovementRun<T>(
  root: string,
  runId: string,
  create: boolean,
  use: (runDir: string) => Promise<T> | T,
): Promise<T> {
  const runDir = knowledgeImprovementRunDir(root, runId)
  const relativePath = descendantPath(root, runDir)
  if (!relativePath) throw new Error('knowledge improvement run directory escaped its root')
  return withSafeDirectory(root, relativePath, create, async (openedRunDir) => {
    const result = await use(openedRunDir)
    const openedIdentity = await stat(openedRunDir)
    const currentIdentity = await withSafeDirectory(root, relativePath, false, (currentRunDir) =>
      stat(currentRunDir),
    )
    if (openedIdentity.dev !== currentIdentity.dev || openedIdentity.ino !== currentIdentity.ino) {
      throw new Error('knowledge improvement run directory changed during use')
    }
    return result
  })
}

export async function loadKnowledgeImprovementState(
  root: string,
  runId: string,
): Promise<KnowledgeImprovementRunState | null> {
  const expectedRunId = runIdSchema.parse(runId)
  try {
    return await withKnowledgeImprovementRun(root, expectedRunId, false, (runDir) =>
      loadKnowledgeImprovementStateFromRun(root, expectedRunId, runDir),
    )
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  }
}

export async function loadKnowledgeImprovementStateFromRun(
  root: string,
  runId: string,
  runDir: string,
): Promise<KnowledgeImprovementRunState> {
  const stateFile = await readRegularFileWithinRoot(runDir, 'state.json')
  const raw = JSON.parse(stateFile.bytes.toString('utf8')) as unknown
  const state = KnowledgeImprovementRunStateSchema.parse(raw) as KnowledgeImprovementRunState
  if (state.runId !== runId) {
    throw new Error('knowledge improvement state does not match the requested run')
  }
  if (resolve(state.root) !== resolve(root)) {
    throw new Error('knowledge improvement state does not match the requested root')
  }
  for (const candidate of state.candidates) {
    if (candidate.status === 'running') await assertCandidateWorkspace(runDir, candidate)
  }
  return state
}

async function assertCandidateWorkspace(
  runDir: string,
  candidate: Pick<KnowledgeImprovementCandidateRecord, 'candidateId'>,
): Promise<void> {
  await withCandidateWorkspace(runDir, candidate, () => undefined)
}

export async function withCandidateWorkspace<T>(
  runDir: string,
  candidate: Pick<KnowledgeImprovementCandidateRecord, 'candidateId'>,
  use: (candidateRoot: string) => Promise<T> | T,
): Promise<T> {
  return withSafeDirectory(
    runDir,
    join('candidates', safePathSegmentSchema.parse(candidate.candidateId), 'workspace'),
    false,
    use,
  )
}

export function findActiveCandidate(
  state: KnowledgeImprovementRunState,
): KnowledgeImprovementCandidateRecord | undefined {
  return [...state.candidates]
    .reverse()
    .find((candidate) => candidate.status === 'candidate-ready' || candidate.status === 'running')
}

export interface KnowledgeImprovementEvent extends Record<string, unknown> {
  at: string
  type: string
}

export async function loadKnowledgeImprovementEvents(
  root: string,
  runId: string,
): Promise<KnowledgeImprovementEvent[]> {
  const parsedRunId = runIdSchema.parse(runId)
  try {
    return await withKnowledgeImprovementRun(root, parsedRunId, false, (runDir) =>
      loadKnowledgeImprovementEventsFromRun(runDir),
    )
  } catch (error) {
    if (isMissingFile(error)) return []
    throw error
  }
}

export async function loadKnowledgeImprovementEventsFromRun(
  runDir: string,
): Promise<KnowledgeImprovementEvent[]> {
  const events: KnowledgeImprovementEvent[] = []
  try {
    for (const file of await listRegularFilesWithinRoot(runDir, 'events')) {
      const name = file.path.slice('events/'.length)
      if (name.includes('/') || !name.endsWith('.json')) {
        throw new Error(`knowledge event store contains an unsupported entry: ${name}`)
      }
      events.push(parseKnowledgeImprovementEvent(JSON.parse(file.bytes.toString('utf8'))))
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }

  const unique = new Map<string, KnowledgeImprovementEvent>()
  for (const event of events) {
    const { at: _at, ...semantic } = event
    unique.set(contentHash(semantic), event)
  }
  return [...unique.values()].sort((left, right) => left.at.localeCompare(right.at))
}

function parseKnowledgeImprovementEvent(value: unknown): KnowledgeImprovementEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('knowledge improvement event is not an object')
  }
  const event = value as Record<string, unknown>
  if (typeof event.at !== 'string' || typeof event.type !== 'string') {
    throw new Error('knowledge improvement event is missing at or type')
  }
  return event as KnowledgeImprovementEvent
}

export async function acquireRunLease(
  runDir: string,
  options: { ownerId: string; ttlMs: number },
): Promise<LeaseHandle> {
  const path = join(runDir, 'run.lock.durable')
  const acquired = await acquireDurableFileLock(runDir, {
    lockfilePath: path,
    staleMs: options.ttlMs,
  })
  return {
    ownerId: options.ownerId,
    assertOwned: acquired.assertOwned,
    release: acquired.release,
  }
}

export async function blockRun(
  runDir: string,
  state: KnowledgeImprovementRunState,
  reason: string,
  onState: KnowledgeImprovementOptions['onState'],
  now: () => Date,
): Promise<KnowledgeImprovementRunState> {
  state.status = 'blocked'
  state.blockedReason = reason
  state.updatedAt = now().toISOString()
  await saveState(runDir, state, onState)
  return state
}

export async function saveState(
  runDir: string,
  state: KnowledgeImprovementRunState,
  onState?: KnowledgeImprovementOptions['onState'],
): Promise<void> {
  await writeJsonDurableWithinRoot(
    runDir,
    'state.json',
    KnowledgeImprovementRunStateSchema.parse(state),
  )
  await onState?.(state)
}

export async function appendLedger(runDir: string, value: Record<string, unknown>): Promise<void> {
  const type = value.type
  if (typeof type !== 'string' || type.length === 0) {
    throw new Error('knowledge improvement event requires a type')
  }
  const relativePath = join('events', `${contentHash(value)}.json`).replace(/\\/g, '/')
  try {
    const file = await readRegularFileWithinRoot(runDir, relativePath)
    const existing = parseKnowledgeImprovementEvent(JSON.parse(file.bytes.toString('utf8')))
    const { at: _at, ...semantic } = existing
    if (canonicalJson(semantic) !== canonicalJson(value)) {
      throw new Error('knowledge improvement event identity conflicts with durable content')
    }
    return
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
  await writeJsonDurableWithinRoot(runDir, relativePath, {
    at: new Date().toISOString(),
    ...value,
  })
}

export function candidateEvidenceRelativePath(candidateId: string): string {
  return join('candidates', safePathSegmentSchema.parse(candidateId), 'evidence.json').replace(
    /\\/g,
    '/',
  )
}

function descendantPath(root: string, path: string): string | undefined {
  const value = relative(resolve(root), resolve(path)).replace(/\\/g, '/')
  if (value === '' || value === '..' || value.startsWith('../') || isAbsolute(value))
    return undefined
  return value
}

export function assertExactCandidatePlatform(): void {
  if (process.platform !== 'linux') {
    throw new Error('exact knowledge candidate workflows require Linux directory descriptors')
  }
}
