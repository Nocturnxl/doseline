import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/core/**/*.ts'],
      exclude: ['src/core/**/*.test.ts', 'src/core/index.ts', 'src/core/ports.ts', 'src/core/types.ts', 'src/core/testkit.ts'],
      reporter: ['text-summary', 'text'],
    },
  },
})
