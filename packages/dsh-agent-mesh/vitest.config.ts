import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@morewax/sam-mesh/node': fileURLToPath(new URL('../sam-mesh/src/node/index.ts', import.meta.url)),
      '@morewax/sam-mesh/plan': fileURLToPath(new URL('../sam-mesh/src/cli/plan.ts', import.meta.url)),
      '@morewax/sam-mesh': fileURLToPath(new URL('../sam-mesh/src/core/index.ts', import.meta.url)),
    },
  },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
})
