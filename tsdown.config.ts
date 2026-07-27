import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'viz/index': 'src/viz/index.ts',
    cli: 'src/cli.ts',
    'memory/index': 'src/memory/index.ts',
    'sources/index': 'src/sources/index.ts',
    'benchmarks/index': 'src/benchmarks/index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'node',
  fixedExtension: false,
  deps: {
    neverBundle: true,
  },
})
