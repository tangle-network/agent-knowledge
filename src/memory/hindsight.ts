import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { sha256 } from '../ids'
import { defaultGetMemoryContext } from './adapter'
import { canonicalMemoryJson } from './json'
import { runBoundedMemoryLifecycle } from './lifecycle'
import { AgentMemoryWriteInputSchema } from './schemas'
import { memoryWriteResultToSourceRecord } from './source-record'
import type { AgentMemoryAdapter, AgentMemoryHit, AgentMemoryScope } from './types'

/** Transport owns endpoint selection and authentication; paths are always bank-bound here. */
export interface HindsightClientLike {
  request(input: {
    method: 'GET' | 'POST'
    path: string
    body?: unknown
    signal: AbortSignal
  }): Promise<{ status: number; body: unknown }>
}

export interface HindsightMemoryAdapterOptions {
  client: HindsightClientLike
  /** Stable deployment identity, never a credential. Changing it changes every bank identity. */
  backendRef: string
  branchId: string
  requestTimeoutMs?: number
  ingestionTimeoutMs?: number
  pollIntervalMs?: number
  maxTextChars?: number
  recallMaxTokens?: number
}

export class HindsightOperationUnknownError extends Error {
  constructor(
    readonly bankId: string,
    readonly operationId: string,
    readonly documentId: string,
    options?: ErrorOptions,
  ) {
    super(
      'Hindsight retain is unresolved; retry the same write id and bytes to reconcile it before checkpointing',
      options,
    )
    this.name = 'HindsightOperationUnknownError'
  }
}

const operationSchema = z.object({
  operation_id: z.string(),
  status: z.enum(['pending', 'processing', 'completed', 'failed', 'cancelled', 'not_found']),
})
const documentSchema = z.object({
  id: z.string(),
  bank_id: z.string(),
  original_text: z.string().nullable(),
  document_metadata: z.record(z.string(), z.unknown()).nullable().optional(),
})
const recallSchema = z.object({
  results: z.array(
    z.object({
      id: z.string().min(1),
      text: z.string(),
      type: z.string().nullable().optional(),
      document_id: z.string().nullable().optional(),
      chunk_id: z.string().nullable().optional(),
      metadata: z.record(z.string(), z.string()).nullable().optional(),
      source_fact_ids: z.array(z.string()).nullable().optional(),
      scores: z
        .object({ final: z.number().nullable().optional() })
        .passthrough()
        .nullable()
        .optional(),
    }),
  ),
  source_facts: z.record(z.string(), z.unknown()).nullable().optional(),
  source_facts_truncated: z.boolean().nullable().optional(),
})

/** Dedicated bank identity includes the entire logical scope, including the existing branch partition. */
export function hindsightMemoryBankId(input: {
  backendRef: string
  branchId: string
  scope: AgentMemoryScope
}): string {
  if (!input.backendRef.trim() || !input.branchId.trim())
    throw new Error('Hindsight requires backendRef and branchId')
  if (!input.scope.namespace?.trim()) {
    throw new Error('Hindsight memory requires an explicit stable play scope.namespace')
  }
  if (input.scope.tags?.memoryBranchId !== input.branchId) {
    throw new Error('Hindsight memory scope must belong to its bound AgentMemoryBranch')
  }
  return `ak-${sha256(canonicalMemoryJson(input))}`
}

/** Hindsight 0.10.2 adapter. Snapshots remain accepted-input journals, never provider database snapshots. */
export function createHindsightMemoryAdapter(
  options: HindsightMemoryAdapterOptions,
): AgentMemoryAdapter {
  if (!options.backendRef?.trim() || !options.branchId?.trim())
    throw new Error('Hindsight requires backendRef and branchId')
  const requestTimeoutMs = bounded(options.requestTimeoutMs ?? 15_000, 300_000, 'requestTimeoutMs')
  const ingestionTimeoutMs = bounded(
    options.ingestionTimeoutMs ?? 120_000,
    600_000,
    'ingestionTimeoutMs',
  )
  const pollIntervalMs = bounded(options.pollIntervalMs ?? 1_000, 30_000, 'pollIntervalMs')
  const maxTextChars = bounded(options.maxTextChars ?? 8_000, 100_000, 'maxTextChars')
  const maxTokens = bounded(options.recallMaxTokens ?? 1_000, 16_000, 'recallMaxTokens')
  const id = `hindsight-0.10.2:${sha256(options.backendRef)}`
  const unresolved = new Map<string, HindsightOperationUnknownError>()
  let version: Promise<void> | undefined

  async function request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs = requestTimeoutMs,
  ) {
    const abortController = new AbortController()
    const response = await runBoundedMemoryLifecycle({
      operation: `Hindsight ${method} ${path}`,
      timeoutMs,
      resource: options.client,
      abortController,
      run: () =>
        options.client.request({
          method,
          path,
          ...(body === undefined ? {} : { body }),
          signal: abortController.signal,
        }),
    })
    if (response.status !== 404 && (response.status < 200 || response.status >= 300)) {
      throw new Error(`Hindsight ${method} failed with HTTP ${response.status}`)
    }
    return response
  }
  async function checkVersion() {
    version ??= (async () => {
      const response = await request('GET', '/version')
      const parsed = z.object({ api_version: z.literal('0.10.2') }).safeParse(response.body)
      if (response.status !== 200 || !parsed.success)
        throw new Error('Hindsight adapter requires the qualified 0.10.2 API')
    })()
    await version
  }
  function bank(scope: AgentMemoryScope | undefined) {
    return hindsightMemoryBankId({
      backendRef: options.backendRef,
      branchId: options.branchId,
      scope: scope ?? {},
    })
  }
  function path(bankId: string, suffix: string) {
    return `/v1/default/banks/${encodeURIComponent(bankId)}${suffix}`
  }
  async function readDocument(bankId: string, documentId: string) {
    const response = await request(
      'GET',
      path(bankId, `/documents/${encodeURIComponent(documentId)}`),
    )
    return response.status === 404 ? null : documentSchema.parse(response.body)
  }
  async function readOperation(bankId: string, operationId: string, timeoutMs = requestTimeoutMs) {
    const response = await request(
      'GET',
      path(bankId, `/operations/${operationId}`),
      undefined,
      timeoutMs,
    )
    if (response.status === 404) return { operation_id: operationId, status: 'not_found' as const }
    const operation = operationSchema.parse(response.body)
    if (operation.operation_id !== operationId)
      throw new Error('Hindsight returned another operation identity')
    return operation
  }

  const adapter: AgentMemoryAdapter = {
    id,
    // Late writes remain confined to this exact branch's dedicated banks. This is not a cancellation guarantee.
    branchIsolation: { mode: 'instance', branchId: options.branchId, supportsLogicalScopes: true },
    async search(query, searchOptions = {}) {
      const bankId = bank(searchOptions.scope)
      if (!query.trim()) throw new Error('Hindsight recall requires a nonempty query')
      const limit = searchOptions.limit ?? 10
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100)
        throw new Error('Hindsight recall limit must be between 0 and 100')
      if (searchOptions.minScore !== undefined && !Number.isFinite(searchOptions.minScore))
        throw new Error('Hindsight minScore must be finite')
      if (limit === 0) return []
      await checkVersion()
      const response = await request('POST', path(bankId, '/memories/recall'), {
        query,
        budget: 'low',
        max_tokens: maxTokens,
        include: { entities: null, source_facts: { max_tokens: maxTokens } },
      })
      if (response.status === 404) return []
      const result = recallSchema.parse(response.body)
      const hits: AgentMemoryHit[] = result.results.map((hit) => ({
        id: hit.id,
        uri: `hindsight://${bankId}/memories/${encodeURIComponent(hit.id)}`,
        kind: hit.type === 'world' ? 'fact' : 'observation',
        text: hit.text,
        ...(hit.scores?.final == null ? {} : { score: hit.scores.final }),
        metadata: {
          provider: 'hindsight',
          backendRef: options.backendRef,
          bankId,
          branchId: options.branchId,
          providerFactType: hit.type ?? null,
          documentId: hit.document_id ?? null,
          chunkId: hit.chunk_id ?? null,
          provenance: hit.metadata ?? null,
          sourceFactIds: hit.source_fact_ids ?? [],
          sourceFacts: Object.fromEntries(
            (hit.source_fact_ids ?? []).flatMap((key) =>
              result.source_facts?.[key] === undefined ? [] : [[key, result.source_facts[key]]],
            ),
          ),
          sourceFactsTruncated: result.source_facts_truncated ?? null,
          evidenceStatus: 'provider-derived; source attribution is not independent validation',
        },
      }))
      return hits
        .filter(
          (hit) =>
            (!searchOptions.kinds?.length || searchOptions.kinds.includes(hit.kind)) &&
            (searchOptions.minScore === undefined ||
              (hit.score !== undefined && hit.score >= searchOptions.minScore)),
        )
        .slice(0, limit)
    },
    async getContext(query, searchOptions) {
      return defaultGetMemoryContext(adapter, query, searchOptions)
    },
    async write(raw) {
      const input = AgentMemoryWriteInputSchema.parse(raw)
      if (!input.id?.trim()) throw new Error('Hindsight writes require a stable caller id')
      if (input.text.length > maxTextChars)
        throw new Error(`Hindsight write exceeds ${maxTextChars} characters`)
      const bankId = bank(input.scope)
      const documentId = `ak-${sha256(input.id)}`
      const operationId = operationUuid(`${bankId}:${documentId}`)
      const identity = `${bankId}:${operationId}`
      const { scope, ...sourceInput } = input
      const inputDigest = sha256(canonicalMemoryJson(sourceInput))
      const expectedMetadata = {
        ak_input_sha256: inputDigest,
        ak_scope_sha256: sha256(canonicalMemoryJson(scope)),
        ak_source: canonicalMemoryJson(sourceInput),
      }
      const verifyDocument = (document: z.infer<typeof documentSchema> | null) => {
        if (
          !document ||
          document.id !== documentId ||
          document.bank_id !== bankId ||
          document.original_text !== input.text ||
          document.document_metadata?.ak_input_sha256 !== inputDigest ||
          document.document_metadata?.ak_scope_sha256 !== expectedMetadata.ak_scope_sha256
        ) {
          throw new Error('Hindsight document identity or bytes differ from this stable write id')
        }
      }
      await checkVersion()
      const prior = await readDocument(bankId, documentId)
      if (prior) verifyDocument(prior)
      let operation = await readOperation(bankId, operationId)
      // A retained source can outlive Hindsight's completed-operation retention window.
      if (prior && operation.status === 'not_found') {
        const unknown = new HindsightOperationUnknownError(bankId, operationId, documentId)
        unresolved.set(identity, unknown)
        throw unknown
      }
      const unknown = new HindsightOperationUnknownError(bankId, operationId, documentId)
      unresolved.set(identity, unknown)
      const deadline = Date.now() + ingestionTimeoutMs
      try {
        if (operation.status === 'not_found') {
          const submitted = await request('POST', path(bankId, '/memories'), {
            async: true,
            operation_id: operationId,
            items: [
              {
                content: input.text,
                document_id: documentId,
                metadata: expectedMetadata,
                tags: ['source:agent-knowledge'],
                observation_scopes: 'shared',
                context:
                  'Retained agent input. Claims of success or correctness remain attributed claims, not verified findings.',
              },
            ],
          })
          const acknowledgement = z
            .object({
              success: z.literal(true),
              bank_id: z.literal(bankId),
              async: z.literal(true),
              operation_id: z.literal(operationId),
            })
            .parse(submitted.body)
          if (!acknowledgement.success) throw new Error('Hindsight rejected retain')
        }
        while (operation.status !== 'completed') {
          const remaining = deadline - Date.now()
          if (remaining <= 0) throw unknown
          operation = await readOperation(
            bankId,
            operationId,
            Math.min(requestTimeoutMs, remaining),
          )
          if (operation.status === 'failed' || operation.status === 'cancelled') {
            throw new Error(
              `Hindsight retain is ${operation.status}; possible partial provider state requires inspection`,
            )
          }
          if (operation.status !== 'completed')
            await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())))
        }
        verifyDocument(await readDocument(bankId, documentId))
        unresolved.delete(identity)
        return accepted('completed')
      } catch (cause) {
        throw new HindsightOperationUnknownError(bankId, operationId, documentId, { cause })
      }
      function accepted(operationStatus: string) {
        unresolved.delete(identity)
        const result = {
          accepted: true,
          id: input.id!,
          uri: `hindsight://${bankId}/documents/${documentId}`,
          kind: input.kind,
          metadata: {
            provider: 'hindsight',
            bankId,
            branchId: options.branchId,
            operationId,
            documentId,
            inputDigest,
            operationStatus,
            cost: 'unmeasured',
          },
        }
        return {
          ...result,
          sourceRecord: memoryWriteResultToSourceRecord(result, input.text, { scope }),
        }
      }
    },
    async flush() {
      if (unresolved.size) throw unresolved.values().next().value
    },
  }
  return adapter
}

function operationUuid(value: string): string {
  const hex = sha256(value)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function bounded(value: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error(`Hindsight ${name} must be an integer between 1 and ${max}`)
  return value
}
