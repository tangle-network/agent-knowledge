import { type KnowledgeBundle, scoreKnowledgeReadiness } from '@tangle-network/agent-eval'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildEvalKnowledgeBundle,
  defineReadinessSpec,
  type KnowledgeIndex,
  type SourceRecord,
} from '../src'

const builtAt = '2026-10-14T00:00:00.000Z'
const deadline = '2026-10-15T00:00:00.000Z'
const verifiedAt = '2026-10-12T00:00:00.000Z'
const afterExpiry = '2026-10-16T00:00:00.000Z'
const spec = defineReadinessSpec({
  id: 'current-evidence',
  description: 'Current source-backed evidence',
  query: 'critical topic',
  requiredFor: ['task'],
  importance: 'blocking',
  minHits: 1,
  minSources: 1,
})

function source(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: 'source',
    uri: 'inline://critical-topic',
    contentHash: '0123456789abcdef',
    createdAt: builtAt,
    ...overrides,
  }
}

function index(sources: SourceRecord[]): KnowledgeIndex {
  return {
    root: '/unused-readiness-fixture',
    generatedAt: builtAt,
    sources,
    pages: [
      {
        id: 'page',
        path: 'critical-topic.md',
        title: 'Critical topic',
        text: 'Critical topic source-backed evidence',
        frontmatter: {},
        sourceIds: sources.map((item) => item.id),
        tags: [],
        outLinks: [],
      },
    ],
    graph: { nodes: [], edges: [] },
  }
}

function roundTrip(bundle: KnowledgeBundle): KnowledgeBundle {
  return JSON.parse(JSON.stringify(bundle)) as KnowledgeBundle
}

afterEach(() => vi.useRealTimers())

describe('readiness freshness across the Knowledge / Eval handoff', () => {
  it.each([
    ['before', '2026-10-14T23:59:59.999Z', []],
    ['at', deadline, ['current-evidence']],
    ['after', afterExpiry, ['current-evidence']],
  ] as const)(
    're-scores the serialized public bundle %s expiry without rebuilding',
    (_, now, ids) => {
      // Make the wall clock disagree with the supplied build time. Both Knowledge
      // and Eval must use builtAt, including the initial report.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(afterExpiry))
      const built = buildEvalKnowledgeBundle({
        taskId: 'task',
        index: index([source({ validUntil: deadline, lastVerifiedAt: verifiedAt })]),
        specs: [spec],
        now: new Date(builtAt),
      })
      expect(built.report.recommendedAction).toBe('run_agent')
      expect(built.report.readinessScore).toBe(1)
      const serialized = roundTrip(built.bundle)
      expect(serialized.requirements).toEqual(built.requirements)
      const report = scoreKnowledgeReadiness({ ...serialized, now: new Date(now) })
      expect(report.blockingMissingRequirements.map((item) => item.id)).toEqual(ids)
      expect(report.recommendedAction).toBe(ids.length ? 'collect_web_data' : 'run_agent')
      expect(report.readinessScore).toBe(ids.length ? 0 : 1)
      expect(serialized.requirements[0]?.currentConfidence).toBe(1)
      expect(serialized.requirements[0]).toMatchObject({
        validUntil: deadline,
        lastVerifiedAt: verifiedAt,
        metadata: { validUntil: deadline, lastVerifiedAt: verifiedAt },
      })
    },
  )

  it('keeps the earliest source deadline and latest verification, including metadata fallbacks', () => {
    const built = buildEvalKnowledgeBundle({
      taskId: 'task',
      index: index([
        source({
          id: 'later',
          validUntil: afterExpiry,
          lastVerifiedAt: '2026-10-10T00:00:00.000Z',
          metadata: { validUntil: '2026-10-01T00:00:00.000Z' },
        }),
        source({ id: 'earliest', metadata: { expiresAt: deadline, lastVerifiedAt: verifiedAt } }),
        source({ id: 'unknown' }),
      ]),
      specs: [spec],
      now: new Date(builtAt),
    })
    expect(built.requirements[0]).toMatchObject({
      validUntil: deadline,
      lastVerifiedAt: verifiedAt,
      metadata: { validUntil: deadline, lastVerifiedAt: verifiedAt, sourceCount: 3 },
    })
    const report = scoreKnowledgeReadiness({ ...roundTrip(built.bundle), now: new Date(deadline) })
    expect(report.blockingMissingRequirements.map((item) => item.id)).toEqual([spec.id])
  })

  it('uses typed freshness fields rather than legacy diagnostic metadata when re-scoring', () => {
    const built = buildEvalKnowledgeBundle({
      taskId: 'task',
      index: index([source({ validUntil: deadline, lastVerifiedAt: verifiedAt })]),
      specs: [spec],
      now: new Date(builtAt),
    })
    const serialized = roundTrip(built.bundle)
    serialized.requirements[0]!.metadata!.validUntil = '2099-01-01T00:00:00.000Z'
    expect(
      scoreKnowledgeReadiness({ ...serialized, now: new Date(deadline) }).recommendedAction,
    ).toBe('collect_web_data')
    serialized.requirements[0]!.validUntil = 'not-a-date'
    expect(
      scoreKnowledgeReadiness({ ...serialized, now: new Date(builtAt) }).recommendedAction,
    ).toBe('collect_web_data')
  })

  it.each([
    ['absent', {}],
    ['malformed', { validUntil: 'not-a-date', lastVerifiedAt: 'not-a-date' }],
  ])('preserves the existing unknown-freshness policy for %s source dates', (_, fields) => {
    const built = buildEvalKnowledgeBundle({
      taskId: 'task',
      index: index([source(fields)]),
      specs: [spec],
      now: new Date(builtAt),
    })
    const requirement = built.requirements[0]!
    for (const key of ['validUntil', 'lastVerifiedAt']) {
      expect(Object.hasOwn(requirement, key)).toBe(false)
      expect(Object.hasOwn(requirement.metadata!, key)).toBe(false)
    }
    expect(
      scoreKnowledgeReadiness({ ...roundTrip(built.bundle), now: new Date(afterExpiry) })
        .recommendedAction,
    ).toBe('run_agent')
  })

  it('retains expired-source diagnostics when built at the deadline using the default clock', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(deadline))
    const built = buildEvalKnowledgeBundle({
      taskId: 'task',
      index: index([source({ validUntil: deadline })]),
      specs: [spec],
    })
    expect(built.report.recommendedAction).toBe('collect_web_data')
    expect(built.requirements[0]).toMatchObject({
      validUntil: deadline,
      currentConfidence: 0,
      metadata: { freshnessScore: 0, expiredSourceIds: ['source'] },
    })
  })
})
