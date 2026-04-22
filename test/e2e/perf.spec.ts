/**
 * Basic performance budget: landing page first-contentful-paint on localhost.
 * Local-only app so budget is generous (< 2s for FCP on dev hardware).
 */
import { test, expect } from '@playwright/test';

test('perf: landing FCP under budget', async ({ page }) => {
  await page.goto('/projects');
  await page.waitForLoadState('domcontentloaded');
  // Poll until paint entry is available (first render might not be done immediately)
  const fcp = await page.evaluate<number>(async () => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const entry = performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint');
      if (entry) return entry.startTime;
      await new Promise((r) => setTimeout(r, 50));
    }
    return -1;
  });
  expect(fcp).toBeGreaterThan(0);
  // Budget: 2s on localhost is plenty — anything over indicates a regression
  expect(fcp).toBeLessThan(2000);
  console.log(`FCP: ${fcp.toFixed(0)}ms`);
});

test('perf: api/projects responds fast', async ({ request }) => {
  const start = Date.now();
  const res = await request.get('/api/projects');
  const elapsed = Date.now() - start;
  expect(res.status()).toBe(200);
  expect(elapsed).toBeLessThan(500); // 500ms loose budget for file-system scan
  console.log(`/api/projects: ${elapsed}ms`);
});
