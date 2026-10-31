import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const args = process.argv.slice(2);
const htmlIndex = args.indexOf('--html-dir');
if (htmlIndex < 0 || !args[htmlIndex + 1]) {
  console.error(
    'Usage: node scripts/compendium/coverage/run.mjs --html-dir <download-directory> [--refresh]',
  );
  process.exit(2);
}
const result = spawnSync(
  process.execPath,
  [
    resolve(root, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--config',
    resolve(root, 'scripts/compendium/coverage/vitest.config.ts'),
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      COMPENDIUM_COVERAGE_HTML_DIR: resolve(args[htmlIndex + 1]),
      COMPENDIUM_COVERAGE_REFRESH: args.includes('--refresh') ? '1' : '',
    },
  },
);
process.exit(result.status ?? 1);
