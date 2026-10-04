import { canonicalJson } from '@tangle-network/agent-eval'

/** Optional object properties are absent on the wire; other unsupported values still fail. */
export function canonicalMemoryJson(value: unknown): string {
  return canonicalJson(omitUndefinedProperties(value))
}

function omitUndefinedProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitUndefinedProperties)
  if (
    value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, omitUndefinedProperties(child)]),
    )
  }
  return value
}
