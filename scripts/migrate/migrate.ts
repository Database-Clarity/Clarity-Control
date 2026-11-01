import { copyFile, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
) {
  const permissions = permissionsSchema.parse(existing?.permissions ?? owner);
  const byHash = new Map(migrateLegacy(intermediate).map((tooltip) => [tooltip.hash, tooltip]));
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

export async function writeMigration(output: string, data: MigrationData) {
  const root = resolve(output);
  const tooltipDirectory = join(root, 'tooltips');
  await mkdir(tooltipDirectory, { recursive: true });
  const expected = new Set(data.tooltips.map(({ hash }) => `${hash}.json`));
  const entries = await readdir(tooltipDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/^(0|[1-9]\d*)\.json$/.test(entry.name)) {
      throw new Error(
        `Unexpected entry in migration output: ${join(tooltipDirectory, entry.name)}`,
      );
    }
  }
  for (const tooltip of data.tooltips) {
    await writeFile(join(tooltipDirectory, `${tooltip.hash}.json`), formatJson(tooltip));
  }
  for (const entry of entries) {
    if (!expected.has(entry.name)) await unlink(join(tooltipDirectory, entry.name));
  }
  for (const [file, value] of [
    ['config/permissions.json', data.permissions],
    ['live/pushed.json', data.pushed],
  ] as const) {
    const target = join(root, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, formatJson(value));
  }
  const template = fileURLToPath(new URL('./template/', import.meta.url));
  for (const file of ['README.md', '.github/workflows/bundle.yml', 'scripts/build-bundle.mjs']) {
    const target = join(root, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(template, file), target);
  }
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}
