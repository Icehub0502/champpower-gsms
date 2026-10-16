import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Tier-2 (database) tests read TEST_DATABASE_URL / TEST_DATABASE_ADMIN_URL from
// a gitignored .env.test at the repo root, or from the file named by
// GSMS_ENV_TEST_FILE. They never read DATABASE_URL (the dev database). Real
// environment variables win over the file. No file and no variables = the
// tier-2 suite is SKIPPED, by name.
const envFile = process.env.GSMS_ENV_TEST_FILE ?? fileURLToPath(new URL('../../.env.test', import.meta.url))
if (existsSync(envFile)) process.loadEnvFile(envFile)

// Resolve @champpower/domain from source (the "gsms-source" condition), the
// same way tsc and the dev server do, so tests never run against a stale dist.
export default defineConfig({
  resolve: { conditions: ['gsms-source'] },
  test: { include: ['src/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
})
