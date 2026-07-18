import {
  type RunMemoryAdapterBenchmarkOptions,
  runMemoryAdapterBenchmark as runMemoryAdapterBenchmarkRaw,
} from '../../src/benchmarks/index'

export function runMemoryAdapterBenchmark(options: RunMemoryAdapterBenchmarkOptions) {
  return runMemoryAdapterBenchmarkRaw({
    ...options,
    ...(options.storage && !options.controllerMode && !options.acquireRunLease
      ? { controllerMode: 'process-local' as const }
      : {}),
  })
}
