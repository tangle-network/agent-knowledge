import { describe, expect, it } from 'vitest'
import {
  buildKnowledgeRelationGraph,
  isReachable,
  KnowledgeRelationGraphError,
  neighbors,
  walk,
} from './relation-graph'
import { KnowledgeRelationGraphSchema } from './schemas'
import type { KnowledgeRelation, KnowledgeRelationNode } from './types'

const nodes: KnowledgeRelationNode[] = [
  { id: 'run-1', kind: 'run', label: 'Run 1' },
  { id: 'run-2', kind: 'run', label: 'Run 2', metadata: { seed: 7, tags: ['baseline'] } },
  { id: 'run-3', kind: 'run' },
  { id: 'claim-a', kind: 'claim' },
  { id: 'model-x', kind: 'model', metadata: { provider: 'local' } },
]

const relations: KnowledgeRelation[] = [
  { sourceId: 'run-2', targetId: 'run-1', predicate: 'branched-from' },
  { sourceId: 'run-2', targetId: 'run-1', predicate: 'supersedes', weight: 1 },
  { sourceId: 'run-3', targetId: 'run-2', predicate: 'branched-from' },
  { sourceId: 'run-2', targetId: 'claim-a', predicate: 'cites-evidence', metadata: { at: 3 } },
  { sourceId: 'run-1', targetId: 'model-x', predicate: 'executed-with' },
  { sourceId: 'run-3', targetId: 'model-x', predicate: 'executed-with' },
]

function expectError(run: () => unknown, code: KnowledgeRelationGraphError['code']): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(KnowledgeRelationGraphError)
    expect((error as KnowledgeRelationGraphError).code).toBe(code)
    return
  }
  throw new Error(`expected KnowledgeRelationGraphError ${code}`)
}

describe('buildKnowledgeRelationGraph', () => {
  it('keeps one edge per (source, target, predicate) in first-seen order', () => {
    const graph = buildKnowledgeRelationGraph({ nodes, relations })
    expect(graph.nodes).toEqual(nodes)
    expect(graph.edges).toEqual(relations)
    expect(
      graph.edges.filter((edge) => edge.sourceId === 'run-2' && edge.targetId === 'run-1'),
    ).toHaveLength(2)
  })

  it('accepts a repeated triple only when it is byte-identical', () => {
    const repeated: KnowledgeRelation = {
      sourceId: 'run-2',
      targetId: 'claim-a',
      predicate: 'cites-evidence',
      metadata: { at: 3 },
    }
    const graph = buildKnowledgeRelationGraph({ relations: [...relations, repeated] })
    expect(graph.edges).toEqual(relations)

    expectError(
      () =>
        buildKnowledgeRelationGraph({
          relations: [...relations, { ...repeated, metadata: { at: 4 } }],
        }),
      'duplicate-relation',
    )
    expectError(
      () =>
        buildKnowledgeRelationGraph({
          relations: [
            { sourceId: 'a', targetId: 'b', predicate: 'p', weight: 1 },
            { sourceId: 'a', targetId: 'b', predicate: 'p', weight: 2 },
          ],
        }),
      'duplicate-relation',
    )
  })

  it('refuses an endpoint outside the declared nodes instead of adding a node', () => {
    expectError(
      () =>
        buildKnowledgeRelationGraph({
          nodes,
          relations: [{ sourceId: 'run-1', targetId: 'worker-9', predicate: 'authored-by' }],
        }),
      'undeclared-endpoint',
    )
  })

  it('carries edges only when no nodes are declared', () => {
    const graph = buildKnowledgeRelationGraph({ relations })
    expect(graph.nodes).toEqual([])
    expect(neighbors(graph, 'run-1', { direction: 'in' }).map((n) => n.nodeId)).toEqual([
      'run-2',
      'run-2',
    ])
  })

  it('refuses duplicate node ids, empty ids, and non-JSON metadata', () => {
    expectError(
      () =>
        buildKnowledgeRelationGraph({
          nodes: [
            { id: 'x', kind: 'run' },
            { id: 'x', kind: 'claim' },
          ],
          relations: [],
        }),
      'duplicate-node',
    )
    expectError(
      () => buildKnowledgeRelationGraph({ nodes: [{ id: '', kind: 'run' }], relations: [] }),
      'invalid-node',
    )
    expectError(
      () => buildKnowledgeRelationGraph({ nodes: [{ id: 'x', kind: '' }], relations: [] }),
      'invalid-node',
    )
    expectError(
      () =>
        buildKnowledgeRelationGraph({
          nodes: [{ id: 'x', kind: 'run', metadata: { at: Number.NaN } }],
          relations: [],
        }),
      'invalid-node',
    )
    expectError(
      () =>
        buildKnowledgeRelationGraph({
          relations: [{ sourceId: 'a', targetId: '', predicate: 'p' }],
        }),
      'invalid-relation',
    )
    expectError(
      () =>
        buildKnowledgeRelationGraph({
          relations: [
            { sourceId: 'a', targetId: 'b', predicate: 'p', weight: Number.POSITIVE_INFINITY },
          ],
        }),
      'invalid-relation',
    )
    expectError(
      () =>
        buildKnowledgeRelationGraph({
          relations: [
            { sourceId: 'a', targetId: 'b', predicate: 'p', metadata: { note: undefined } },
          ],
        }),
      'invalid-relation',
    )
  })

  it('round-trips node and edge metadata through the schema', () => {
    const graph = buildKnowledgeRelationGraph({ nodes, relations })
    const parsed = KnowledgeRelationGraphSchema.parse(JSON.parse(JSON.stringify(graph)))
    expect(parsed).toEqual(graph)
    expect(parsed.nodes[1]?.metadata).toEqual({ seed: 7, tags: ['baseline'] })
    expect(parsed.edges[3]?.metadata).toEqual({ at: 3 })
    expect(walk(parsed, 'run-3', { direction: 'out', predicate: 'branched-from' })).toEqual(
      walk(graph, 'run-3', { direction: 'out', predicate: 'branched-from' }),
    )
  })
})

describe('relation graph queries', () => {
  const graph = buildKnowledgeRelationGraph({ nodes, relations })

  it('lists neighbors by predicate and direction', () => {
    expect(neighbors(graph, 'run-2', { direction: 'out', predicate: 'branched-from' })).toEqual([
      { nodeId: 'run-1', relation: relations[0] },
    ])
    expect(neighbors(graph, 'run-1', { direction: 'in' }).map((n) => n.relation.predicate)).toEqual(
      ['branched-from', 'supersedes'],
    )
    expect(neighbors(graph, 'run-2', { direction: 'both' }).map((n) => n.nodeId)).toEqual([
      'run-1',
      'run-1',
      'claim-a',
      'run-3',
    ])
    expect(neighbors(graph, 'claim-a', { direction: 'out' })).toEqual([])
  })

  it('walks ancestors over out edges and descendants over in edges', () => {
    expect(walk(graph, 'run-3', { direction: 'out', predicate: 'branched-from' })).toEqual([
      { nodeId: 'run-2', depth: 1, from: 'run-3', relation: relations[2] },
      { nodeId: 'run-1', depth: 2, from: 'run-2', relation: relations[0] },
    ])
    expect(
      walk(graph, 'run-1', { direction: 'in', predicate: 'branched-from' }).map((s) => [
        s.nodeId,
        s.depth,
      ]),
    ).toEqual([
      ['run-2', 1],
      ['run-3', 2],
    ])
    expect(
      walk(graph, 'run-3', { direction: 'out', predicate: 'branched-from', maxDepth: 1 }).map(
        (s) => s.nodeId,
      ),
    ).toEqual(['run-2'])
    expect(walk(graph, 'run-3', { direction: 'out', maxDepth: 0 })).toEqual([])
  })

  it('reports each node once on a cycle and terminates', () => {
    const cyclic = buildKnowledgeRelationGraph({
      relations: [
        { sourceId: 'a', targetId: 'b', predicate: 'next' },
        { sourceId: 'b', targetId: 'c', predicate: 'next' },
        { sourceId: 'c', targetId: 'a', predicate: 'next' },
        { sourceId: 'c', targetId: 'c', predicate: 'next' },
      ],
    })
    expect(walk(cyclic, 'a', { direction: 'out' }).map((s) => s.nodeId)).toEqual(['b', 'c'])
    expect(walk(cyclic, 'a', { direction: 'both' }).map((s) => s.nodeId)).toEqual(['b', 'c'])
    expect(neighbors(cyclic, 'c', { direction: 'both' }).map((n) => n.nodeId)).toEqual([
      'a',
      'c',
      'b',
    ])
    expect(isReachable(cyclic, 'a', 'a', { direction: 'out' })).toBe(true)
    expect(isReachable(cyclic, 'b', 'a', { direction: 'out' })).toBe(true)
  })

  it('answers reachability along the requested predicate and direction', () => {
    expect(
      isReachable(graph, 'run-3', 'run-1', { direction: 'out', predicate: 'branched-from' }),
    ).toBe(true)
    expect(
      isReachable(graph, 'run-1', 'run-3', { direction: 'out', predicate: 'branched-from' }),
    ).toBe(false)
    expect(
      isReachable(graph, 'run-1', 'run-3', { direction: 'in', predicate: 'branched-from' }),
    ).toBe(true)
    expect(
      isReachable(graph, 'run-3', 'model-x', { direction: 'out', predicate: 'branched-from' }),
    ).toBe(false)
    expect(isReachable(graph, 'run-3', 'model-x', { direction: 'out' })).toBe(true)
    expect(isReachable(graph, 'claim-a', 'model-x', { direction: 'both' })).toBe(true)
  })

  it('refuses an unknown node and a malformed query', () => {
    expectError(() => neighbors(graph, 'ghost', { direction: 'out' }), 'unknown-node')
    expectError(() => walk(graph, 'ghost', { direction: 'out' }), 'unknown-node')
    expectError(() => isReachable(graph, 'run-1', 'ghost', { direction: 'out' }), 'unknown-node')
    expectError(
      () => neighbors(graph, 'run-1', { direction: 'sideways' as 'out' }),
      'invalid-query',
    )
    expectError(
      () => neighbors(graph, 'run-1', { direction: 'out', predicate: '' }),
      'invalid-query',
    )
    expectError(() => walk(graph, 'run-1', { direction: 'out', maxDepth: -1 }), 'invalid-query')
    expectError(() => walk(graph, 'run-1', { direction: 'out', maxDepth: 1.5 }), 'invalid-query')
  })
})
