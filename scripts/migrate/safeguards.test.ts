import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Permissions, Tooltip } from '@clarity/core';
import { deletedHashes, excludedDeletions } from './deletions.js';
import { foldFrames } from './foldFrames.js';
import { planFold } from './foldWrite.js';
import {
  formatJson,
  planMigration,
  prepareMigration,
  readMigration,
  writeMigration,
} from './migrate.js';
import { commitFiles, dataDiff, planFile } from './transaction.js';

const roots: string[] = [];
const owner: Permissions = { users: { '117818418': { login: 'StardustD2', role: 'maintainer' } } };
const tooltip: Tooltip = {
  hash: 10,
  text: { en: { text: 'authored', updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'author' } },
  associated: [],
};
const initial = { tooltips: [tooltip], permissions: owner, pushed: {} };
const legacy = {
  perks: {
    20: {
      hash: 20,
      name: 'Deleted',
      type: 'weaponPerk',
      editor: { en: { main: 'legacy', secondary: '' } },
    },
  },
  databaseSettings: { folders: {}, enhancedPerks: {} },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'clarity-safeguards-'));
  roots.push(root);
  await writeMigration(root, initial);
  return root;
}

async function inventory(root: string, prefix = ''): Promise<Record<string, unknown>> {
  const files: Record<string, unknown> = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) {
      files[path] = 'directory';
      Object.assign(files, await inventory(root, path));
    } else {
      files[path] = {
        bytes: (await readFile(join(root, path))).toString('base64'),
        mode: (await stat(join(root, path))).mode & 0o777,
      };
    }
  }
  return files;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('rerun safeguards', () => {
  it('diffs authored templates and every changed existing data file, refusing implicit overwrites', async () => {
    const root = await fixture();
    for (const file of [
      'README.md',
      join('.github', 'workflows', 'bundle.yml'),
      join('scripts', 'build-bundle.mjs'),
    ]) {
      await writeFile(join(root, file), `authored ${file}\r\n`);
    }
    await writeFile(join(root, 'other.txt'), 'unmanaged authored object');
    const before = await inventory(root);
    const next = { ...initial, tooltips: [{ ...tooltip, associated: [123] }] };
    const plan = await planMigration(root, next);
    expect(dataDiff(plan).map(({ operation }) => operation)).toEqual([
      'modify',
      'modify',
      'modify',
      'modify',
    ]);
    expect(dataDiff(plan).find(({ path }) => path === 'README.md')?.before).toBe(
      'authored README.md\r\n',
    );
    await expect(writeMigration(root, next)).rejects.toThrow('Authored files');
    expect(await inventory(root)).toEqual(before);
    await commitFiles(root, plan, { approvedPlan: dataDiff(plan) });
    expect(await readFile(join(root, 'other.txt'), 'utf8')).toBe('unmanaged authored object');
  });

  it('rolls back every injected mid-write failure, including additions, removals, modes and new directories', async () => {
    const root = await fixture();
    await chmod(join(root, 'tooltips', '10.json'), 0o600);
    await writeFile(join(root, 'unmanaged.txt'), 'keep');
    const before = await inventory(root);
    const plan = await planMigration(root, { ...initial, tooltips: [{ ...tooltip, hash: 30 }] });
    const newFile = await planFile(root, join('archive', 'nested', 'originals.json'), 'originals');
    if (!newFile) throw new Error('Missing addition plan');
    plan.push(newFile);
    for (let failAt = 1; failAt <= plan.length; failAt++) {
      await expect(
        commitFiles(root, plan, {
          allowAuthoredOverwrite: true,
          afterSwap: (count) => {
            if (count === failAt) throw new Error('injected mid-write failure');
          },
        }),
      ).rejects.toThrow('injected mid-write failure');
      expect(await inventory(root)).toEqual(before);
      expect(await readMigration(root)).toEqual(initial);
    }
  });

  it('rolls back the fold CLI transaction including conflict archives, canonical writes, markers and member deletions', async () => {
    const root = await fixture();
    const existing = {
      ...initial,
      tooltips: [
        { ...tooltip, text: { en: { ...tooltip.text.en!, text: '' } } },
        { ...tooltip, hash: 20 },
      ],
      pushed: { 10: 'a'.repeat(64), 20: 'b'.repeat(64) },
    };
    await writeMigration(root, existing, { allowAuthoredOverwrite: true });
    const before = await inventory(root);
    const result = foldFrames(
      existing.tooltips,
      { 20: { to: 10, kind: 'frame' } },
      existing.pushed,
      {},
    );
    const plan = await planFold(root, existing, result, join(root, 'archive', 'conflicts.md'), []);
    expect(
      plan.some(({ path, after }) => path === join('tooltips', '20.json') && after === null),
    ).toBe(true);
    for (let failAt = 1; failAt <= plan.length; failAt++) {
      await expect(
        commitFiles(root, plan, {
          approvedPlan: dataDiff(plan),
          afterSwap: (count) => {
            if (count === failAt) throw new Error('injected fold failure');
          },
        }),
      ).rejects.toThrow('injected fold failure');
      expect(await inventory(root)).toEqual(before);
    }
    await commitFiles(root, plan, { approvedPlan: dataDiff(plan) });
    expect((await readMigration(root))?.tooltips[0].text.en?.text).toBe('authored');
    expect(
      JSON.parse(await readFile(join(root, 'archive', 'conflicts.md.originals.json'), 'utf8')),
    ).toEqual(existing.tooltips);
    const stored = await readMigration(root);
    if (!stored) throw new Error('Missing folded output');
    const repeated = foldFrames(
      stored.tooltips,
      { 20: { to: 10, kind: 'frame' } },
      stored.pushed,
      {},
    );
    const repeatPlan = await planFold(
      root,
      stored,
      repeated,
      join(root, 'archive', 'conflicts.md'),
      [],
    );
    await commitFiles(root, repeatPlan, { approvedPlan: dataDiff(repeatPlan) });
    expect(
      JSON.parse(await readFile(join(root, 'archive', 'conflicts.md.originals.json'), 'utf8')),
    ).toHaveLength(3);
  });

  it('rejects stale exact approval and concurrent changes without overwriting them', async () => {
    const root = await fixture();
    const plan = await planMigration(root, {
      ...initial,
      tooltips: [{ ...tooltip, associated: [99] }],
    });
    await expect(commitFiles(root, plan, { approvedPlan: [] })).rejects.toThrow('Approved diff');
    await writeFile(join(root, 'tooltips', '10.json'), 'concurrent authored bytes');
    await expect(commitFiles(root, plan, { approvedPlan: dataDiff(plan) })).rejects.toThrow(
      'Concurrent change',
    );
    expect(await readFile(join(root, 'tooltips', '10.json'), 'utf8')).toBe(
      'concurrent authored bytes',
    );
  });

  it('requires reviewed deletion history, excludes deleted legacy hashes/markers, and permits exact explicit reimports', async () => {
    await expect(prepareMigration(legacy, legacy, owner, initial)).rejects.toThrow(
      'deletion history',
    );
    const next = await prepareMigration(legacy, legacy, owner, initial, [20]);
    expect(next.tooltips).toEqual(initial.tooltips);
    expect(next.pushed).toEqual({});
    expect(next.excluded).toEqual([20]);
    expect(excludedDeletions([20, 30], ['20'])).toEqual([30]);
    expect(() => excludedDeletions([20], ['30'])).toThrow('not in');
    expect(
      (
        await prepareMigration(legacy, legacy, owner, initial, excludedDeletions([20], ['20']))
      ).tooltips.map(({ hash }) => hash),
    ).toEqual([10, 20]);
    expect((await prepareMigration(legacy, legacy, owner, initial, [10])).tooltips[0]).toEqual(
      tooltip,
    );
  });

  it('reads real full git deletion history and will not resurrect a deleted fold canonical', async () => {
    const root = await fixture();
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    git('init', '--quiet');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'initial',
    );
    git('rm', '--quiet', 'tooltips/10.json');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'intentional deletion',
    );
    expect(await deletedHashes(root)).toEqual([10]);
    const existing = { ...initial, tooltips: [{ ...tooltip, hash: 20 }] };
    const result = foldFrames(existing.tooltips, { 20: { to: 10, kind: 'frame' } }, {}, {});
    await expect(
      planFold(root, existing, result, join(root, 'conflicts.md'), [10]),
    ).rejects.toThrow('intentionally deleted canonical 10');
    await mkdir(join(root, 'tooltips'));
    await writeFile(join(root, 'tooltips', '20.json'), formatJson({ ...tooltip, hash: 20 }));
    git('add', 'tooltips/20.json');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'add member',
    );
    git('mv', 'tooltips/20.json', 'tooltips/30.json');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'rename tooltip hash',
    );
    expect(await deletedHashes(root)).toEqual([10, 20]);
  }, 20000);

  it('real migration CLI defaults to dry run and applies only the exact reviewed plan', async () => {
    const root = await fixture();
    const inputs = await mkdtemp(join(tmpdir(), 'clarity-inputs-'));
    roots.push(inputs);
    for (const [name, value] of Object.entries({
      intermediate: legacy,
      live: legacy,
      owner: { id: 117818418, login: 'StardustD2' },
      deletions: [20],
    })) {
      await writeFile(join(inputs, `${name}.json`), formatJson(value));
    }
    await writeFile(join(root, 'README.md'), 'authored README');
    const before = await inventory(root);
    const args = [
      fileURLToPath(new URL('./node_modules/tsx/dist/cli.mjs', import.meta.url)),
      fileURLToPath(new URL('./cli.ts', import.meta.url)),
      '--output',
      root,
      '--intermediate',
      join(inputs, 'intermediate.json'),
      '--live',
      join(inputs, 'live.json'),
      '--owner',
      join(inputs, 'owner.json'),
      '--deletions',
      join(inputs, 'deletions.json'),
    ];
    const diff = join(inputs, 'diff.json');
    execFileSync(process.execPath, [...args, '--diff', diff], { encoding: 'utf8' });
    expect(await inventory(root)).toEqual(before);
    const refused = spawnSync(process.execPath, [...args, '--write'], { encoding: 'utf8' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('Authored files');
    expect(await inventory(root)).toEqual(before);
    execFileSync(process.execPath, [...args, '--write', '--approve', diff], { encoding: 'utf8' });
    expect((await readMigration(root))?.tooltips).toEqual(initial.tooltips);
    expect((await readdir(join(root, 'tooltips'))).includes('20.json')).toBe(false);
  }, 20000);

  it('real fold CLI emits its exact dry diff and refuses writes without explicit approval', async () => {
    const root = await fixture();
    const inputs = await mkdtemp(join(tmpdir(), 'clarity-fold-inputs-'));
    roots.push(inputs);
    await writeMigration(
      root,
      {
        ...initial,
        tooltips: [
          { ...tooltip, text: {} },
          { ...tooltip, hash: 20 },
        ],
      },
      { allowAuthoredOverwrite: true },
    );
    for (const [name, value] of Object.entries({
      aliases: { 20: { to: 10, kind: 'frame' } },
      items: {},
      deletions: [],
    })) {
      await writeFile(join(inputs, `${name}.json`), formatJson(value));
    }
    const before = await inventory(root);
    const args = [
      fileURLToPath(new URL('./node_modules/tsx/dist/cli.mjs', import.meta.url)),
      fileURLToPath(new URL('./foldFramesCli.ts', import.meta.url)),
      '--data',
      root,
      '--aliases',
      join(inputs, 'aliases.json'),
      '--items',
      join(inputs, 'items.json'),
      '--deletions',
      join(inputs, 'deletions.json'),
      '--conflicts',
      join(root, 'conflicts.md'),
    ];
    const diff = join(inputs, 'diff.json');
    const log = execFileSync(process.execPath, [...args, '--diff', diff], { encoding: 'utf8' });
    expect(JSON.parse(log).folded).toEqual([20]);
    expect(await inventory(root)).toEqual(before);
    expect(spawnSync(process.execPath, [...args, '--write'], { encoding: 'utf8' }).status).toBe(1);
    expect(await inventory(root)).toEqual(before);
    execFileSync(process.execPath, [...args, '--write', '--approve', diff], { encoding: 'utf8' });
    expect((await readMigration(root))?.tooltips).toHaveLength(1);
  }, 20000);
});
