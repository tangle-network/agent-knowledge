import { canonicalCandidateJson } from '@tangle-network/agent-interface'
import type {
  KnowledgeId,
  KnowledgeRelation,
  KnowledgeRelationGraph,
  KnowledgeRelationNode,
} from './types'

export type KnowledgeRelationGraphErrorCode =
  | 'invalid-node'
  | 'duplicate-node'
  | 'invalid-relation'
  | 'duplicate-relation'
  | 'undeclared-endpoint'
  | 'unknown-node'
  | 'invalid-query'

/** A relation graph input or query that cannot be honored exactly. */
export class KnowledgeRelationGraphError extends Error {
  readonly code: KnowledgeRelationGraphErrorCode

  constructor(code: KnowledgeRelationGraphErrorCode, message: string) {
    super(message)
    this.name = 'KnowledgeRelationGraphError'
    this.code = code
  }
}

export interface BuildKnowledgeRelationGraphInput {
  /**
   * Declared node inventory. When present, every relation endpoint must name
   * one declared node; an undeclared endpoint is refused rather than added.
   * When absent, the graph carries edges only and `nodes` is empty.
   */
  nodes?: readonly KnowledgeRelationNode[]
  relations: readonly KnowledgeRelation[]
}

/**
 * `out` follows `sourceId -> targetId`, `in` follows `targetId -> sourceId`,
 * `both` follows a relation from either end.
 */
export type KnowledgeRelationDirection = 'out' | 'in' | 'both'

export interface KnowledgeRelationQuery {
  /** Restrict to relations with this predicate. Every predicate when absent. */
  predicate?: string
  direction: KnowledgeRelationDirection
}

export interface KnowledgeRelationWalkOptions extends KnowledgeRelationQuery {
  /** Most relations between the start node and a reported node. Unbounded when absent. */
  maxDepth?: number
}

export interface KnowledgeRelationNeighbor {
  nodeId: KnowledgeId
  relation: KnowledgeRelation
}

export interface KnowledgeRelationWalkStep {
  nodeId: KnowledgeId
  /** Number of relations between the start node and this node. */
  depth: number
  /** The node the search came from when it first reached this node. */
  from: KnowledgeId
  relation: KnowledgeRelation
}

/**
 * Build a labeled multi-edge graph from caller relations.
 *
 * The graph keeps one edge per `(sourceId, targetId, predicate)`, in first-seen
 * order. A repeated triple is accepted only when its weight and metadata are
 * identical in canonical JSON; any other repeat is a conflict and is refused.
 * Node and relation metadata must be finite, acyclic JSON so the graph
 * round-trips through `KnowledgeRelationGraphSchema` unchanged.
 */
export function buildKnowledgeRelationGraph(
  input: BuildKnowledgeRelationGraphInput,
): KnowledgeRelationGraph {
  const declared =
    input.nodes === undefined ? undefined : new Map<KnowledgeId, KnowledgeRelationNode>()
  const nodes: KnowledgeRelationNode[] = []
  if (declared !== undefined) {
    for (const [position, node] of input.nodes!.entries()) {
      const normalized = normalizeNode(node, position)
      if (declared.has(normalized.id)) {
        throw new KnowledgeRelationGraphError(
          'duplicate-node',
          `node "${normalized.id}" is declared more than once`,
        )
      }
      declared.set(normalized.id, normalized)
      nodes.push(normalized)
    }
  }

  const edges: KnowledgeRelation[] = []
  const canonicalByTriple = new Map<string, string>()
  for (const [position, relation] of input.relations.entries()) {
    const normalized = normalizeRelation(relation, position)
    if (declared !== undefined) {
      for (const endpoint of [normalized.sourceId, normalized.targetId]) {
        if (!declared.has(endpoint)) {
          throw new KnowledgeRelationGraphError(
            'undeclared-endpoint',
            `relation ${describeTriple(normalized)} names undeclared node "${endpoint}"`,
          )
        }
      }
    }
    const canonical = canonicalRelationJson(normalized)
    const key = tripleKey(normalized)
    const prior = canonicalByTriple.get(key)
    if (prior !== undefined) {
      if (prior === canonical) continue
      throw new KnowledgeRelationGraphError(
        'duplicate-relation',
        `relation ${describeTriple(normalized)} is repeated with different weight or metadata`,
      )
    }
    canonicalByTriple.set(key, canonical)
    edges.push(normalized)
  }
  return { nodes, edges }
}

/** Relations touching `id`, each with the node at the other end, in graph order. */
export function neighbors(
  graph: KnowledgeRelationGraph,
  id: KnowledgeId,
  query: KnowledgeRelationQuery,
): KnowledgeRelationNeighbor[] {
  const index = indexOf(graph)
  validateQuery(query)
  assertKnownNode(index, id)
  return neighborsOf(index, id, query)
}

/**
 * Breadth-first traversal from `id` over matching relations. Each reachable
 * node is reported once, at the depth where the search first reached it; the
 * start node is never reported, so a cycle back to it adds no step.
 */
export function walk(
  graph: KnowledgeRelationGraph,
  id: KnowledgeId,
  options: KnowledgeRelationWalkOptions,
): KnowledgeRelationWalkStep[] {
  const index = indexOf(graph)
  validateQuery(options)
  validateMaxDepth(options.maxDepth)
  assertKnownNode(index, id)
  const steps: KnowledgeRelationWalkStep[] = []
  for (const step of traverse(index, id, options, options.maxDepth)) steps.push(step)
  return steps
}

/**
 * Whether `to` is `from` or lies on a path of matching relations out of `from`.
 */
export function isReachable(
  graph: KnowledgeRelationGraph,
  from: KnowledgeId,
  to: KnowledgeId,
  query: KnowledgeRelationQuery,
): boolean {
  const index = indexOf(graph)
  validateQuery(query)
  assertKnownNode(index, from)
  assertKnownNode(index, to)
  if (from === to) return true
  for (const step of traverse(index, from, query, undefined)) {
    if (step.nodeId === to) return true
  }
  return false
}

interface RelationIndex {
  readonly outgoing: ReadonlyMap<KnowledgeId, readonly KnowledgeRelation[]>
  readonly incoming: ReadonlyMap<KnowledgeId, readonly KnowledgeRelation[]>
  readonly known: ReadonlySet<KnowledgeId>
}

// The query index is derived once per graph object. A graph is a value: build
// a new one instead of mutating `nodes` or `edges` after the first query.
const indexes = new WeakMap<KnowledgeRelationGraph, RelationIndex>()

function indexOf(graph: KnowledgeRelationGraph): RelationIndex {
  const cached = indexes.get(graph)
  if (cached !== undefined) return cached
  const outgoing = new Map<KnowledgeId, KnowledgeRelation[]>()
  const incoming = new Map<KnowledgeId, KnowledgeRelation[]>()
  const known = new Set<KnowledgeId>()
  for (const node of graph.nodes) known.add(node.id)
  for (const relation of graph.edges) {
    known.add(relation.sourceId)
    known.add(relation.targetId)
    push(outgoing, relation.sourceId, relation)
    push(incoming, relation.targetId, relation)
  }
  const index: RelationIndex = { outgoing, incoming, known }
  indexes.set(graph, index)
  return index
}

function push(
  map: Map<KnowledgeId, KnowledgeRelation[]>,
  key: KnowledgeId,
  relation: KnowledgeRelation,
): void {
  const list = map.get(key)
  if (list === undefined) map.set(key, [relation])
  else list.push(relation)
}

function neighborsOf(
  index: RelationIndex,
  id: KnowledgeId,
  query: KnowledgeRelationQuery,
): KnowledgeRelationNeighbor[] {
  const matches = (relation: KnowledgeRelation): boolean =>
    query.predicate === undefined || relation.predicate === query.predicate
  const result: KnowledgeRelationNeighbor[] = []
  if (query.direction !== 'in') {
    for (const relation of index.outgoing.get(id) ?? []) {
      if (matches(relation)) result.push({ nodeId: relation.targetId, relation })
    }
  }
  if (query.direction !== 'out') {
    for (const relation of index.incoming.get(id) ?? []) {
      // A self-loop already appears in the outgoing pass when both ends are followed.
      if (query.direction === 'both' && relation.sourceId === id) continue
      if (matches(relation)) result.push({ nodeId: relation.sourceId, relation })
    }
  }
  return result
}

function* traverse(
  index: RelationIndex,
  start: KnowledgeId,
  query: KnowledgeRelationQuery,
  maxDepth: number | undefined,
): Generator<KnowledgeRelationWalkStep> {
  const visited = new Set<KnowledgeId>([start])
  const queue: Array<{ nodeId: KnowledgeId; depth: number }> = [{ nodeId: start, depth: 0 }]
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!
    if (maxDepth !== undefined && current.depth >= maxDepth) continue
    for (const neighbor of neighborsOf(index, current.nodeId, query)) {
      if (visited.has(neighbor.nodeId)) continue
      visited.add(neighbor.nodeId)
      const depth = current.depth + 1
      yield { nodeId: neighbor.nodeId, depth, from: current.nodeId, relation: neighbor.relation }
      queue.push({ nodeId: neighbor.nodeId, depth })
    }
  }
}

function assertKnownNode(index: RelationIndex, id: KnowledgeId): void {
  if (!index.known.has(id)) {
    throw new KnowledgeRelationGraphError('unknown-node', `node "${id}" is not in the graph`)
  }
}

function validateQuery(query: KnowledgeRelationQuery): void {
  if (query.direction !== 'out' && query.direction !== 'in' && query.direction !== 'both') {
    throw new KnowledgeRelationGraphError(
      'invalid-query',
      `direction must be "out", "in", or "both", got ${JSON.stringify(query.direction)}`,
    )
  }
  if (query.predicate !== undefined && !isNonEmptyString(query.predicate)) {
    throw new KnowledgeRelationGraphError('invalid-query', 'predicate must be a non-empty string')
  }
}

function validateMaxDepth(maxDepth: number | undefined): void {
  if (maxDepth === undefined) return
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new KnowledgeRelationGraphError(
      'invalid-query',
      `maxDepth must be a non-negative integer, got ${JSON.stringify(maxDepth)}`,
    )
  }
}

function normalizeNode(node: KnowledgeRelationNode, position: number): KnowledgeRelationNode {
  if (!isNonEmptyString(node.id)) {
    throw new KnowledgeRelationGraphError('invalid-node', `node at ${position} has no id`)
  }
  if (!isNonEmptyString(node.kind)) {
    throw new KnowledgeRelationGraphError('invalid-node', `node "${node.id}" has no kind`)
  }
  if (node.label !== undefined && typeof node.label !== 'string') {
    throw new KnowledgeRelationGraphError('invalid-node', `node "${node.id}" label is not a string`)
  }
  if (node.metadata !== undefined)
    assertCanonicalMetadata(node.metadata, `node "${node.id}"`, 'invalid-node')
  return {
    id: node.id,
    kind: node.kind,
    ...(node.label !== undefined ? { label: node.label } : {}),
    ...(node.metadata !== undefined ? { metadata: node.metadata } : {}),
  }
}

function normalizeRelation(relation: KnowledgeRelation, position: number): KnowledgeRelation {
  for (const field of ['sourceId', 'targetId', 'predicate'] as const) {
    if (!isNonEmptyString(relation[field])) {
      throw new KnowledgeRelationGraphError(
        'invalid-relation',
        `relation at ${position} has no ${field}`,
      )
    }
  }
  if (relation.weight !== undefined && !Number.isFinite(relation.weight)) {
    throw new KnowledgeRelationGraphError(
      'invalid-relation',
      `relation ${describeTriple(relation)} weight must be a finite number`,
    )
  }
  return {
    sourceId: relation.sourceId,
    targetId: relation.targetId,
    predicate: relation.predicate,
    ...(relation.weight !== undefined ? { weight: relation.weight } : {}),
    ...(relation.metadata !== undefined ? { metadata: relation.metadata } : {}),
  }
}

function canonicalRelationJson(relation: KnowledgeRelation): string {
  if (relation.metadata !== undefined) {
    assertCanonicalMetadata(
      relation.metadata,
      `relation ${describeTriple(relation)}`,
      'invalid-relation',
    )
  }
  return canonicalCandidateJson({
    ...(relation.weight !== undefined ? { weight: relation.weight } : {}),
    ...(relation.metadata !== undefined ? { metadata: relation.metadata } : {}),
  })
}

function assertCanonicalMetadata(
  metadata: Record<string, unknown>,
  subject: string,
  code: 'invalid-node' | 'invalid-relation',
): void {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new KnowledgeRelationGraphError(code, `${subject} metadata must be an object`)
  }
  try {
    canonicalCandidateJson(metadata)
  } catch (error) {
    throw new KnowledgeRelationGraphError(
      code,
      `${subject} metadata must be finite, acyclic JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function tripleKey(relation: KnowledgeRelation): string {
  return JSON.stringify([relation.sourceId, relation.targetId, relation.predicate])
}

function describeTriple(relation: KnowledgeRelation): string {
  return `${relation.sourceId} -[${relation.predicate}]-> ${relation.targetId}`
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
