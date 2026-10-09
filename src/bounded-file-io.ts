/** Keep filesystem descriptors bounded and drain a failed batch before its owner releases handles. */
export async function mapFileIo<T, R>(
  values: readonly T[],
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  for (let start = 0; start < values.length; start += 8) {
    const batch = await Promise.allSettled(
      values
        .slice(start, start + 8)
        .map((value, offset) => Promise.resolve().then(() => operation(value, start + offset))),
    )
    const failed = batch.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    for (const result of batch) {
      if (result.status === 'fulfilled') results.push(result.value)
    }
  }
  return results
}
