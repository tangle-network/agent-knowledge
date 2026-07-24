const SHA256_REF = /^sha256:[a-f0-9]{64}$/
const GIT_REF = /^git:[a-f0-9]{40}$/

export function assertImmutableRef(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || (!SHA256_REF.test(value) && !GIT_REF.test(value))) {
    throw new Error(`${label} must be lowercase sha256:<64 hex> or git:<40 hex>`)
  }
}
