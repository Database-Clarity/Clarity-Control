// Bundles the engine into one dependency-free ES module, dist/engine.mjs (no Node built-ins, so the
// same file runs in Node and in a browser Web Worker).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// dist/config.mjs: the config schema (zod) for build-site; kept out of the engine the preview loads.
for (const [entry, out] of [
  ['./src/index.ts', './dist/engine.mjs'],
  ['./src/config.ts', './dist/config.mjs'],
]) {
  await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    outfile: fileURLToPath(new URL(out, import.meta.url)),
    legalComments: 'inline',
    logLevel: 'warning',
  });
}
