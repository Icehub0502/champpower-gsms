import { defineConfig } from 'vitest/config'

// Resolve @champpower/domain from source (the "gsms-source" condition), the
// same way tsc and the dev server do, so tests never run against a stale dist.
export default defineConfig({
  resolve: { conditions: ['gsms-source'] },
  test: { include: ['src/**/*.test.ts'] },
})
