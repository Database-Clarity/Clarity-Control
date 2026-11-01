import { join, relative, resolve, sep } from 'node:path';
import { conflictNotes, type foldFrames } from './foldFrames.js';
import { formatJson, planMigration, type MigrationData } from './migrate.js';
import { planFile, readOptional, type FileChange } from './transaction.js';
import { stableStringify, tooltipSchema } from '@clarity/core';
import { z } from 'zod';

export async function planFold(
  root: string,
  existing: MigrationData,
  result: ReturnType<typeof foldFrames>,
  conflicts: string,
  excluded: readonly number[],
): Promise<FileChange[]> {
  const existingHashes = new Set(existing.tooltips.map(({ hash }) => hash));
  for (const { hash } of result.tooltips) {
    if (!existingHashes.has(hash) && excluded.includes(hash)) {
      throw new Error(`Fold would resurrect intentionally deleted canonical ${hash}`);
    }
  }
  const changes = await planMigration(root, {
    ...existing,
    tooltips: result.tooltips,
    pushed: result.pushed,
  });
  // Folding does not own or refresh migration templates.
  const dataChanges = changes.filter(
    ({ path }) => path.startsWith(`tooltips${sep}`) || path === join('live', 'pushed.json'),
  );
  const path = relative(resolve(root), resolve(conflicts));
  if (
    ['tooltips', 'config', 'live', '.github', 'scripts'].some(
      (directory) => path === directory || path.startsWith(`${directory}${sep}`),
    ) ||
    path === 'README.md'
  ) {
    throw new Error('Conflict archive must not overlap authored data or infrastructure');
  }
  const previous = await readOptional(resolve(conflicts));
  const notes = await planFile(
    root,
    path,
    (previous?.toString('utf8') ?? '') + conflictNotes(result.conflicts),
  );
  if (notes) dataChanges.push(notes);
  // Complete originals include imported members that may never have existed in data git history.
  const archivePath = `${path}.originals.json`;
  const oldArchive = await readOptional(resolve(root, archivePath));
  const originals = oldArchive
    ? z.array(tooltipSchema).parse(JSON.parse(oldArchive.toString('utf8')))
    : [];
  const versions = new Map(
    [...originals, ...existing.tooltips].map((tooltip) => [stableStringify(tooltip), tooltip]),
  );
  const archive = await planFile(root, archivePath, formatJson([...versions.values()]));
  if (archive) dataChanges.push(archive);
  return dataChanges.sort((a, b) => a.path.localeCompare(b.path));
}
