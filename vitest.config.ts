import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'lcov', 'json-summary'],
      // A floor, not a target. Set just under today's numbers so an honest
      // refactor does not trip it, and raised as coverage improves. The point
      // is that it cannot silently fall: three of the six defects found in the
      // September audit were in paths nothing exercised, and the suite was
      // green throughout.
      thresholds: {
        statements: 74,
        branches: 67,
        functions: 69,
        lines: 76,
      },
    },
  },
});
