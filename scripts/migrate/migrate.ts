import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  publishableHash,
  migrateLegacy,
  permissionsSchema,
  pushedSchema,
  stableStringify,
  tooltipSchema,
  type Permissions,
  type Pushed,
  type Tooltip,
} from '@clarity/core';
import { commitFiles, planFile, type FileChange, type WriteOptions } from './transaction.js';

export interface MigrationData {
  tooltips: Tooltip[];
  pushed: Pushed;
  permissions: Permissions;
}

export function formatJson(value: unknown): string {
  return `${JSON.stringify(JSON.parse(stableStringify(value)), null, 2)}\n`;
}

export async function prepareMigration(
  intermediate: unknown,
  live: unknown,
  owner: unknown,
  existing?: MigrationData,
  deleted?: readonly number[],
) {
  if (existing && deleted === undefined) {
    throw new Error('Reruns require reviewed deletion history');
  }
  const permissions = permissionsSchema.parse(existing?.permissions ?? owner);
  const incoming = migrateLegacy(intermediate);
  const excluded = new Set(deleted ?? []);
  const byHash = new Map(
    incoming.filter(({ hash }) => !excluded.has(hash)).map((tooltip) => [tooltip.hash, tooltip]),
  );
  const preserved = new Set<number>();
  for (const input of existing?.tooltips ?? []) {
    const tooltip = tooltipSchema.parse(input);
    if (preserved.has(tooltip.hash)) throw new Error(`Duplicate tooltip ${tooltip.hash}`);
    preserved.add(tooltip.hash);
    byHash.set(tooltip.hash, tooltip);
  }
  const tooltips = [...byHash.values()].sort((a, b) => a.hash - b.hash);
  const liveTooltips = migrateLegacy(live);
  const pushed: Pushed = Object.fromEntries(
    await Promise.all(
      liveTooltips.map(async (tooltip) => [tooltip.hash, await publishableHash(tooltip)]),
    ),
  );
  if (existing) {
    // An absent marker is a pending v2 edit, not permission to mark it published.
    for (const hash of preserved) delete pushed[hash];
    Object.assign(pushed, pushedSchema.parse(existing.pushed));
  }
  for (const hash of excluded) if (!preserved.has(hash)) delete pushed[hash];
  const hashes = await Promise.all(tooltips.map(publishableHash));
  const pending = tooltips.filter(
    (tooltip, index) => hashes[index] !== pushed[tooltip.hash],
  ).length;
  return {
    tooltips,
    pushed,
    permissions,
    pending,
    liveCount: liveTooltips.length,
    preserved: preserved.size,
    excluded: incoming
      .filter(({ hash }) => excluded.has(hash) && !preserved.has(hash))
      .map(({ hash }) => hash)
      .sort((a, b) => a - b),
  };
}

export async function readMigration(output: string): Promise<MigrationData | undefined> {
  const root = resolve(output);
  const directory = join(root, 'tooltips');
  const permissions = join(root, 'config', 'permissions.json');
  const pushed = join(root, 'live', 'pushed.json');
  if (![directory, permissions, pushed].some(existsSync)) return undefined;
  const entries = await readdir(directory, { withFileTypes: true });
  const tooltips = await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || !/^(0|[1-9]\d*)\.json$/.test(entry.name)) {
        throw new Error(`Unexpected entry in migration output: ${join(directory, entry.name)}`);
      }
      const tooltip = tooltipSchema.parse(await readJson(join(directory, entry.name)));
      if (entry.name !== `${tooltip.hash}.json`) {
        throw new Error(`Stored tooltip hash mismatch: ${entry.name}`);
      }
      return tooltip;
    }),
  );
  return {
    tooltips: tooltips.sort((a, b) => a.hash - b.hash),
    permissions: permissionsSchema.parse(await readJson(permissions)),
    pushed: pushedSchema.parse(await readJson(pushed)),
  };
}

export async function planMigration(output: string, data: MigrationData) {
  const root = resolve(output);
  const tooltipDirectory = join(root, 'tooltips');
  const changes: FileChange[] = [];
  const add = async (file: string, after: string | null, json?: unknown) => {
    const change = await planFile(root, file, after);
    if (change?.before && json !== undefined) {
      const previous = change.before.toString('utf8');
      if (stableStringify(JSON.parse(previous)) === stableStringify(json)) return;
      if (after !== null && previous.includes('\r\n') && !/(?<!\r)\n/.test(previous)) {
        change.after = after.replace(/\n/g, '\r\n');
      }
    }
    if (change) changes.push(change);
  };
  const expected = new Set(data.tooltips.map(({ hash }) => `${hash}.json`));
  const entries = existsSync(tooltipDirectory)
    ? await readdir(tooltipDirectory, { withFileTypes: true })
    : [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^(0|[1-9]\d*)\.json$/.test(entry.name)) {
      throw new Error(
        `Unexpected entry in migration output: ${join(tooltipDirectory, entry.name)}`,
      );
    }
  }
  for (const tooltip of data.tooltips) {
    tooltipSchema.parse(tooltip);
    await add(join('tooltips', `${tooltip.hash}.json`), formatJson(tooltip), tooltip);
  }
  for (const entry of entries) {
    if (!expected.has(entry.name)) await add(join('tooltips', entry.name), null);
  }
  for (const [file, value] of [
    [join('config', 'permissions.json'), permissionsSchema.parse(data.permissions)],
    [join('live', 'pushed.json'), pushedSchema.parse(data.pushed)],
  ] as const) {
    await add(file, formatJson(value), value);
  }
  const template = fileURLToPath(new URL('./template/', import.meta.url));
  for (const file of [
    'README.md',
    join('.github', 'workflows', 'bundle.yml'),
    join('scripts', 'build-bundle.mjs'),
  ]) {
    await add(file, await readFile(join(template, file), 'utf8'));
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export async function writeMigration(
  output: string,
  data: MigrationData,
  options: WriteOptions = {},
) {
  const changes = await planMigration(output, data);
  await commitFiles(output, changes, options);
  return changes;
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}
