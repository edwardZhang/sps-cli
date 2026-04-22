/**
 * Accessibility smoke: run axe on each top-level page.
 * Fails on serious/critical violations; logs moderate/minor so we can triage.
 */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const PAGES = [
  { name: 'projects', path: '/projects' },
  { name: 'board', path: '/board' },
  { name: 'workers', path: '/workers' },
  { name: 'logs', path: '/logs' },
  { name: 'skills', path: '/skills' },
  { name: 'system', path: '/system' },
  { name: 'chat', path: '/chat' },
];

for (const page of PAGES) {
  test(`a11y: ${page.name}`, async ({ page: p }) => {
    await p.goto(page.path);
    // Let React render + queries settle
    await p.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => { /* ok if SSE keeps it busy */ });

    const results = await new AxeBuilder({ page: p })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();

    const critical = results.violations.filter((v) => v.impact === 'critical');
    const serious = results.violations.filter((v) => v.impact === 'serious');

    if (critical.length + serious.length > 0) {
      console.error(`\n[${page.name}] axe violations:`);
      for (const v of [...critical, ...serious]) {
        console.error(`  [${v.impact}] ${v.id}: ${v.description}`);
        for (const n of v.nodes.slice(0, 3)) {
          console.error(`    - ${n.target.join(' ')} :: ${n.html.slice(0, 120)}`);
        }
      }
    }

    expect(critical, `critical a11y issues on ${page.name}`).toEqual([]);
    expect(serious, `serious a11y issues on ${page.name}`).toEqual([]);
  });
}
