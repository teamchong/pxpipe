import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Render-heavy tests (full-page PNG encodes) can exceed the 5s default on
    // slower machines; the work is CPU-bound, not hung.
    testTimeout: 30_000,
  },
});
