import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { readJson } from './migrate.js';

const hashesSchema = z.array(z.number().int().min(0).max(4294967295));

export async function deletedHashes(output: string, path?: string): Promise<number[]> {
  if (path) return hashesSchema.parse(await readJson(path));
  if (!existsSync(resolve(output, '.git'))) {
    throw new Error(
      'Existing data requires complete git deletion history or --deletions <pinned-hashes.json>',
    );
  }
  const git = (args: string[]) =>
    execFileSync('git', ['--no-pager', '-C', resolve(output), ...args], {
      encoding: 'utf8',
    }).trim();
  if (git(['rev-parse', '--is-shallow-repository']) !== 'false') {
    throw new Error('Deletion review requires full history, not a shallow checkout');
  }
  const files = git([
    'log',
    '--full-history',
    '-m',
    '--no-renames',
    '--format=',
    '--diff-filter=D',
    '--name-only',
    'HEAD',
    '--',
    'tooltips',
  ]);
  return [
    ...new Set(
      files.split(/\r?\n/).flatMap((file) => {
        const match = /^tooltips\/(0|[1-9]\d*)\.json$/.exec(file);
        return match ? [Number(match[1])] : [];
      }),
    ),
  ].sort((a, b) => a - b);
}

export function excludedDeletions(deleted: readonly number[], reviewed: readonly string[] = []) {
  const reimports = hashesSchema.parse(reviewed.map(Number));
  for (const hash of reimports) {
    if (!deleted.includes(hash))
      throw new Error(`Reimport ${hash} is not in the pinned deletion history`);
  }
  return deleted.filter((hash) => !reimports.includes(hash));
}
