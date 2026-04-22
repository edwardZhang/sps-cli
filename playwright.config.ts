import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for SPS Console e2e smoke.
 *
 * Strategy:
 *   - webServer starts `sps console --port 4312` on ephemeral port (avoid
 *     collision with 4311 if user has a live console running)
 *   - SPS_E2E_PROJECTS_DIR isolates project state to a temp dir so tests
 *     don't pollute ~/.coral/projects
 *   - Single chromium-headless; serial workers to avoid port/daemon races
 *   - Only smoke test — not trying to cover every flow, just the critical path
 */
const PORT = 4312;

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // dist/main.js is the built CLI; npm run build must have run
    command: `node dist/main.js console --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/system/info`,
    timeout: 30_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
