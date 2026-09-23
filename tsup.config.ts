import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  splitting: false,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  target: 'node22',
  // Native-optional (pg) and the Azure SDK stay in node_modules.
  external: [/^@azure\//, 'pg', 'commander', 'dotenv', 'yaml'],
});
