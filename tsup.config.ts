import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'viz/index': 'src/viz/index.ts',
    cli: 'src/cli.ts',
    'sources/index': 'src/sources/index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
})
