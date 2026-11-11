// Bundles the engine into one dependency-free ES module, dist/engine.mjs (no Node built-ins, so the
// same file runs in Node and in a browser Web Worker).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  entryPoints: [fileURLToPath(new URL('./src/index.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  outfile: fileURLToPath(new URL('./dist/engine.mjs', import.meta.url)),
  legalComments: 'inline',
  logLevel: 'warning',
});
