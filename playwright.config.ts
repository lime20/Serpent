import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: process.env.SERPENT_E2E_OUTPUT_DIR ?? 'test-results',
  maxFailures: process.env.SERPENT_E2E_FAIL_FAST === '1' ? 1 : undefined,
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  preserveOutput: 'always',
  use: {
    trace: 'retain-on-failure',
  },
});
