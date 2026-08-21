export { normalizeUsd } from '../candidate-ranking'
export { mean } from '../statistics'

export function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return value.toFixed(value === 0 || Math.abs(value) >= 10 ? 0 : 3)
}

export function compactObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactObject)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, compactObject(entry)]),
  )
}
