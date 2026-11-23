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
import {
  compendiumDataSchema,
  isTrackedCompendiumTab,
  sandboxPointersSchema,
  sandboxConflictsSchema,
  inactiveMovesSchema,
  aliasGroupsSchema,
} from '../../packages/core/src/index.js';
import { withSandboxPicks, type EditorData } from '../../apps/web/src/stores/data.js';
import { displayMatches } from '../../apps/web/src/features/compendium/displayMatches.js';
import { reviewEvidence } from '../../apps/web/src/features/compendium/reviewQueue.js';
import { proposalFor } from '../../apps/web/src/features/compendium/rapidReview.js';
import { emptyProgress } from '../../apps/web/src/features/compendium/reviewProgress.js';
import { confirmCompendiumSelection } from '../../apps/web/src/features/compendium/selection.js';
import { presentCategories } from '../../apps/web/src/services/categoryLabels.js';
import approved from '../../apps/web/src/features/compendium/approved-guidance.v1.json';

const now = '2026-11-15T00:00:00Z';
const tooltip = (hash: number, text = 'English') => ({
  hash,
  associated: [],
  text: {
    en: { text, updatedBy: 'alice', updatedAt: now },
    de: { text: 'Deutsch', updatedBy: 'bob', updatedAt: now, sourceUpdatedAt: now },
  },
});
const fixtureItem = (hash: number) =>
  Object.values(fixture.items).find((item) => item.hash === hash)!;
function input(): Inputs {
  return {
    editorHead: 'a'.repeat(40),
    engineCommit: 'b'.repeat(40),
    catalogCommit: 'c'.repeat(40),
    compendiumCommit: 'd'.repeat(40),
    snapshotAt: now,
    categoriesJson: JSON.stringify([
      { id: 'armor-set-bonus', label: 'Armor Set Bonuses', group: 'Armor', order: 1 },
    ]),
    inactiveJson: null,
    aliasGroupsJson: null,
    sandboxPointersJson: null,
    sandboxConflictsJson: null,
    itemsJson: JSON.stringify(
      Object.fromEntries(
        [17188252, 17188253, 109046536, 109046537, 219133236, 219133237, 446332292].map((hash) => [
          hash,
          {
            ...fixtureItem(hash),
            hash,
            name: hash === 219133236 ? 'Unknown' : fixtureItem(hash).name,
          },
        ]),
      ),
    ),
    aliasesJson: JSON.stringify({ 109046536: { to: 17188253, kind: 'name' } }),
    compendiumJson: JSON.stringify(fixture.source),
    files: {
      'tooltips/17188252.json': bytes(tooltip(17188252)),
      'tooltips/17188253.json': bytes({
        ...tooltip(17188253),
        compendium: {
          gid: '999',
          rowKey: 'Deleted',
          snapshotAt: now,
          snapshot: { plain: 'Human', runs: [{ text: 'Human' }] },
        },
      }),
      'tooltips/109046537.json': bytes({ hash: 109046537, text: {}, associated: [] }),
      'tooltips/219133237.json': bytes({
        ...tooltip(219133237),
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
      this.state.files['tooltips/17188252.json'] = bytes(tooltip(17188252, 'Concurrent'));
    if (this.crashAfterCommit) {
      this.crashAfterCommit = false;
      throw new Error('Connection lost');
    }
    return true;
  }
}
const apply = (store: Store, manifest: Manifest, original?: Manifest) =>
  applyApproved(store, manifest, digest(bytes(manifest)), backup(manifest), original);

// Independent web-app setup: compare the planner with actual displayed keys AND payloads.
function shown(data: Inputs) {
  const source = compendiumDataSchema.parse(JSON.parse(data.compendiumJson));
  source.tabs = source.tabs.filter((tab) => isTrackedCompendiumTab(tab.name));
  const editor = withSandboxPicks(
    {
      items: JSON.parse(data.itemsJson),
      categories: presentCategories(JSON.parse(data.categoriesJson)),
      aliases: JSON.parse(data.aliasesJson),
      bundle: {
        sourceCommit: data.editorHead,
        generatedAt: data.snapshotAt,
        permissions: { users: {} },
        pushed: {},
        tooltips: Object.fromEntries(
          Object.values(data.files).map((raw) => {
            const t = JSON.parse(raw);
            return [t.hash, t];
          }),
        ),
        inactiveMoves:
          data.inactiveJson === null
            ? {}
            : inactiveMovesSchema.parse(JSON.parse(data.inactiveJson)),
        aliasGroups:
          data.aliasGroupsJson === null
            ? undefined
            : aliasGroupsSchema.parse(JSON.parse(data.aliasGroupsJson)),
      },
    } as EditorData,
    data.sandboxPointersJson === null
      ? undefined
      : sandboxPointersSchema.parse(JSON.parse(data.sandboxPointersJson)),
    data.sandboxConflictsJson === null
      ? undefined
      : sandboxConflictsSchema.parse(JSON.parse(data.sandboxConflictsJson)),
  );
  const proposals = new Map(
    reviewEvidence(editor, source, {}, '').map((entry) => [
      entry.hash,
      proposalFor(entry.base, editor, source),
    ]),
  );
  const result = displayMatches(
    editor,
    source,
    {},
    emptyProgress(),
    undefined,
    approved.scope,
    proposals,
  );
  const links = new Map(
    [...result.matches].map(([hash, match]) => [
      hash,
      { ...confirmCompendiumSelection(match, source)!, snapshotAt: data.snapshotAt },
    ]),
  );
  return { editor, result, links };
}

it('persists exactly the shared displayed set and confirmation payload, never unresolved or medium decisions', () => {
  const data = {
    ...input(),
    itemsJson: JSON.stringify(fixture.items),
    aliasesJson: '{}',
    files: {},
  };
  const display = shown(data);
  const m = plan(data);
  const persisted = new Map(
    m.changes.map((row) => {
      const t = JSON.parse(row.after!);
      return [t.hash, t.compendium];
    }),
  );
  expect(display.links.size).toBeGreaterThan(100);
  expect([...persisted.keys()].filter((hash) => !display.links.has(hash))).toEqual([]);
  expect([...display.links.keys()].filter((hash) => !persisted.has(hash))).toEqual([]);
  expect(
    [...display.links.keys()].filter(
      (hash) => bytes(persisted.get(hash)) !== bytes(display.links.get(hash)),
    ),
  ).toEqual([]);
  for (const decision of display.result.decisions.filter(
    (d) => d.action === 'owner' || d.confidence === 'medium',
  ))
    expect(persisted.has(decision.hash)).toBe(false);
  const hash = [...display.links.keys()][0];
  const moved = { ...data, inactiveJson: JSON.stringify({ [hash]: { by: 1, at: now } }) };
  expect(plan(moved).changes.some((row) => row.path === `tooltips/${hash}.json`)).toBe(false);
});

it('uses the app sandbox-pick aliases, pins picks and conflicts, and leaves absent/no-target picks unchanged', () => {
  const data = { ...input(), aliasesJson: '{}' };
  const plain = plan(data);
  expect(plain.changes.some((row) => row.path === 'tooltips/109046536.json')).toBe(true);
  const picked = {
    ...data,
    sandboxPointersJson: JSON.stringify({
      version: 1,
      pointers: {
        109046536: { to: 17188252, candidates: [17188252, 109046537], by: 1, at: now },
      },
    }),
    sandboxConflictsJson: JSON.stringify({ 109046536: [17188252, 109046537] }),
  };
  const actual = plan(picked);
  expect(shown(picked).editor.aliases[109046536]).toEqual({ to: 17188252, kind: 'sandbox' });
  expect(actual.changes.some((row) => row.path === 'tooltips/109046536.json')).toBe(false);
  expect(actual.rows.find((row) => row.hash === 109046536)?.reason).toBe('alias');
  expect(
    actual.changes.map((row) => Number(/\d+/.exec(row.path)![0])).sort((a, b) => a - b),
  ).toEqual([...shown(picked).links.keys()].sort((a, b) => a - b));
  expect(actual.pins.sandboxPointersSha256).toBe(digest(picked.sandboxPointersJson));
  expect(() => plan({ ...picked, sandboxConflictsJson: null })).toThrow(/conflicts/);
  for (const pointer of [
    { none: true, candidates: [17188252, 109046537], by: 1, at: now },
    { state: 'undone', by: 1, at: now },
  ]) {
    expect(
      plan({
        ...data,
        sandboxPointersJson: JSON.stringify({ version: 1, pointers: { 109046536: pointer } }),
      }).changes,
    ).toEqual(plain.changes);
  }
});

it('uses the app’s accepted alias groups, pins exact bytes, and verifies the rebuilt bundle', async () => {
  const data = input();
  const items = JSON.parse(data.itemsJson);
  const basis = { name: 'Same Trait', categoryId: 'weapon-trait' };
  for (const hash of [17188252, 109046537])
    items[hash] = { ...items[hash], ...basis, plugCategoryHash: 1 };
  data.itemsJson = JSON.stringify(items);
  const aliasGroups = aliasGroupsSchema.parse({
    version: 1,
    groups: {
      17188252: {
        members: [17188252, 109046537],
        kind: 'S',
        basis,
        by: { id: '1', login: 'alice' },
        at: now,
      },
    },
    rejected: {},
  });
  data.aliasGroupsJson = JSON.stringify(aliasGroups);
  expect(() => plan(data)).toThrow(/conflicts/);
  data.sandboxConflictsJson = '{}';
  const m = plan(data);
  expect(shown(data).editor.aliases[109046537]).toEqual({ to: 17188252, kind: 'name' });
  expect(m.rows.find((row) => row.hash === 109046537)?.reason).toBe('alias');
  expect(m.changes.some((row) => row.path === 'tooltips/109046537.json')).toBe(false);
  expect(m.pins.aliasGroupsSha256).toBe(digest(data.aliasGroupsJson));
  const store = new MemoryStore({ ...data, aliasGroupsJson: data.aliasGroupsJson + '\n' });
  await expect(apply(store, m)).rejects.toThrow(/Stale source pins/);
  expect(store.calls).toBe(0);
  store.state = data;
  await apply(store, m);
  const bundle = {
    sourceCommit: store.state.editorHead,
    tooltips: shown(store.state).editor.bundle.tooltips,
  };
  expect(() => verifyBundle(m, store.state, bundle)).toThrow(/alias groups mismatch/);
  verifyBundle(m, store.state, { ...bundle, aliasGroups });
});

it('plans all catalog rows, preserves human links, and changes only compendium metadata', () => {
  const data = input();
  const m = plan(data);
  expect(m.changes.map((c) => c.path)).toEqual([
    'tooltips/17188252.json',
    'tooltips/109046537.json',
    'tooltips/446332292.json',
  ]);
  expect(
    m.rows.filter((r) =>
      ['preserved', 'alias', 'unknown', 'unresolved', 'archived'].includes(r.reason),
    ),
  ).toEqual(
    expect.arrayContaining([
      { hash: 17188253, reason: 'preserved', linkOnly: false },
      { hash: 109046536, reason: 'alias', linkOnly: true },
      { hash: 219133236, reason: 'unresolved', linkOnly: true },
      { hash: 219133237, reason: 'archived', linkOnly: false },
      { hash: 99, reason: 'unknown', linkOnly: false },
    ]),
  );
  for (const row of m.changes) {
    const { compendium, ...rest } = JSON.parse(row.after!);
    expect(compendium.snapshotAt).toBe(now);
    expect(rest).toEqual(
      row.before === null ? { hash: 446332292, text: {}, associated: [] } : JSON.parse(row.before),
    );
  }
  expect(backup(m).files['tooltips/446332292.json']).toBeNull();
  expect(
    bytes(plan({ ...data, files: Object.fromEntries(Object.entries(data.files).reverse()) })),
  ).toBe(bytes(m));
});
it('skips ambiguous, similarity-only, alias cycles, and invalid filename inputs', () => {
  const data = input();
  const source = JSON.parse(data.compendiumJson);
  for (const tab of source.tabs) tab.rows.push(...structuredClone(tab.rows));
  data.compendiumJson = JSON.stringify(source);
  expect(plan(data).changes).toHaveLength(0);
  expect(plan(data).rows.find((r) => r.hash === 17188252)?.reason).toBe('unresolved');
  expect(() =>
    plan({
      ...input(),
      aliasesJson:
        '{"17188252":{"to":109046536,"kind":"name"},"109046536":{"to":17188252,"kind":"name"}}',
    }),
  ).toThrow(/Cyclic/);
  expect(() =>
    plan({ ...input(), files: { '../17188252.json': bytes(tooltip(17188252)) } }),
  ).toThrow(/path/);
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
  const linkedOnly = [tooltips[109046537], tooltips[446332292]] as Tooltip[];
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
      i.categoriesJson += ' ';
    },
    (i: Inputs) => {
      i.inactiveJson = '{}';
    },
    (i: Inputs) => {
      i.sandboxPointersJson = '{"version":1,"pointers":{}}';
    },
    (i: Inputs) => {
      i.sandboxConflictsJson = '{}';
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
  forged.changes[0].after = bytes(tooltip(17188252, 'Forged'));
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
  expect(JSON.parse(store.state.files['tooltips/17188252.json']).text.en.text).toBe('Concurrent');
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
  expect(m.rows.some((r) => r.reason !== 'linked')).toBe(true);
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
