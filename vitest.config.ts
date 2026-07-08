import { defineConfig } from 'vitest/config';

const TEST_FILE_PATTERNS = ['tests/**/*.test.ts'];
const TEST_TIMEOUT_MS = 30_000;

export default defineConfig({
  test: {
    include: TEST_FILE_PATTERNS,
    environment: 'node',
    testTimeout: TEST_TIMEOUT_MS,
  },
});
