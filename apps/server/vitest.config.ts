import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@cu/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Los tests que tocan disco (symlinks, SQLite) no deben pisarse entre si.
    fileParallelism: true,
    testTimeout: 20_000,
  },
});
