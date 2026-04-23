import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
    testTimeout: 15000,  // e2e 含 spawn，放宽
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test-setup.ts', 'src/main.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        perFile: false,
      },
    },
  },
});
