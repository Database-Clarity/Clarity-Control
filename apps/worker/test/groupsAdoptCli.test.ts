import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'vitest';

test('offline adoption preserves archives, enforces CAS, and restores exact bytes', () => {
  execFileSync(process.execPath, ['--test', 'scripts/alias-groups/cli.test.mjs'], {
    cwd: resolve(import.meta.dirname, '../../..'),
    stdio: 'pipe',
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}, 65_000);
