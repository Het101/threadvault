import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  // On, so the dynamic imports in cli.ts survive into the output. Bundling to
  // a single file resolves import() at build time and hoists it back to a
  // static import, which silently undid the lazy loading: the source looked
  // right and the artifact loaded the Azure SDK on every --help regardless.
  splitting: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  target: 'node22',
  // Native-optional (pg) and the Azure SDK stay in node_modules.
  external: [/^@azure\//, 'pg', 'commander', 'dotenv', 'yaml'],
});
