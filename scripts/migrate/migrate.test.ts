import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  publishableHash,
  migrateLegacy,
  permissionsSchema,
  pushedSchema,
  tooltipSchema,
} from '@clarity/core';
import {
  formatJson,
  prepareMigration,
  readJson,
  readMigration,
  writeMigration,
} from './migrate.js';
import { foldFrames } from './foldFrames.js';
import { buildBundle } from './template/scripts/build-bundle.mjs';

const owner = { users: { '117818418': { login: 'StardustD2', role: 'maintainer' } } };
const sourceCommit = 'a'.repeat(40);
const directories: string[] = [];

function database(text: string, hash = 42) {
  return {
    perks: {
      [hash]: {
        hash,
        name: 'Example',
        type: 'weaponPerk',
        editor: { en: { main: text, secondary: 'discarded' } },
        uploadedBy: 'original author',
        lastUpload: 1000,
        updateTracker: { descriptions: { en: { lastUpdate: 2000, updatedBy: 'translator' } } },
      },
    },
    databaseSettings: { folders: {}, enhancedPerks: {} },
  };
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'clarity-migration-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('migration', () => {
  it('uses migrated live publishable hashes and ignores metadata-only changes', async () => {
    const intermediate = database('draft');
    const live = database('published');
    const result = await prepareMigration(intermediate, live, owner);
    expect(result.pending).toBe(1);
    expect(result.liveCount).toBe(1);
    expect(result.pushed['42']).toBe(await publishableHash(migrateLegacy(live)[0]));
    expect(result.pushed['42']).not.toBe(await publishableHash(result.tooltips[0]));
    expect(result.tooltips[0].text.en).toEqual({
      text: 'draft',
      updatedAt: '1970-01-01T00:00:02.000Z',
      updatedBy: 'translator',
    });
    expect((await prepareMigration(live, live, owner)).pending).toBe(0);
    const metadataOnly = database('published');
    metadataOnly.perks[42].lastUpload = 3000;
    expect((await prepareMigration(metadataOnly, live, owner)).pending).toBe(0);
  });

  it('retains live-only baselines, detects new tooltips, and validates input', async () => {
    const result = await prepareMigration(database('new', 43), database('old'), owner);
    expect(result.pending).toBe(1);
    expect(Object.keys(result.pushed)).toEqual(['42']);
    await expect(prepareMigration({}, database('x'), owner)).rejects.toThrow();
    await expect(
      prepareMigration(database('x'), database('x'), { users: { bad: {} } }),
    ).rejects.toThrow();
  });

  it('writes stable 2-space newline JSON and is byte-identical on rerun', async () => {
    const root = await temporaryDirectory();
    const result = await prepareMigration(database('draft', 2), database('live', 2), owner);
    await writeMigration(root, result);
    const path = join(root, 'tooltips', '2.json');
    const first = await readFile(path, 'utf8');
    expect(first).toBe(formatJson(result.tooltips[0]));
    expect(first).toContain('\n  "associated": [],\n  "custom": {');
    expect(first.endsWith('\n')).toBe(true);
    expect(tooltipSchema.parse(JSON.parse(first)).custom?.name).toBe('Example');
    expect(
      permissionsSchema.parse(await readJson(join(root, 'config', 'permissions.json'))),
    ).toEqual(owner);
    expect(pushedSchema.parse(await readJson(join(root, 'live', 'pushed.json')))).toEqual(
      result.pushed,
    );
    await writeFile(join(root, 'tooltips', '123.json'), '{}');
    await writeFile(join(root, 'keep.txt'), 'untouched');
    await writeMigration(root, result, { allowAuthoredOverwrite: true });
    expect(await readFile(path, 'utf8')).toBe(first);
    expect(await readdir(join(root, 'tooltips'))).toEqual(['2.json']);
    expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('untouched');
    expect(await readFile(join(root, '.github', 'workflows', 'bundle.yml'), 'utf8')).toContain(
      'HEAD:refs/heads/editor-data-bundle',
    );
  });

  it('rejects unexpected output entries instead of deleting them', async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, 'tooltips'));
    await writeFile(join(root, 'tooltips', 'notes.txt'), 'preserve');
    const result = await prepareMigration(database('draft'), database('live'), owner);
    await expect(writeMigration(root, result)).rejects.toThrow('Unexpected entry');
    expect(await readFile(join(root, 'tooltips', 'notes.txt'), 'utf8')).toBe('preserve');
  });

  it('preserves authored v2 tooltips, permissions and pending/published markers on rerun', async () => {
    const root = await temporaryDirectory();
    const existing = await prepareMigration(database('old'), database('old'), owner);
    existing.tooltips[0].text.en = {
      text: 'v2 edit',
      updatedAt: '2026-10-31T00:00:00Z',
      updatedBy: 'editor',
    };
    existing.tooltips[0].text.de = {
      text: 'Deutsch',
      updatedAt: '2026-10-31T01:00:00Z',
      updatedBy: 'translator',
      sourceUpdatedAt: '2026-10-31T00:00:00Z',
    };
    existing.tooltips[0].associated = [100];
    existing.tooltips[0].bungieSnapshot = {
      description: 'reviewed',
      snapshotAt: '2026-10-31T00:00:00Z',
    };
    existing.tooltips[0].compendium = {
      gid: '123',
      rowKey: 'example',
      snapshot: { plain: 'reviewed', runs: [{ text: 'reviewed', bold: true }] },
      snapshotAt: '2026-10-31T00:00:00Z',
      cells: [{ dRow: 1, dCol: 2 }],
      parts: ['part'],
    };
    existing.tooltips.push({
      hash: 100,
      text: {},
      associated: [],
      custom: { name: 'New v2 item', categoryId: 'custom' },
    });
    existing.permissions.users['123'] = {
      login: 'translator',
      role: 'translator',
      languages: ['de'],
    };
    delete existing.pushed['42'];
    existing.pushed['100'] = 'b'.repeat(64);
    await writeMigration(root, existing);
    const stored = await readMigration(root);
    const incoming = database('legacy overwrite');
    Object.assign(incoming.perks, database('new legacy', 43).perks);
    const rerun = await prepareMigration(incoming, database('legacy live'), owner, stored, []);
    expect(rerun.preserved).toBe(2);
    expect(rerun.tooltips.find(({ hash }) => hash === 42)).toEqual(existing.tooltips[0]);
    expect(rerun.tooltips.find(({ hash }) => hash === 100)).toEqual(existing.tooltips[1]);
    expect(rerun.tooltips.find(({ hash }) => hash === 43)?.text.en?.text).toBe('new legacy');
    expect(rerun.permissions).toEqual(existing.permissions);
    expect(rerun.pushed).toEqual({ 100: 'b'.repeat(64) });
    await writeMigration(root, rerun);
    expect(formatJson(await readMigration(root))).toBe(
      formatJson({
        tooltips: rerun.tooltips,
        permissions: rerun.permissions,
        pushed: rerun.pushed,
      }),
    );
    expect(
      formatJson(
        await prepareMigration(
          incoming,
          database('legacy live'),
          owner,
          await readMigration(root),
          [],
        ),
      ),
    ).toBe(formatJson({ ...rerun, preserved: 3 }));
  });

  it('preserving a staged canonical still allows a nonempty legacy member to repair its blank', async () => {
    const existing = await prepareMigration(database('', 10), database('', 10), owner);
    existing.tooltips[0].text.en!.updatedAt = '2026-10-31T00:00:00Z';
    existing.tooltips[0].bungieSnapshot = {
      description: 'retained',
      snapshotAt: '2026-10-31T00:00:00Z',
    };
    const rerun = await prepareMigration(
      database('member', 20),
      database('member', 20),
      owner,
      existing,
      [],
    );
    const folded = foldFrames(rerun.tooltips, { 20: { to: 10, kind: 'frame' } }, rerun.pushed, {});
    expect(folded.tooltips).toHaveLength(1);
    expect(folded.tooltips[0].text.en?.text).toBe('member');
    expect(folded.tooltips[0].bungieSnapshot).toEqual(existing.tooltips[0].bungieSnapshot);
    expect(folded.pushed).toEqual({});
    expect(existing.tooltips[0].text.en?.text).toBe('');
  });

  it('rejects partial, malformed or mismatched existing data before a rerun', async () => {
    const root = await temporaryDirectory();
    expect(await readMigration(root)).toBeUndefined();
    await mkdir(join(root, 'tooltips'));
    await expect(readMigration(root)).rejects.toThrow();
    await writeMigration(root, await prepareMigration(database('draft'), database('live'), owner), {
      allowAuthoredOverwrite: true,
    });
    await writeFile(
      join(root, 'tooltips', '42.json'),
      formatJson({
        ...migrateLegacy(database('draft'))[0],
        hash: 43,
      }),
    );
    await expect(readMigration(root)).rejects.toThrow('hash mismatch');
    await writeMigration(root, await prepareMigration(database('draft'), database('live'), owner), {
      allowAuthoredOverwrite: true,
    });
    await writeFile(join(root, 'config', 'permissions.json'), '{"users":{"bad":{}}}');
    await expect(readMigration(root)).rejects.toThrow();
  });

  it('CLI preserves existing data with pinned offline inputs and refuses an invalid owner', async () => {
    const root = await temporaryDirectory();
    const output = join(root, 'output');
    const existing = await prepareMigration(database('v2 draft'), database('published'), owner);
    existing.permissions.users['123'] = { login: 'editor', role: 'editor' };
    await writeMigration(output, existing);
    for (const [name, value] of [
      ['intermediate', database('legacy overwrite')],
      ['live', database('published')],
      ['owner', { id: 117818418, login: 'StardustD2' }],
      ['deletions', []],
    ] as const) {
      await writeFile(join(root, `${name}.json`), formatJson(value));
    }
    const args = [
      fileURLToPath(new URL('./node_modules/tsx/dist/cli.mjs', import.meta.url)),
      fileURLToPath(new URL('./cli.ts', import.meta.url)),
      '--output',
      output,
      '--intermediate',
      join(root, 'intermediate.json'),
      '--live',
      join(root, 'live.json'),
      '--owner',
      join(root, 'owner.json'),
      '--deletions',
      join(root, 'deletions.json'),
      '--write',
    ];
    const log = execFileSync(process.execPath, args, { encoding: 'utf8' });
    expect(log).toContain('"preserved": 1');
    expect(log).toContain('"pending": 1');
    expect(formatJson(await readMigration(output))).toBe(
      formatJson({
        tooltips: existing.tooltips,
        permissions: existing.permissions,
        pushed: existing.pushed,
      }),
    );
    await writeFile(join(root, 'owner.json'), '{"id":117818418,"login":"wrong"}');
    const failed = spawnSync(process.execPath, args, { encoding: 'utf8' });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('invalid StardustD2 identity');
    expect(formatJson(await readMigration(output))).toBe(
      formatJson({
        tooltips: existing.tooltips,
        permissions: existing.permissions,
        pushed: existing.pushed,
      }),
    );
  });
});

describe('dependency-free bundle', () => {
  it('builds the exact public shape and runs using only Node', async () => {
    const root = await temporaryDirectory();
    const result = await prepareMigration(database('draft'), database('live'), owner);
    await writeMigration(root, result);
    const generatedAt = '2026-10-27T00:00:00.000Z';
    const bundle = await buildBundle(root, sourceCommit, generatedAt);
    expect(bundle).toEqual({
      sourceCommit,
      generatedAt,
      tooltips: { '42': result.tooltips[0] },
      permissions: owner,
      pushed: result.pushed,
    });
    const output = join(root, 'publish', 'bundle.json');
    const script = fileURLToPath(new URL('./template/scripts/build-bundle.mjs', import.meta.url));
    const stdout = execFileSync(process.execPath, [script, output], {
      cwd: root,
      env: { ...process.env, GITHUB_SHA: sourceCommit },
      encoding: 'utf8',
    });
    expect(stdout).toContain('Bundled 1 tooltips');
    expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject(
      JSON.parse(
        formatJson({
          sourceCommit,
          tooltips: { '42': result.tooltips[0] },
          permissions: owner,
          pushed: result.pushed,
        }),
      ),
    );
    expect(await readdir(join(root, 'publish'))).toEqual(['bundle.json']);
  });

  it('carries maintainer sandbox picks only when the file holds some', async () => {
    const root = await temporaryDirectory();
    const result = await prepareMigration(database('draft'), database('live'), owner);
    await writeMigration(root, result);
    const generatedAt = '2026-10-27T00:00:00.000Z';
    const plain = await buildBundle(root, sourceCommit, generatedAt);
    const path = join(root, 'config', 'sandbox-pointers.json');
    await writeFile(path, '{"version":1,"pointers":{}}');
    expect(await buildBundle(root, sourceCommit, generatedAt)).toEqual(plain);
    const picks = {
      version: 1,
      pointers: { 700: { to: 42, candidates: [42, 43], by: 1, at: '2026-11-12T20:00:00Z' } },
    };
    await writeFile(path, JSON.stringify(picks));
    expect(await buildBundle(root, sourceCommit, generatedAt)).toEqual({
      ...plain,
      sandboxPointers: picks,
    });
    await writeFile(path, '{"version":2,"pointers":{}}');
    await expect(buildBundle(root, sourceCommit)).rejects.toThrow('Invalid sandbox pointers');
  });

  it('fails on invalid commit, mismatched hash, missing data or bad pushed digest', async () => {
    const root = await temporaryDirectory();
    await expect(buildBundle(root, 'main')).rejects.toThrow('full source commit');
    await expect(buildBundle(root, sourceCommit)).rejects.toThrow();
    await writeMigration(root, await prepareMigration(database('draft'), database('live'), owner), {
      allowAuthoredOverwrite: true,
    });
    await writeFile(join(root, 'tooltips', '42.json'), '{"hash":43}');
    await expect(buildBundle(root, sourceCommit)).rejects.toThrow('does not match');
    await writeMigration(root, await prepareMigration(database('draft'), database('live'), owner), {
      allowAuthoredOverwrite: true,
    });
    await writeFile(join(root, 'live', 'pushed.json'), '{"42":"bad"}');
    await expect(buildBundle(root, sourceCommit)).rejects.toThrow('Invalid pushed entry');
  });
});
