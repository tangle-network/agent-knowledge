const SHA256_REF = /^sha256:[a-f0-9]{64}$/i
const GIT_REF = /^git:[a-f0-9]{40}$/i
const DEPLOYMENT_REF = /^deployment:[a-z0-9][a-z0-9._:/-]*$/i

export function assertImmutableRef(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    (!SHA256_REF.test(value) && !GIT_REF.test(value) && !DEPLOYMENT_REF.test(value))
  ) {
    throw new Error(`${label} must be sha256:<64 hex>, git:<40 hex>, or deployment:<immutable id>`)
  }
}
