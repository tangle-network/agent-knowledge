import { randomUUID } from 'node:crypto'
import { canonicalJson } from '@tangle-network/agent-eval'
import { sha256, stableId } from '../ids'
import { defaultGetMemoryContext } from './adapter'
import { mergeRankedMemoryHits } from './rank'
import { memoryWriteResultToSourceRecord } from './source-record'
import type { AgentMemoryAdapter, AgentMemoryHit, AgentMemoryScope } from './types'

export interface GraphitiMcpClientLike {
  callTool(request: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>
}

export interface GraphitiMemoryAdapterOptions {
  client: GraphitiMcpClientLike
  id?: string
  defaultScope?: AgentMemoryScope
  consistency?: 'queued' | 'visible'
  ingestionTimeoutMs?: number
  pollIntervalMs?: number
  /** Maximum episodes inspected to prove a queued write became visible. */
  episodeScanLimit?: number
  provenanceEpisodeLimit?: number
  search?: readonly ('facts' | 'nodes')[]
  toolNames?: Partial<GraphitiToolNames>
}

export interface GraphitiToolNames {
  addMemory: string
  searchFacts: string
  searchNodes: string
  getEpisodes: string
  clearGraph: string
}

interface GraphitiEpisode {
  uuid: string
  name?: string
  content?: string
  source_description?: string
  group_id?: string
}

const DEFAULT_GRAPHITI_INGESTION_TIMEOUT_MS = 120_000

/** Connects the official Graphiti MCP server without coupling to its Python internals. */
export function createGraphitiMemoryAdapter(
  options: GraphitiMemoryAdapterOptions,
): AgentMemoryAdapter {
  assertGraphitiOptions(options)
  const id = options.id ?? 'graphiti'
  const consistency = options.consistency ?? 'visible'
  const tools = graphitiToolNames(options)
  const queued = new Map<string, { groupId: string; name: string }>()

  const adapter: AgentMemoryAdapter = {
    id,
    branchIsolation:
      consistency === 'visible'
        ? {
            mode: 'scoped',
            processExitSafe: false,
            recoveryDelayMs: options.ingestionTimeoutMs ?? DEFAULT_GRAPHITI_INGESTION_TIMEOUT_MS,
          }
        : {
            mode: 'unsupported',
            reason:
              'queued Graphiti writes can become visible after a process restart; use consistency="visible" for branch experiments',
          },
    async search(query, searchOptions = {}) {
      if (searchOptions.minScore !== undefined && !Number.isFinite(searchOptions.minScore)) {
        throw new Error(`${id}: minScore must be finite`)
      }
      const scope = mergeScopes(options.defaultScope, searchOptions.scope)
      const groupId = graphitiGroupId(id, scope)
      const modes = new Set(options.search ?? ['facts', 'nodes'])
      const kinds =
        searchOptions.kinds && searchOptions.kinds.length > 0 ? new Set(searchOptions.kinds) : null
      const searchFacts = modes.has('facts') && (!kinds || kinds.has('fact'))
      const searchNodes = modes.has('nodes') && (!kinds || kinds.has('entity'))
      const limit = searchOptions.limit ?? 10
      if (!Number.isSafeInteger(limit) || limit < 0) {
        throw new Error(`${id}: search limit must be a non-negative safe integer`)
      }
      if (limit === 0) return []
      const [factPayload, nodePayload] = await Promise.all([
        searchFacts
          ? callGraphiti(options.client, tools.searchFacts, {
              query,
              group_ids: [groupId],
              max_facts: limit,
            })
          : undefined,
        searchNodes
          ? callGraphiti(options.client, tools.searchNodes, {
              query,
              group_ids: [groupId],
              max_nodes: limit,
              ...(searchOptions.metadata?.entityTypes
                ? { entity_types: searchOptions.metadata.entityTypes }
                : {}),
            })
          : undefined,
      ])
      const hits = mergeRankedMemoryHits(
        [normalizeGraphitiFacts(factPayload, id), normalizeGraphitiNodes(nodePayload, id)].map(
          (group) =>
            group.filter((hit) => {
              if (searchOptions.minScore === undefined) return true
              const score = hit.normalizedScore ?? hit.score
              return score !== undefined && score >= searchOptions.minScore
            }),
        ),
        limit,
      )
      await enrichGraphitiProvenance(options, groupId, hits)
      return hits
    },
    async getContext(query, searchOptions = {}) {
      return defaultGetMemoryContext(adapter, query, searchOptions)
    },
    async write(input) {
      const scope = mergeScopes(options.defaultScope, input.scope)
      const groupId = graphitiGroupId(id, scope)
      const eventKey = canonicalJson(
        stripUndefined({
          id: input.id,
          kind: input.kind,
          text: input.text,
          title: input.title,
          role: input.role,
          metadata: input.metadata,
        }),
      )
      const episodeUuid =
        input.id === undefined ? randomUUID() : deterministicUuid(`${id}:${groupId}:${eventKey}`)
      const name = input.title ?? `${input.kind}:${input.id ?? stableId('event', eventKey)}`
      const sourceDescription = canonicalJson(
        stripUndefined({
          adapter: 'agent-knowledge',
          memoryKind: input.kind,
          eventId: input.id,
          actorId: input.metadata?.actorId,
          sessionId: scope.sessionId,
          role: input.role,
          scope,
          metadata: input.metadata ?? {},
        }),
      )
      await callGraphiti(options.client, tools.addMemory, {
        name,
        episode_body: input.text,
        group_id: groupId,
        source: input.kind === 'message' ? 'message' : 'text',
        source_description: sourceDescription,
        uuid: episodeUuid,
        ...(typeof input.metadata?.timestamp === 'string'
          ? { reference_time: input.metadata.timestamp }
          : {}),
      })
      queued.set(episodeUuid, { groupId, name })
      if (consistency === 'visible') {
        await waitForGraphitiEpisode(options, groupId, episodeUuid)
        queued.delete(episodeUuid)
      }
      const result = {
        accepted: true,
        id: episodeUuid,
        uri: `memory://${id}/${episodeUuid}`,
        kind: input.kind,
        metadata: {
          provider: 'graphiti',
          groupId,
          consistency,
          queued: consistency === 'queued',
        },
      } as const
      return {
        ...result,
        sourceRecord: memoryWriteResultToSourceRecord(result, input.text, { scope }),
      }
    },
    async clear(scope) {
      const groupId = graphitiGroupId(id, mergeScopes(options.defaultScope, scope))
      for (const [episodeUuid, pending] of queued) {
        if (pending.groupId !== groupId) continue
        await waitForGraphitiEpisode(options, groupId, episodeUuid)
        queued.delete(episodeUuid)
      }
      await callGraphiti(options.client, tools.clearGraph, { group_ids: [groupId] })
    },
    async flush() {
      for (const [episodeUuid, pending] of queued) {
        await waitForGraphitiEpisode(options, pending.groupId, episodeUuid)
        queued.delete(episodeUuid)
      }
    },
  }
  return adapter
}

async function callGraphiti(
  client: GraphitiMcpClientLike,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const raw = await client.callTool({ name, arguments: args })
  const payload = graphitiPayload(raw)
  if (isRecord(payload) && typeof payload.error === 'string') {
    throw new Error(`Graphiti ${name}: ${payload.error}`)
  }
  return payload
}

function graphitiPayload(raw: unknown): unknown {
  if (!isRecord(raw)) return raw
  if (raw.isError === true) throw new Error(`Graphiti MCP: ${toolText(raw) || 'tool call failed'}`)
  if (isRecord(raw.structuredContent)) return unwrapResult(raw.structuredContent)
  const text = toolText(raw)
  if (text) {
    try {
      return unwrapResult(JSON.parse(text))
    } catch {
      return { message: text }
    }
  }
  return unwrapResult(raw)
}

function unwrapResult(value: unknown): unknown {
  if (isRecord(value) && Object.keys(value).length === 1 && 'result' in value) {
    return value.result
  }
  return value
}

function toolText(raw: Record<string, unknown>): string {
  if (!Array.isArray(raw.content)) return ''
  return raw.content
    .filter(isRecord)
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

function normalizeGraphitiFacts(raw: unknown, adapterId: string): AgentMemoryHit[] {
  const facts = isRecord(raw) && Array.isArray(raw.facts) ? raw.facts.filter(isRecord) : []
  return facts.flatMap((fact) => {
    const text = stringField(fact, ['fact', 'text'])
    if (!text) return []
    const factId =
      stringField(fact, ['uuid', 'id']) ??
      stableId('fact', canonicalJson(stripUndefined({ adapterId, text, fact })))
    const episodeUuids = stringArray(fact.episodes ?? fact.episode_uuids)
    const score = numberField(fact, ['score', 'relevance_score'])
    const normalizedScore = normalizedScoreOf(score)
    return [
      {
        id: factId,
        uri: `memory://${adapterId}/fact/${factId}`,
        kind: 'fact' as const,
        text,
        ...(stringField(fact, ['name']) ? { title: stringField(fact, ['name']) } : {}),
        ...(stringField(fact, ['created_at'])
          ? { createdAt: stringField(fact, ['created_at']) }
          : {}),
        ...(stringField(fact, ['invalid_at'])
          ? { validUntil: stringField(fact, ['invalid_at']) }
          : stringField(fact, ['expired_at'])
            ? { validUntil: stringField(fact, ['expired_at']) }
            : {}),
        ...(score !== undefined ? { score } : {}),
        ...(normalizedScore !== undefined ? { normalizedScore } : {}),
        metadata: {
          provider: 'graphiti',
          groupId: fact.group_id,
          sourceNodeUuid: fact.source_node_uuid,
          targetNodeUuid: fact.target_node_uuid,
          validAt: fact.valid_at,
          invalidAt: fact.invalid_at,
          episodeUuids,
          attributes: fact.attributes,
        },
      },
    ]
  })
}

function normalizeGraphitiNodes(raw: unknown, adapterId: string): AgentMemoryHit[] {
  const nodes = isRecord(raw) && Array.isArray(raw.nodes) ? raw.nodes.filter(isRecord) : []
  return nodes.flatMap((node) => {
    const name = stringField(node, ['name'])
    const summary = stringField(node, ['summary'])
    const text = summary ?? name
    if (!text) return []
    const nodeId =
      stringField(node, ['uuid', 'id']) ??
      stableId('node', canonicalJson(stripUndefined({ adapterId, text, node })))
    const score = numberField(node, ['score', 'relevance_score'])
    const normalizedScore = normalizedScoreOf(score)
    return [
      {
        id: nodeId,
        uri: `memory://${adapterId}/entity/${nodeId}`,
        kind: 'entity' as const,
        text,
        ...(name ? { title: name } : {}),
        ...(stringField(node, ['created_at'])
          ? { createdAt: stringField(node, ['created_at']) }
          : {}),
        ...(score !== undefined ? { score } : {}),
        ...(normalizedScore !== undefined ? { normalizedScore } : {}),
        metadata: {
          provider: 'graphiti',
          groupId: node.group_id,
          labels: node.labels,
          attributes: node.attributes,
        },
      },
    ]
  })
}

async function enrichGraphitiProvenance(
  options: GraphitiMemoryAdapterOptions,
  groupId: string,
  hits: AgentMemoryHit[],
): Promise<void> {
  const wanted = new Set(hits.flatMap((hit) => stringArray(hit.metadata?.episodeUuids)))
  if (wanted.size === 0) return
  const scan = await scanGraphitiEpisodes(
    options,
    groupId,
    wanted,
    options.provenanceEpisodeLimit ?? options.episodeScanLimit ?? 10_000,
  )
  const episodes = scan.episodes
  const byId = new Map(episodes.map((episode) => [episode.uuid, episode]))
  for (const hit of hits) {
    const episodeUuids = stringArray(hit.metadata?.episodeUuids)
    const sourceEpisodes = episodeUuids
      .map((uuid) => byId.get(uuid))
      .filter((episode): episode is GraphitiEpisode => episode !== undefined)
    const provenanceIncomplete = episodeUuids.some((uuid) => !byId.has(uuid))
    if (sourceEpisodes.length === 0) {
      if (provenanceIncomplete) {
        hit.metadata = { ...hit.metadata, provenanceIncomplete: true }
      }
      continue
    }
    const descriptions = sourceEpisodes
      .map((episode) => parseDescription(episode.source_description))
      .filter(isRecord)
    const first = descriptions[0]
    hit.metadata = {
      ...hit.metadata,
      sourceEpisodes,
      ...(provenanceIncomplete || !scan.complete ? { provenanceIncomplete: true } : {}),
      ...(first ?? {}),
      eventIds: uniqueStrings(descriptions.map((value) => value.eventId)),
      actorIds: uniqueStrings(descriptions.map((value) => value.actorId)),
      ...(typeof first?.eventId === 'string' ? { eventId: first.eventId } : {}),
      ...(typeof first?.actorId === 'string' ? { actorId: first.actorId } : {}),
    }
  }
}

async function getGraphitiEpisodes(
  options: GraphitiMemoryAdapterOptions,
  groupId: string,
  limit: number,
): Promise<GraphitiEpisode[]> {
  const raw = await callGraphiti(options.client, graphitiToolNames(options).getEpisodes, {
    group_ids: [groupId],
    max_episodes: limit,
  })
  if (!isRecord(raw) || !Array.isArray(raw.episodes)) return []
  return raw.episodes.filter(isRecord).flatMap((episode) => {
    const uuid = stringField(episode, ['uuid', 'id'])
    return uuid ? [{ ...episode, uuid } as GraphitiEpisode] : []
  })
}

async function scanGraphitiEpisodes(
  options: GraphitiMemoryAdapterOptions,
  groupId: string,
  wanted: ReadonlySet<string>,
  maximum: number,
): Promise<{ episodes: GraphitiEpisode[]; complete: boolean }> {
  let limit = Math.min(100, maximum)
  for (;;) {
    const episodes = await getGraphitiEpisodes(options, groupId, limit)
    const foundAll = [...wanted].every((uuid) => episodes.some((episode) => episode.uuid === uuid))
    if (foundAll || episodes.length < limit) return { episodes, complete: foundAll }
    if (limit === maximum) return { episodes, complete: false }
    limit = Math.min(maximum, limit * 2)
  }
}

async function waitForGraphitiEpisode(
  options: GraphitiMemoryAdapterOptions,
  groupId: string,
  episodeUuid: string,
): Promise<void> {
  const timeoutMs = options.ingestionTimeoutMs ?? DEFAULT_GRAPHITI_INGESTION_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? 500
  const maximum = options.episodeScanLimit ?? 10_000
  const deadline = Date.now() + timeoutMs
  let scanLimitReached = false
  for (;;) {
    const scan = await scanGraphitiEpisodes(options, groupId, new Set([episodeUuid]), maximum)
    if (scan.complete) return
    scanLimitReached ||= scan.episodes.length >= maximum
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)))
  }
  if (scanLimitReached) {
    throw new Error(
      `Graphiti episode ${episodeUuid} is outside episodeScanLimit=${maximum}; raise the limit or use a smaller group`,
    )
  }
  throw new Error(`Graphiti episode ${episodeUuid} was not visible after ${timeoutMs}ms`)
}

function graphitiGroupId(adapterId: string, scope: AgentMemoryScope): string {
  return `ak_${sha256(
    canonicalJson(
      stripUndefined({
        adapterId,
        tenantId: scope.tenantId,
        userId: scope.userId,
        agentId: scope.agentId,
        teamId: scope.teamId,
        runId: scope.runId,
        sessionId: scope.sessionId,
        namespace: scope.namespace,
        tags: scope.tags,
      }),
    ),
  ).slice(0, 32)}`
}

function graphitiToolNames(options: GraphitiMemoryAdapterOptions): GraphitiToolNames {
  return {
    addMemory: options.toolNames?.addMemory ?? 'add_memory',
    searchFacts: options.toolNames?.searchFacts ?? 'search_memory_facts',
    searchNodes: options.toolNames?.searchNodes ?? 'search_nodes',
    getEpisodes: options.toolNames?.getEpisodes ?? 'get_episodes',
    clearGraph: options.toolNames?.clearGraph ?? 'clear_graph',
  }
}

function assertGraphitiOptions(options: GraphitiMemoryAdapterOptions): void {
  if (options.id !== undefined && (typeof options.id !== 'string' || !options.id.trim())) {
    throw new Error('Graphiti id must be a non-empty string')
  }
  if (options.consistency !== undefined && !['queued', 'visible'].includes(options.consistency)) {
    throw new Error('Graphiti consistency must be queued or visible')
  }
  for (const [name, value] of [
    ['ingestionTimeoutMs', options.ingestionTimeoutMs],
    ['pollIntervalMs', options.pollIntervalMs],
    ['episodeScanLimit', options.episodeScanLimit],
    ['provenanceEpisodeLimit', options.provenanceEpisodeLimit],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`Graphiti ${name} must be a positive safe integer`)
    }
  }
  for (const [name, value] of Object.entries(options.toolNames ?? {})) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`Graphiti toolNames.${name} must be a non-empty string`)
    }
  }
}

function deterministicUuid(value: string): string {
  const hex = sha256(value)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function parseDescription(value: string | undefined): unknown {
  if (!value) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function mergeScopes(base?: AgentMemoryScope, extra?: AgentMemoryScope): AgentMemoryScope {
  return {
    ...(base ?? {}),
    ...(extra ?? {}),
    tags: { ...(base?.tags ?? {}), ...(extra?.tags ?? {}) },
  }
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string'))]
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function stringField(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const field = value[key]
    if (typeof field === 'string' && field.length > 0) return field
  }
  return undefined
}

function numberField(value: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const field = value[key]
    if (typeof field === 'number' && Number.isFinite(field)) return field
  }
  return undefined
}

function normalizedScoreOf(score: number | undefined): number | undefined {
  return score !== undefined && score >= 0 && score <= 1 ? score : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, stripUndefined(child)]),
  )
}

export function graphitiMemoryAdapterIdentity(
  options: Pick<
    GraphitiMemoryAdapterOptions,
    | 'id'
    | 'consistency'
    | 'ingestionTimeoutMs'
    | 'pollIntervalMs'
    | 'episodeScanLimit'
    | 'provenanceEpisodeLimit'
    | 'search'
    | 'toolNames'
    | 'defaultScope'
  >,
): string {
  return stableId('graphiti', canonicalJson(stripUndefined(options)))
}
