import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'core/index': 'src/core/index.ts',
    'node/index': 'src/node/index.ts',
    'cli/index': 'src/cli/index.ts',
    'cli/plan': 'src/cli/plan.ts',
  },
  format: 'esm',
  dts: true,
  outDir: 'lib',
})
