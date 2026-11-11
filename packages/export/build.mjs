// Bundles the engine into one dependency-free ES module, dist/engine.mjs (no Node built-ins, so the
// same file runs in Node and in a browser Web Worker), plus the Node scripts the workflows run.
//
//   node build.mjs                                   -> dist/
//   node build.mjs --install <dir> --generator-sha <sha>
//       -> the `.exports/` folder installed on the `converter` branch (INSTALL.md): engine.mjs,
//          config.mjs, build-site.mjs, legacy-job.mjs, config.json, and PIN (the source SHA).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @param {string} path */
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
/** @type {[string, string, 'neutral' | 'node'][]} */
const bundles = [
  // dist/config.mjs: the config schema (zod) for build-site; kept out of the engine the preview loads.
  ['./src/index.ts', './dist/engine.mjs', 'neutral'],
  ['./src/config.ts', './dist/config.mjs', 'neutral'],
  // The scripts load engine.mjs and config.mjs from their own folder at run time, so the engine
  // that builds the site is byte for byte the one the snapshot publishes for the preview.
  ['./src/site/build-site-cli.ts', './dist/build-site.mjs', 'node'],
  ['./src/site/legacy-job-cli.ts', './dist/legacy-job.mjs', 'node'],
];
for (const [entry, out, platform] of bundles) {
  await build({
    entryPoints: [here(entry)],
    bundle: true,
    format: 'esm',
    platform,
    target: platform === 'node' ? 'node20' : 'es2022',
    outfile: here(out),
    legalComments: 'inline',
    logLevel: 'warning',
  });
}

const args = process.argv.slice(2);
/** @param {string} name */
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const install = option('install');
if (install) {
  const generatorSha = option('generator-sha');
  if (!/^[0-9a-f]{40}$/.test(generatorSha ?? ''))
    throw new Error('--generator-sha <40-hex> is required');
  const status = execFileSync('git', ['status', '--porcelain', '--', '.'], {
    cwd: here('.'),
  }).toString();
  if (status.trim())
    throw new Error(
      'packages/export has uncommitted changes: commit first, so PIN names the source',
    );
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here('.') })
    .toString()
    .trim();
  mkdirSync(install, { recursive: true });
  const files = ['engine.mjs', 'config.mjs', 'build-site.mjs', 'legacy-job.mjs'];
  for (const file of files) cpSync(here(`./dist/${file}`), join(install, file));
  writeFileSync(join(install, 'config.json'), JSON.stringify({ generatorSha }, null, 2) + '\n');
  writeFileSync(join(install, 'PIN'), `${sourceSha}\n`);
  for (const file of [...files, 'config.json', 'PIN'])
    console.log(
      `${createHash('sha256')
        .update(readFileSync(join(install, file)))
        .digest('hex')}  ${file}`,
    );
}
