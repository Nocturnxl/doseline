import { defineConfig } from 'vitest/config'

// Opt-in smoke tests against the real NLM and openFDA APIs: `npm run test:live`.
export default defineConfig({
  test: {
    include: ['tests/live/**/*.live.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
})
