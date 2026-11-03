import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
await build({
  entryPoints: ['scripts/publisher/cli.ts'],
  outfile: 'scripts/publisher/dist/publisher.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
});
writeFileSync(
  'scripts/publisher/dist/PIN',
  JSON.stringify(
    {
      sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      sha256: createHash('sha256')
        .update(readFileSync('scripts/publisher/dist/publisher.mjs'))
        .digest('hex'),
    },
    null,
    2,
  ) + '\n',
);
if (process.argv.includes('--template')) {
  const target = 'scripts/publisher/template/.publisher';
  mkdirSync(target, { recursive: true });
  for (const file of ['publisher.mjs', 'PIN'])
    copyFileSync(`scripts/publisher/dist/${file}`, `${target}/${file}`);
}
