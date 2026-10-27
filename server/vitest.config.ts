import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve:{alias:{'@':fileURLToPath(new URL('../apps/web/src',import.meta.url))}},
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'forks',
  },
});
