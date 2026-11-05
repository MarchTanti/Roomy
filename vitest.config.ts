import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The local adapter is a whole-file read-modify-write of one JSON file per
    // table, and tests that do not set ROOMY_DATA_DIR all share the repo's
    // `.data/`. Two workers doing that concurrently lose each other's writes,
    // which shows up as a session that 404s a moment after it was created.
    // Files still reset the DB between tests; this only stops them racing.
    fileParallelism: false,
  },
});
