import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/scripts/seed.ts', 'src/scripts/migrate.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  // Bundle the shared workspace package; keep real npm dependencies external.
  noExternal: ['@sh/shared'],
  onSuccess: 'node -e "require(\'fs\').copyFileSync(\'src/db/local-shim.sql\', \'dist/local-shim.sql\')"',
});
