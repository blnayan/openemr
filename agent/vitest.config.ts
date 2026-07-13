import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Rewrite `.js` imports to `.ts` source for the rubric/test pipeline.
    // The eval rubric files (`evals/rubrics/*.js`) import schemas
    // and verifier helpers from `agent/src/...` with the project-wide
    // `.js` suffix convention. Vite's default resolver doesn't rewrite
    // `.js` -> `.ts` for paths outside of `include`, so this alias forces
    // the rewrite at the import-resolution layer.
    alias: [
      {
        find: /^(.+)\.js$/,
        replacement: '$1',
      },
    ],
    extensions: ['.ts', '.tsx', '.mjs', '.js', '.json'],
  },
  test: {
    // Use node environment for unit/integration tests.
    // Web component tests (tests/web-component/) use their own config with happy-dom.
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'tests/web-component/**'],
    // Treat all test files as ES modules
    pool: 'forks',
    // Increase timeout for integration tests that may spin up in-process mock servers
    testTimeout: 20_000,
    // Coverage config (run with vitest --coverage)
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
    },
  },
});
