import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
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
