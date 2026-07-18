import { canonicalJson } from '@tangle-network/agent-eval'
import {
  type AgentImprovementActivation,
  type AgentImprovementActivationResult,
  agentImprovementActivationResultSchema,
  agentImprovementActivationSchema,
  canonicalCandidateDigest,
  omitTopLevelDigest,
  type Sha256Digest,
  sha256DigestSchema,
} from '@tangle-network/agent-interface'
import { z } from 'zod'
import { isMissingFile, readRegularFileWithinRoot, writeJsonDurableWithinRoot } from '../durable-fs'
import type {
  KnowledgeImprovementActivationPersistence,
  KnowledgeImprovementActivationRecord,
  KnowledgeImprovementCandidateRef,
  KnowledgeImprovementMutationReceipt,
  KnowledgeImprovementTarget,
  LoadKnowledgeImprovementActivationResultOptions,
} from './contracts'
import {
  digestSchema,
  KnowledgeImprovementCandidateRefSchema,
  knowledgeImprovementActivationRecordSchema,
  knowledgeImprovementMutationReceiptSchema,
} from './contracts'
import { assertExactCandidatePlatform, withKnowledgeImprovementRun } from './state'

/** Load the durable result for one exact activation without changing knowledge or run state. */
export async function loadKnowledgeImprovementActivationResult(
  options: LoadKnowledgeImprovementActivationResultOptions,
): Promise<AgentImprovementActivationResult | null> {
  assertExactCandidatePlatform()
  const candidate = Object.freeze(KnowledgeImprovementCandidateRefSchema.parse(options.candidate))
  const activation = verifyCanonicalKnowledgeActivation(options.activation)
  const target = targetForKnowledgeActivation(activation)
  assertKnowledgeActivationAuthority(activation, candidate, target, options.identity)
  return withKnowledgeImprovementRun(options.root, candidate.runId, false, async (runDir) => {
    const record = await loadKnowledgeActivationRecord(
      runDir,
      candidate,
      activation,
      target,
      options.identity,
    )
    return record?.result ?? null
  })
}

export interface ResolvedKnowledgeImprovementActivationPersistence
  extends KnowledgeImprovementActivationPersistence {
  activation: AgentImprovementActivation
}

export function sourceKnowledgeHash(
  candidate: KnowledgeImprovementCandidateRef,
  target: KnowledgeImprovementTarget,
): string {
  return target === 'candidate' ? candidate.baseHash : candidate.candidateHash
}

function targetForKnowledgeActivation(
  activation: AgentImprovementActivation,
): KnowledgeImprovementTarget {
  return activation.intent === 'activate-candidate' ? 'candidate' : 'baseline'
}

export function resolveKnowledgeActivationPersistence(
  input: KnowledgeImprovementActivationPersistence,
  candidate: KnowledgeImprovementCandidateRef,
  target: KnowledgeImprovementTarget,
): ResolvedKnowledgeImprovementActivationPersistence {
  const activation = verifyCanonicalKnowledgeActivation(input.activation)
  assertKnowledgeActivationAuthority(activation, candidate, target, input.identity)
  const attemptedAt = z.iso.datetime().parse(input.attemptedAt)
  if (
    Date.parse(attemptedAt) < Date.parse(activation.authorizedAt) ||
    Date.parse(attemptedAt) >= Date.parse(activation.expiresAt)
  ) {
    throw new Error('knowledge activation attempt is outside its authorization window')
  }
  return Object.freeze({
    activation,
    attemptedAt,
    identity: input.identity,
    createResult: input.createResult,
  })
}

function assertKnowledgeActivationAuthority(
  activation: AgentImprovementActivation,
  candidate: KnowledgeImprovementCandidateRef,
  target: KnowledgeImprovementTarget,
  identity: string,
): void {
  if (!identity.trim()) throw new Error('knowledge activation identity is required')
  if (targetForKnowledgeActivation(activation) !== target) {
    throw new Error('knowledge activation intent does not match the requested transition')
  }
  if (activation.targets.length !== 1) {
    throw new Error('knowledge activation requires exactly one target')
  }
  const authorizedTarget = activation.targets[0]
  if (authorizedTarget.surface !== 'knowledge' || authorizedTarget.identity !== identity) {
    throw new Error('knowledge activation target does not match this knowledge base')
  }
  if (
    authorizedTarget.expectedBaseDigest !==
    prefixedKnowledgeDigest(sourceKnowledgeHash(candidate, target))
  ) {
    throw new Error('knowledge activation does not authorize the measured source state')
  }
}

function verifyCanonicalKnowledgeActivation(
  value: AgentImprovementActivation,
): AgentImprovementActivation {
  const activation = agentImprovementActivationSchema.parse(value)
  if (canonicalCandidateDigest(omitTopLevelDigest(activation)) !== activation.digest) {
    throw new Error('knowledge activation digest does not match its canonical content')
  }
  return immutableJsonValue(structuredClone(activation))
}

function verifyCanonicalKnowledgeActivationResult(
  value: AgentImprovementActivationResult,
): AgentImprovementActivationResult {
  const result = agentImprovementActivationResultSchema.parse(value)
  if (canonicalCandidateDigest(omitTopLevelDigest(result)) !== result.digest) {
    throw new Error('knowledge activation result digest does not match its canonical content')
  }
  return immutableJsonValue(structuredClone(result))
}

export async function persistKnowledgeActivationResult(
  runDir: string,
  candidate: KnowledgeImprovementCandidateRef,
  persistence: ResolvedKnowledgeImprovementActivationPersistence,
  target: KnowledgeImprovementTarget,
  mutation: KnowledgeImprovementMutationReceipt,
): Promise<AgentImprovementActivationResult> {
  const result = assertKnowledgeActivationResult(
    persistence.activation,
    candidate,
    target,
    persistence.identity,
    mutation,
    await persistence.createResult(Object.freeze({ ...mutation })),
    persistence.attemptedAt,
  )
  const record = knowledgeImprovementActivationRecordSchema.parse({
    kind: 'knowledge-improvement-activation-result',
    candidateId: candidate.candidateId,
    mutation,
    result,
  })
  const existing = await loadKnowledgeActivationRecord(
    runDir,
    candidate,
    persistence.activation,
    target,
    persistence.identity,
  )
  if (existing) {
    if (canonicalJson(existing) !== canonicalJson(record)) {
      throw new Error('knowledge activation result identity conflicts with durable content')
    }
    return existing.result
  }
  await writeJsonDurableWithinRoot(
    runDir,
    knowledgeActivationResultPath(persistence.activation.digest),
    record,
  )
  const stored = await loadKnowledgeActivationRecord(
    runDir,
    candidate,
    persistence.activation,
    target,
    persistence.identity,
  )
  if (!stored || canonicalJson(stored) !== canonicalJson(record)) {
    throw new Error('knowledge activation result was not durably persisted')
  }
  return stored.result
}

export async function loadKnowledgeActivationRecord(
  runDir: string,
  candidate: KnowledgeImprovementCandidateRef,
  activation: AgentImprovementActivation,
  target: KnowledgeImprovementTarget,
  identity: string,
): Promise<KnowledgeImprovementActivationRecord | null> {
  let raw: unknown
  try {
    const file = await readRegularFileWithinRoot(
      runDir,
      knowledgeActivationResultPath(activation.digest),
    )
    raw = JSON.parse(file.bytes.toString('utf8')) as unknown
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  }
  const record = knowledgeImprovementActivationRecordSchema.parse(raw)
  if (record.candidateId !== candidate.candidateId) {
    throw new Error('knowledge activation result belongs to another candidate')
  }
  const result = assertKnowledgeActivationResult(
    activation,
    candidate,
    target,
    identity,
    record.mutation,
    record.result,
  )
  return immutableJsonValue({ ...record, result })
}

function assertKnowledgeActivationResult(
  activation: AgentImprovementActivation,
  candidate: KnowledgeImprovementCandidateRef,
  target: KnowledgeImprovementTarget,
  identity: string,
  mutationInput: KnowledgeImprovementMutationReceipt,
  resultInput: AgentImprovementActivationResult,
  attemptedAt?: string,
): AgentImprovementActivationResult {
  assertKnowledgeActivationAuthority(activation, candidate, target, identity)
  const mutation = knowledgeImprovementMutationReceiptSchema.parse(mutationInput)
  const result = verifyCanonicalKnowledgeActivationResult(resultInput)
  if (
    result.idempotencyKey !== activation.digest ||
    (attemptedAt !== undefined && result.attemptedAt !== attemptedAt) ||
    Date.parse(result.attemptedAt) < Date.parse(activation.authorizedAt) ||
    Date.parse(result.attemptedAt) >= Date.parse(activation.expiresAt) ||
    mutation.target !== target ||
    mutation.changed !== (mutation.beforeHash !== mutation.afterHash) ||
    (!mutation.changed && (mutation.transactionId !== null || mutation.recovered))
  ) {
    throw new Error('knowledge activation result does not bind its authorized mutation')
  }

  const sourceDigest = prefixedKnowledgeDigest(sourceKnowledgeHash(candidate, target))
  const desiredDigest = prefixedKnowledgeDigest(
    target === 'candidate' ? candidate.candidateHash : candidate.baseHash,
  )
  const beforeDigest = prefixedKnowledgeDigest(mutation.beforeHash)
  const afterDigest = prefixedKnowledgeDigest(mutation.afterHash)
  const outcome = result.outcome
  if (mutation.changed) {
    if (
      mutation.transactionId === null ||
      beforeDigest !== sourceDigest ||
      afterDigest !== desiredDigest ||
      outcome.status !== 'applied' ||
      outcome.transactionId !== mutation.transactionId ||
      outcome.targets.length !== 1 ||
      outcome.targets[0]?.surface !== 'knowledge' ||
      outcome.targets[0]?.identity !== identity ||
      outcome.targets[0]?.beforeDigest !== beforeDigest ||
      outcome.targets[0]?.afterDigest !== afterDigest
    ) {
      throw new Error('knowledge activation result does not prove the applied transaction')
    }
    return result
  }

  const expectedStatus = afterDigest === desiredDigest ? 'already-applied' : 'conflict'
  if (
    afterDigest === sourceDigest ||
    outcome.status !== expectedStatus ||
    outcome.targets.length !== 1 ||
    outcome.targets[0]?.surface !== 'knowledge' ||
    outcome.targets[0]?.identity !== identity ||
    outcome.targets[0]?.currentDigest !== afterDigest
  ) {
    throw new Error('knowledge activation result does not prove the observed target state')
  }
  return result
}

function knowledgeActivationResultPath(digest: Sha256Digest): string {
  const parsed = sha256DigestSchema.parse(digest)
  return `activation-results/${parsed.slice('sha256:'.length)}.json`
}

function prefixedKnowledgeDigest(hash: string): Sha256Digest {
  return sha256DigestSchema.parse(`sha256:${digestSchema.parse(hash)}`)
}

export function immutableJsonValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const child of Object.values(value)) immutableJsonValue(child)
  return Object.freeze(value)
}
