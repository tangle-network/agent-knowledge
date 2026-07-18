import type { KnowledgeMemoryFactMatcher } from '../../benchmarks/index'
import type { AgentMemoryScope } from '../types'
import type { AgentMemorySequence } from './types'

export function assertMemorySequences(sequences: readonly AgentMemorySequence[]): void {
  for (const sequence of sequences) {
    assertNonEmptyString(sequence.family, `memory experiment sequence ${sequence.id} family`)
    if (sequence.steps.length === 0) {
      throw new Error(`memory experiment sequence ${sequence.id} has no steps`)
    }
    assertUnique(
      sequence.steps.map((step) => step.id),
      `step in sequence ${sequence.id}`,
    )
    let probeCount = 0
    for (const step of sequence.steps) {
      for (const write of step.writes ?? []) {
        assertNonEmptyString(write.text, `memory experiment write in ${sequence.id}/${step.id}`)
        if (write.id !== undefined) {
          assertNonEmptyString(write.id, `memory experiment write id in ${sequence.id}/${step.id}`)
        }
      }
      assertUnique(
        (step.probes ?? []).map((probe) => probe.id),
        `probe in sequence ${sequence.id} step ${step.id}`,
      )
      for (const probe of step.probes ?? []) {
        probeCount += 1
        assertNonEmptyString(
          probe.query,
          `memory experiment probe query ${sequence.id}/${step.id}/${probe.id}`,
        )
        if (probe.limit !== undefined && (!Number.isSafeInteger(probe.limit) || probe.limit <= 0)) {
          throw new Error(
            `memory experiment probe limit ${sequence.id}/${step.id}/${probe.id} must be a positive safe integer`,
          )
        }
        assertMemoryFactMatchers(
          probe.requiredFacts ?? [],
          `${sequence.id}/${step.id}/${probe.id} requiredFacts`,
        )
        assertMemoryFactMatchers(
          probe.forbiddenFacts ?? [],
          `${sequence.id}/${step.id}/${probe.id} forbiddenFacts`,
        )
        assertStringList(probe.expectedEventIds, `${sequence.id}/${step.id}/${probe.id} event ids`)
        assertStringList(probe.expectedActorIds, `${sequence.id}/${step.id}/${probe.id} actor ids`)
        if (probe.referenceAnswer !== undefined) {
          assertNonEmptyString(
            probe.referenceAnswer,
            `memory experiment reference answer ${sequence.id}/${step.id}/${probe.id}`,
          )
        }
        const hasTarget =
          (probe.requiredFacts?.length ?? 0) > 0 ||
          (probe.forbiddenFacts?.length ?? 0) > 0 ||
          (probe.expectedEventIds?.length ?? 0) > 0 ||
          (probe.expectedActorIds?.length ?? 0) > 0 ||
          Boolean(probe.referenceAnswer?.trim())
        if (!hasTarget) {
          throw new Error(
            `memory experiment probe ${sequence.id}/${step.id}/${probe.id} has no measurable target`,
          )
        }
      }
    }
    if (probeCount === 0) {
      throw new Error(`memory experiment sequence ${sequence.id} has no probes`)
    }
  }
}

export function normalizeCleanupScope(scope: AgentMemoryScope): AgentMemoryScope {
  const normalized = compactScope(scope)
  if (normalized.tags && Object.keys(normalized.tags).length === 0) {
    delete normalized.tags
  }
  return normalized
}

export function compactScope(scope: AgentMemoryScope): AgentMemoryScope {
  return Object.fromEntries(
    Object.entries(scope).filter(([, value]) => value !== undefined),
  ) as AgentMemoryScope
}

export function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

export function uniqueStrings(values: readonly unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string'))]
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

export function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    assertNonEmptyString(value, `memory experiment ${label} id`)
    if (seen.has(value)) throw new Error(`duplicate memory experiment ${label} id: ${value}`)
    seen.add(value)
  }
}

function assertMemoryFactMatchers(
  matchers: readonly KnowledgeMemoryFactMatcher[],
  label: string,
): void {
  assertUnique(
    matchers.map((matcher) => matcher.id),
    `${label} matcher`,
  )
  for (const matcher of matchers) {
    if (matcher.anyOf.length === 0) {
      throw new Error(`memory experiment ${label} matcher ${matcher.id} requires anyOf`)
    }
    assertStringList(matcher.anyOf, `${label} matcher ${matcher.id} anyOf`)
    assertStringList(matcher.sourceEventIds, `${label} matcher ${matcher.id} source event ids`)
    if (matcher.weight !== undefined && (!Number.isFinite(matcher.weight) || matcher.weight <= 0)) {
      throw new Error(
        `memory experiment ${label} matcher ${matcher.id} weight must be a positive finite number`,
      )
    }
  }
}

function assertStringList(values: readonly string[] | undefined, label: string): void {
  if (values === undefined) return
  assertUnique(values, label)
}

export function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
}
