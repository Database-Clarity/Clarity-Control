import { expect, it } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { gunzipSync } from 'node:zlib';
import {
  applyApproved,
  backup,
  bytes,
  digest,
  plan,
  planRollback,
  verifyBundle,
  type Inputs,
  type Store,
  type Change,
  type Manifest,
} from './confident-links.js';
import { exportLegacy } from '../../packages/core/src/exportLegacy.js';
import { type Tooltip } from '../../packages/core/src/schemas.js';
import fixture from '../../apps/web/src/features/compendium/fixtures/compendium-links.json';

const now = '2026-11-15T00:00:00Z';
const tooltip = (hash: number, text = 'English') => ({
  hash,
  associated: [],
  text: {
    en: { text, updatedBy: 'alice', updatedAt: now },
    de: { text: 'Deutsch', updatedBy: 'bob', updatedAt: now, sourceUpdatedAt: now },
  },
});
function input(): Inputs {
  return {
    editorHead: 'a'.repeat(40),
    engineCommit: 'b'.repeat(40),
    catalogCommit: 'c'.repeat(40),
    compendiumCommit: 'd'.repeat(40),
    snapshotAt: now,
    itemsJson: JSON.stringify(
      Object.fromEntries(
        [10, 11, 12, 13, 14, 15, 16].map((hash) => [
          hash,
          {
            hash,
            name: hash === 14 ? 'Unknown' : 'Intrinsic name',
            categoryId: 'weapon-trait-exotic',
          },
        ]),
      ),
    ),
    aliasesJson: JSON.stringify({ 12: { to: 10, kind: 'name' } }),
    compendiumJson: JSON.stringify({
      fetchedAt: now,
      tabs: [
        {
          gid: '441434520',
          name: 'Exotic Weapons',
          rows: [
            {
              name: 'Intrinsic name',
              nameNorm: 'intrinsic name',
              rowIndex: 6,
              cell: { plain: 'Source', runs: [{ text: 'Source' }] },
            },
          ],
        },
      ],
    }),
    files: {
      'tooltips/10.json': bytes(tooltip(10)),
      'tooltips/11.json': bytes({
        ...tooltip(11),
        compendium: {
          gid: '999',
          rowKey: 'Deleted',
          snapshotAt: now,
          snapshot: { plain: 'Human', runs: [{ text: 'Human' }] },
        },
      }),
      'tooltips/13.json': bytes({ hash: 13, text: {}, associated: [] }),
      'tooltips/15.json': bytes({
        ...tooltip(15),
        archive: {
          removedAt: now,
          lastSeen: { name: 'Old', categoryId: 'weapon-trait', manifestVersion: 'v' },
        },
      }),
      'tooltips/99.json': bytes(tooltip(99)),
    },
  };
}
class MemoryStore implements Store {
  calls = 0;
  conflict = false;
  crashAfterCommit = false;
  corruptAfterCommit = false;
  constructor(public state = input()) {}
  async read() {
    return structuredClone(this.state);
  }
  async compareAndSwap(expected: Inputs, changes: readonly Change[]) {
    this.calls++;
    if (this.conflict || bytes(expected) !== bytes(this.state)) return false;
    const next = structuredClone(this.state);
    for (const row of changes) {
      if (row.after === null) delete next.files[row.path];
      else next.files[row.path] = row.after;
    }
    next.editorHead = 'e'.repeat(40);
    this.state = next;
    if (this.corruptAfterCommit)
      this.state.files['tooltips/10.json'] = bytes(tooltip(10, 'Concurrent'));
    if (this.crashAfterCommit) {
      this.crashAfterCommit = false;
      throw new Error('Connection lost');
    }
    return true;
  }
}
const apply = (store: Store, manifest: Manifest, original?: Manifest) =>
  applyApproved(store, manifest, digest(bytes(manifest)), backup(manifest), original);

it('plans all catalog rows, preserves human links, and changes only compendium metadata', () => {
  const data = input();
  const m = plan(data);
  expect(m.changes.map((c) => c.path)).toEqual([
    'tooltips/10.json',
    'tooltips/13.json',
    'tooltips/16.json',
  ]);
  expect(
    m.rows.filter((r) =>
      ['preserved', 'alias', 'unknown', 'unmatched', 'archived'].includes(r.reason),
    ),
  ).toEqual(
    expect.arrayContaining([
      { hash: 11, reason: 'preserved', linkOnly: false },
      { hash: 12, reason: 'alias', linkOnly: true },
      { hash: 14, reason: 'unmatched', linkOnly: true },
      { hash: 15, reason: 'archived', linkOnly: false },
      { hash: 99, reason: 'unknown', linkOnly: false },
    ]),
  );
  for (const row of m.changes) {
    const { compendium, ...rest } = JSON.parse(row.after!);
    expect(compendium.snapshotAt).toBe(now);
    expect(rest).toEqual(
      row.before === null ? { hash: 16, text: {}, associated: [] } : JSON.parse(row.before),
    );
  }
  expect(backup(m).files['tooltips/16.json']).toBeNull();
  expect(
    bytes(plan({ ...data, files: Object.fromEntries(Object.entries(data.files).reverse()) })),
  ).toBe(bytes(m));
});
it('skips ambiguous, similarity-only, alias cycles, and invalid filename inputs', () => {
  const data = input();
  const source = JSON.parse(data.compendiumJson);
  source.tabs[0].rows.push(structuredClone(source.tabs[0].rows[0]));
  data.compendiumJson = JSON.stringify(source);
  expect(plan(data).changes).toHaveLength(0);
  expect(plan(data).rows.find((r) => r.hash === 10)?.reason).toBe('ambiguous');
  expect(() =>
    plan({
      ...input(),
      aliasesJson: '{"10":{"to":12,"kind":"name"},"12":{"to":10,"kind":"name"}}',
    }),
  ).toThrow(/Cyclic/);
  expect(() => plan({ ...input(), files: { '../10.json': bytes(tooltip(10)) } })).toThrow(/path/);
});
it('persists all matches on first upload regardless of selection, verifies bundle, and replays once', async () => {
  const store = new MemoryStore();
  const m = plan(store.state);
  expect((await apply(store, m)).status).toBe('applied');
  expect((await apply(store, m)).status).toBe('noop');
  expect(store.calls).toBe(1);
  expect(plan(store.state).changes).toHaveLength(0);
  const tooltips = Object.fromEntries(
    Object.values(store.state.files).map((raw) => {
      const t = JSON.parse(raw);
      return [t.hash, t];
    }),
  );
  verifyBundle(m, store.state, { sourceCommit: store.state.editorHead, tooltips });
  expect(() => verifyBundle(m, store.state, { sourceCommit: m.editorHead, tooltips })).toThrow(
    /head/,
  );
  expect(() =>
    verifyBundle(m, store.state, { sourceCommit: store.state.editorHead, tooltips: {} }),
  ).toThrow(/tooltips/);
  const linkedOnly = [tooltips[13], tooltips[16]] as Tooltip[];
  expect(exportLegacy(linkedOnly, Date.parse(now))).toEqual({});
});
it('reconciles a crash after the atomic commit without writing twice', async () => {
  const store = new MemoryStore();
  const m = plan(store.state);
  store.crashAfterCommit = true;
  await expect(apply(store, m)).rejects.toThrow(/Connection/);
  expect((await apply(store, m)).status).toBe('noop');
  expect(store.calls).toBe(1);
});
it('requires exact approval, backup, pins, inventory, and head before invoking CAS', async () => {
  const data = input();
  const m = plan(data);
  const store = new MemoryStore();
  await expect(applyApproved(store, m, '', backup(m))).rejects.toThrow(/approved/);
  await expect(
    applyApproved(store, m, digest(bytes(m)), { ...backup(m), files: {} }),
  ).rejects.toThrow(/Backup/);
  for (const mutate of [
    (i: Inputs) => {
      i.editorHead = 'f'.repeat(40);
    },
    (i: Inputs) => {
      i.aliasesJson += ' ';
    },
    (i: Inputs) => {
      i.itemsJson += ' ';
    },
    (i: Inputs) => {
      i.compendiumJson += ' ';
    },
    (i: Inputs) => {
      i.engineCommit = 'f'.repeat(40);
    },
    (i: Inputs) => {
      i.files['tooltips/99.json'] = bytes(tooltip(99, 'New'));
    },
  ]) {
    const changed = new MemoryStore();
    mutate(changed.state);
    await expect(apply(changed, m)).rejects.toThrow();
    expect(changed.calls).toBe(0);
  }
  expect(store.calls).toBe(0);
  const forged = structuredClone(m);
  forged.changes[0].after = bytes(tooltip(10, 'Forged'));
  await expect(apply(store, forged)).rejects.toThrow(/plan/);
  expect(store.calls).toBe(0);
});
it('rejects concurrent CAS conflicts and fails persisted verification without undoing edits', async () => {
  const store = new MemoryStore();
  const m = plan(store.state);
  store.conflict = true;
  await expect(apply(store, m)).rejects.toThrow(/conflict/);
  expect(store.state).toEqual(input());
  store.conflict = false;
  store.corruptAfterCommit = true;
  await expect(apply(store, m)).rejects.toThrow(/Persisted/);
  expect(JSON.parse(store.state.files['tooltips/10.json']).text.en.text).toBe('Concurrent');
});
it('requires separate approval for forward rollback, restores absent files, and rejects intervening edits', async () => {
  const store = new MemoryStore();
  const original = structuredClone(store.state);
  const m = plan(original);
  await apply(store, m);
  const rollback = planRollback(m, store.state);
  await expect(
    applyApproved(store, rollback, digest(bytes(m)), backup(rollback), m),
  ).rejects.toThrow(/approved/);
  await apply(store, rollback, m);
  expect(store.state.files).toEqual(original.files);
  expect((await apply(store, rollback, m)).status).toBe('noop');
  const other = new MemoryStore();
  await apply(other, m);
  other.state.files['tooltips/99.json'] = bytes(tooltip(99, 'Changed'));
  expect(() => planRollback(m, other.state)).toThrow(/after-images/);
});
it('runs the real fixture census, including multipart and set-bonus matching', () => {
  const data = {
    ...input(),
    itemsJson: JSON.stringify(fixture.items),
    compendiumJson: JSON.stringify(fixture.source),
    aliasesJson: '{}',
    files: {},
  };
  const m = plan(data);
  expect(m.changes.length).toBeGreaterThan(100);
  expect(m.rows.some((r) => r.reason === 'unmatched')).toBe(true);
  for (const c of m.changes) expect(JSON.parse(c.after!).compendium.snapshot.plain).not.toBe('');
});
it('rejects the stripped export catalog fixture instead of guessing resolver names', () => {
  const catalog = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL('../../packages/export/test/fixtures/catalog-c3fed8c.json.gz', import.meta.url),
      ),
    ).toString(),
  );
  expect(() =>
    plan({
      ...input(),
      itemsJson: JSON.stringify(catalog.items),
      compendiumJson: JSON.stringify(fixture.source),
      aliasesJson: '{}',
      files: {},
    }),
  ).toThrow();
});

it('keeps bundled S2 imports inert and runs the dry-run CLI only when explicitly invoked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'confident-links-test-'));
  const library = fileURLToPath(new URL('./confident-links.ts', import.meta.url));
  try {
    const host = join(dir, 'host.mjs');
    await build({
      stdin: {
        contents: `import { plan } from ${JSON.stringify(library)};
      console.log('S2_IMPORT_ONLY', typeof plan);`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      outfile: host,
    });
    for (const args of [[], ['--pipeline-dry-run']]) {
      const result = spawnSync(process.execPath, [host, ...args], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('S2_IMPORT_ONLY function');
      expect(result.stderr).toBe('');
    }
    const cli = join(dir, 'cli.mjs');
    await build({
      entryPoints: [library],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      outfile: cli,
    });
    const source = input();
    const inputFile = join(dir, 'input.json');
    const out = join(dir, 'candidate');
    writeFileSync(inputFile, JSON.stringify(source));
    // Exactly the explicit launcher documented in the runbook.
    const args = [
      '--input-type=module',
      '-e',
      'import(process.argv[1]).then(m => m.runCli(process.argv.slice(2)))',
      pathToFileURL(cli).href,
      '--input',
      inputFile,
      '--out',
      out,
    ];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(readFileSync(join(out, 'manifest.json'), 'utf8')).toBe(bytes(plan(source)));
    expect(readFileSync(join(out, 'backup.json'), 'utf8')).toBe(bytes(backup(plan(source))));
    expect(spawnSync(process.execPath, args, { encoding: 'utf8' }).status).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
