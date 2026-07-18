import type {
  KnowledgeBenchmarkCase,
  KnowledgeClaimMatcher,
  KnowledgeMemoryBenchmarkCase,
  KnowledgeMemoryFactMatcher,
} from './types'

export function isKnowledgeMemoryBenchmarkCase(
  testCase: KnowledgeBenchmarkCase,
): testCase is KnowledgeMemoryBenchmarkCase {
  return testCase.taskKind.startsWith('memory-')
}

export function assertKnowledgeBenchmarkCases(cases: readonly KnowledgeBenchmarkCase[]): void {
  if (cases.length === 0) throw new Error('knowledge benchmark requires cases')
  assertUniqueNonEmptyStrings(
    cases.map((testCase) => testCase.id),
    'knowledge benchmark case id',
  )
  for (const testCase of cases) {
    if (typeof testCase.family !== 'string' || !testCase.family.trim()) {
      throw new Error(`knowledge benchmark case ${testCase.id} requires a family`)
    }
    if (testCase.taskKind === 'retrieval') continue
    if (isKnowledgeMemoryBenchmarkCase(testCase)) {
      assertUniqueNonEmptyStrings(
        testCase.events.map((event) => event.id),
        `${testCase.id} memory event id`,
      )
      for (const event of testCase.events) {
        assertNonEmptyBenchmarkString(event.text, `${testCase.id} memory event ${event.id} text`)
      }
      assertClaimMatchers(testCase.requiredFacts ?? [], `${testCase.id} requiredFacts`)
      assertClaimMatchers(testCase.forbiddenFacts ?? [], `${testCase.id} forbiddenFacts`)
      assertUniqueNonEmptyStrings(
        testCase.expectedEventIds ?? [],
        `${testCase.id} expected event id`,
      )
      assertUniqueNonEmptyStrings(
        testCase.expectedActorIds ?? [],
        `${testCase.id} expected actor id`,
      )
    } else {
      assertClaimMatchers(testCase.requiredClaims ?? [], `${testCase.id} requiredClaims`)
      assertClaimMatchers(testCase.forbiddenClaims ?? [], `${testCase.id} forbiddenClaims`)
      assertUniqueNonEmptyStrings(testCase.expectedSourceIds ?? [], `${testCase.id} source id`)
    }
  }
}

function assertClaimMatchers(claims: readonly KnowledgeClaimMatcher[], label: string): void {
  assertUniqueNonEmptyStrings(
    claims.map((claim) => claim.id),
    `${label} matcher id`,
  )
  for (const claim of claims) {
    if (claim.anyOf.length === 0) throw new Error(`${label} matcher ${claim.id} requires anyOf`)
    assertUniqueNonEmptyStrings(claim.anyOf, `${label} matcher ${claim.id} anyOf`)
    if (claim.weight !== undefined && (!Number.isFinite(claim.weight) || claim.weight <= 0)) {
      throw new Error(`${label} matcher ${claim.id} weight must be a positive finite number`)
    }
    const sourceEventIds = (claim as Partial<KnowledgeMemoryFactMatcher>).sourceEventIds
    if (sourceEventIds !== undefined) {
      assertUniqueNonEmptyStrings(sourceEventIds, `${label} matcher ${claim.id} source event id`)
    }
  }
}

export function assertUniqueNonEmptyStrings(values: readonly string[], label: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    assertNonEmptyBenchmarkString(value, label)
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`)
    seen.add(value)
  }
}

export function assertNonEmptyBenchmarkString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be non-empty`)
}
