import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
  chmod,
  copyFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { stableStringify } from '@clarity/core';

export interface FileChange {
  path: string;
  before: Buffer | null;
  after: string | null;
  mode: number | null;
}

export interface WriteOptions {
  allowAuthoredOverwrite?: boolean;
  approvedPlan?: unknown;
  /** Test-only fault injection after an actual destination change. */
  afterSwap?: (count: number) => void;
}

export async function readOptional(path: string): Promise<Buffer | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Not a regular file: ${path}`);
    return await readFile(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function planFile(root: string, path: string, after: string | null) {
  const full = resolve(root, path);
  const local = relative(resolve(root), full);
  if (!local || local.startsWith('..') || isAbsolute(local)) {
    throw new Error(`Transaction file must be inside the data directory: ${path}`);
  }
  // Never follow a directory symlink out of the checkout.
  for (let parent = dirname(full); parent !== dirname(resolve(root)); parent = dirname(parent)) {
    try {
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(`Unsafe directory: ${parent}`);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  const before = await readOptional(full);
  if (before === null && after === null) return undefined;
  if (before !== null && after !== null && before.equals(Buffer.from(after))) return undefined;
  return {
    path: local,
    before,
    after,
    mode: before === null ? null : (await lstat(full)).mode & 0o777,
  };
}

function sha(value: Buffer | string | null) {
  return value === null ? null : createHash('sha256').update(value).digest('hex');
}

export function dataDiff(changes: readonly FileChange[]) {
  return changes.map((change) => ({
    path: change.path,
    operation: change.before === null ? 'add' : change.after === null ? 'remove' : 'modify',
    beforeSha256: sha(change.before),
    afterSha256: sha(change.after),
    mode: change.mode,
    before: change.before?.toString('utf8') ?? null,
    after: change.after,
  }));
}

export async function commitFiles(
  root: string,
  changes: readonly FileChange[],
  options: WriteOptions = {},
) {
  const paths = new Set(changes.map(({ path }) => path));
  if (paths.size !== changes.length) throw new Error('Duplicate transaction path');
  const diff = dataDiff(changes);
  if (options.approvedPlan !== undefined) {
    if (stableStringify(options.approvedPlan) !== stableStringify(diff)) {
      throw new Error('Approved diff does not match the exact current staged diff');
    }
  } else if (!options.allowAuthoredOverwrite && changes.some(({ before }) => before !== null)) {
    throw new Error(
      'Authored files would change; review the diff and provide --approve or --allow-authored-overwrite',
    );
  }
  if (!changes.length) return;
  for (const change of changes) {
    const current = await planFile(root, change.path, change.after);
    if (!current || sha(current.before) !== sha(change.before) || current.mode !== change.mode) {
      throw new Error(`Concurrent change: ${change.path}`);
    }
  }
  const created: string[] = [];
  async function ensureDirectory(path: string): Promise<void> {
    try {
      await mkdir(path);
      created.push(path);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        await ensureDirectory(dirname(path));
        await ensureDirectory(path);
      } else if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        throw error;
      }
    }
  }
  let temporary: string | undefined;
  const applied: {
    target: string;
    backup: string;
    change: FileChange;
    hadBefore: boolean;
    hasAfter: boolean;
  }[] = [];
  let cleanupStarted = false;
  try {
    await ensureDirectory(resolve(root));
    temporary = await mkdtemp(join(resolve(root), '.migration-transaction-'));
    for (const [index, change] of changes.entries()) {
      if (change.after === null) continue;
      const staged = join(temporary, `${index}.new`);
      await writeFile(staged, change.after);
      if (change.mode !== null) await chmod(staged, change.mode);
    }
    for (const [index, change] of changes.entries()) {
      const target = resolve(root, change.path);
      const current = await readOptional(target);
      if (
        sha(current) !== sha(change.before) ||
        (current !== null && ((await lstat(target)).mode & 0o777) !== change.mode)
      )
        throw new Error(`Concurrent change: ${change.path}`);
      await ensureDirectory(dirname(target));
      const state = {
        target,
        backup: join(temporary, `${index}.old`),
        change,
        hadBefore: false,
        hasAfter: false,
      };
      applied.push(state);
      if (change.before !== null) {
        await rename(target, state.backup);
        state.hadBefore = true;
      }
      if (change.after !== null) {
        await rename(join(temporary, `${index}.new`), target);
        state.hasAfter = true;
      }
      options.afterSwap?.(index + 1);
    }
    cleanupStarted = true;
    await rm(temporary, { recursive: true });
  } catch (error) {
    const failures: unknown[] = [error];
    let recovery: string | undefined;
    if (cleanupStarted) {
      try {
        recovery = await mkdtemp(join(resolve(root), '.migration-recovery-'));
        const originals = applied.map((state, index) => ({
          path: state.change.path,
          file: state.hadBefore ? `${index}.old` : null,
          mode: state.change.mode,
        }));
        await writeFile(join(recovery, 'manifest.json'), JSON.stringify(originals, null, 2));
        for (const [index, state] of applied.entries()) {
          if (!state.hadBefore || state.change.before === null) continue;
          const snapshot = join(recovery, `${index}.old`);
          await writeFile(snapshot, state.change.before);
          if (state.change.mode !== null) await chmod(snapshot, state.change.mode);
        }
      } catch (snapshotError) {
        throw new AggregateError(
          [error, snapshotError],
          `Rollback could not start; destination files may have changed. Recovery snapshots may be incomplete at ${recovery ?? '(unavailable)'}; transaction backups may remain at ${temporary}. Restore from a pristine external snapshot`,
        );
      }
    }
    for (const [index, state] of [...applied.entries()].reverse()) {
      try {
        if (recovery && state.hadBefore) {
          await copyFile(join(recovery, `${index}.old`), join(recovery, `${index}.restore`));
        }
        if (state.hasAfter) await rm(state.target);
        if (state.hadBefore) {
          await rename(recovery ? join(recovery, `${index}.restore`) : state.backup, state.target);
        }
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `Rollback failed; recover originals from ${recovery ?? temporary}`,
      );
    }
    try {
      if (temporary) await rm(temporary, { recursive: true, force: true });
      if (recovery) await rm(recovery, { recursive: true });
      for (const path of created.reverse()) await rmdir(path);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Rollback completed, but cleanup failed; inspect ${temporary} and ${recovery ?? '(no recovery directory)'}`,
      );
    }
    throw error;
  }
}
