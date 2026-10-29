import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node', clearMocks: true, hookTimeout: 30_000, testTimeout: 30_000 },
  esbuild: { target: 'node20' },
  coverage: {
    provider: 'v8',
    include: ['src/**/*.ts'],
    exclude: ['src/index.ts'],
    thresholds: { statements: 70, lines: 70 },
  },
});
