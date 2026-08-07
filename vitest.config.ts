import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Render-heavy tests (full-page PNG encodes) can exceed the 5s default on
    // slower machines; the work is CPU-bound, not hung. 30s was not enough
    // headroom: the append-only cache-stability case alone runs ~30s, so it
    // timed out purely from CPU contention whenever another file joined the
    // parallel pool — a failure that says nothing about the code under test.
    testTimeout: 60_000,
  },
});
