/**
 * Read a string value from an optional metadata bag, returning `undefined`
 * when the key is absent or holds a non-string value. Shared by the readiness
 * and inspection paths so the "string field of an untyped record" coercion is
 * single-sourced.
 *
 * Internal — not re-exported through the package barrel.
 */
export function stringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key]
  return typeof value === 'string' ? value : undefined
}
