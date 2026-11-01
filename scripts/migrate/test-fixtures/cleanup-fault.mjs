import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';

const originalRm = fs.rm;
let injected = false;
fs.rm = async (path, options) => {
  if (!injected && basename(path).startsWith('.migration-transaction-') && options?.recursive) {
    injected = true;
    if (process.env.MIGRATION_TEST_CLEANUP === 'partial') {
      const backup = (await fs.readdir(path)).find((name) => name.endsWith('.old'));
      if (!backup) throw new Error('test expected a transaction backup');
      await originalRm(join(path, backup));
    } else if (process.env.MIGRATION_TEST_CLEANUP === 'complete') {
      await originalRm(path, options);
    }
    throw new Error('injected backup cleanup EACCES');
  }
  if (injected && process.env.MIGRATION_TEST_ROLLBACK_TARGET === path) {
    throw new Error('injected rollback EACCES');
  }
  if (
    injected &&
    process.env.MIGRATION_TEST_CLEANUP_RETRY_FAILURE &&
    basename(path).startsWith('.migration-transaction-') &&
    options?.recursive
  ) {
    throw new Error('injected cleanup retry EACCES');
  }
  return originalRm(path, options);
};
const originalWriteFile = fs.writeFile;
fs.writeFile = async (path, ...args) => {
  if (
    process.env.MIGRATION_TEST_SNAPSHOT_FAILURE &&
    basename(dirname(path)).startsWith('.migration-recovery-')
  ) {
    throw new Error('injected recovery snapshot EACCES');
  }
  return originalWriteFile(path, ...args);
};
syncBuiltinESMExports();
