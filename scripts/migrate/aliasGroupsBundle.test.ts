import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
// @ts-expect-error The installed bundle builder is standalone JavaScript.
import { buildBundle } from './template/scripts/build-bundle.mjs';

test('bundle group config shares the tooltip snapshot, retains invalid config, and excludes archives', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alias-bundle-'));
  try {
    for (const dir of ['tooltips', 'config', 'live', 'migration-archives/alias-groups'])
      await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, 'tooltips/123.json'), '{"hash":123}');
    await writeFile(join(root, 'config/permissions.json'), '{"users":{}}');
    await writeFile(join(root, 'live/pushed.json'), '{}');
    await writeFile(
      join(root, 'migration-archives/alias-groups/private.json'),
      '{"secret":"archived body"}',
    );
    const before = await buildBundle(root, 'a'.repeat(40), '2026-11-15T00:00:00Z');
    expect(before).not.toHaveProperty('aliasGroups');
    const config = { version: 1, groups: {}, rejected: {}, archives: [] };
    await writeFile(join(root, 'config/alias-groups.json'), JSON.stringify(config));
    const after = await buildBundle(root, 'b'.repeat(40), before.generatedAt);
    expect(after).toEqual({ ...before, sourceCommit: 'b'.repeat(40), aliasGroups: config });
    expect(JSON.stringify(after)).not.toContain('archived body');
    for (const bytes of ['{', 'null', '{"version":2}']) {
      await writeFile(join(root, 'config/alias-groups.json'), bytes);
      const invalid = await buildBundle(root, 'c'.repeat(40));
      expect(invalid).toHaveProperty('aliasGroups', bytes === '{' ? null : JSON.parse(bytes));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
