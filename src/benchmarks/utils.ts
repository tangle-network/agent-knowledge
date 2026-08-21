export { normalizeUsd } from '../candidate-ranking'
export function mean(values: readonly number[]): number {
  const finite = values.filter(Number.isFinite)
  if (finite.length === 0) return 0
  return finite.reduce((sum, value) => sum + value, 0) / finite.length
}

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
