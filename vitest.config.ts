import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { conditions: ['development'] },
  ssr: { resolve: { conditions: ['development'] } },
  test: {
    include: ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'scripts/test/**/*.test.ts'],
    environment: 'node',
    // Tests must never see real credentials or hit live services.
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
  },
})
