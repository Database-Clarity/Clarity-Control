import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appCredits, LocalRepository, type Tree } from '../publisher/git.js';
import type { MigrationInputs } from '../publisher/globalsMigration.js';
import { Publisher, type Options } from '../publisher/publisher.js';
import { planRemoval } from './retired-frames.js';

const D = 'refs/heads/editor-data';
const L = 'refs/heads/converter-v2-test';
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

const text = (value: string) => ({
  en: { text: value, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: '' },
});
const tooltip = (hash: number, value: string, associated: number[] = []) => ({
  hash,
  text: text(value),
  associated,
});
const row = (hash: number, main: string, extra: object = {}) => ({
  hash,
  name: `Row ${hash}`,
  type: 'Weapon Frame',
  ...extra,
  editor: { en: { main, secondary: main } },
  uploadedBy: '',
  lastUpload: 1,
  inLiveDatabase: false,
  uploadToLive: false,
  updateTracker: { descriptions: { en: { lastUpdate: 0 } } },
});
const item = (hash: number, categoryId: string, exotic?: true) => ({
  hash,
  name: `Row ${hash}`,
  categoryId,
  inGameDescription: '',
  ...(exotic ? { exotic } : {}),
});
type Files = Record<string, unknown>;

/** 500 is an emptied canonical frame, 501 its grouped member, 600 a frame with text, 700 a trait. */
function fixture(change: { data?: Files; perks?: Files; live?: Files; items?: Files } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'retired-frames-test-'));
  roots.push(root);
  execFileSync('git', ['init', '--quiet', '--bare', root]);
  execFileSync('git', ['--git-dir', root, 'config', 'publisher.simulator', 'true']);
  const git = new LocalRepository(root);
  const write = (ref: string, files: Files) => {
    const tree: Tree = Object.fromEntries(
      Object.entries(files).map(([path, value]) => [path, git.writeBlob(json(value))]),
    );
    git.cas(ref, undefined, git.commit(undefined, tree, 'Fixture', appCredits));
  };
  const items: Files = {
    500: item(500, 'weapon-frame'),
    501: item(501, 'weapon-frame-enhanced'),
    600: item(600, 'weapon-frame'),
    700: item(700, 'weapon-trait'),
    ...change.items,
  };
  write(D, {
    'live/pushed.json': { 600: 'a'.repeat(64) },
    'live/tooltips/500.json': tooltip(500, 'Old frame'),
    'live/tooltips/501.json': tooltip(501, 'Old member'),
    'tooltips/500.json': tooltip(500, ''),
    'tooltips/600.json': tooltip(600, 'Kept frame'),
    'tooltips/700.json': tooltip(700, 'Trait'),
    ...change.data,
  });
  write(L, {
    'liveDescriptions.json': {
      perks: {
        ...Object.fromEntries([1, 2, 3].map((hash) => [hash, { ...row(hash, ''), editor: {} }])),
        500: row(500, 'Old frame'),
        501: row(501, 'Old member'),
        600: row(600, 'Kept frame'),
        700: row(700, 'Trait'),
        ...change.perks,
      },
      databaseSettings: { folders: {} },
    },
    ...change.live,
  });
  const options = {
    repo: 'Database-Clarity/Live-Clarity-Database',
    dataBranch: 'editor-data',
    liveBranch: 'converter-v2-test',
    generatorSha: 'b'.repeat(40),
    aliases: { 501: { to: 500, kind: 'frame' } },
    facts: Object.fromEntries(
      Object.keys(items).map((hash) => [hash, { name: `Row ${hash}`, type: 'Weapon Frame' }]),
    ),
    aliasFacts: { generatorSha: 'b'.repeat(40), items },
    now: () => Date.parse('2026-11-25T00:00:00Z'),
  } as unknown as Options;
  const inputs = {
    catalog: {
      items: Object.fromEntries(
        Object.keys(items).map((hash) => [hash, { categoryId: 'weapon-frame' }]),
      ),
      categories: [{ id: 'weapon-frame' }],
    },
    inventoryItems: { 501: { displayProperties: { description: 'Old member' } } },
    sandboxPerks: {},
  } as unknown as MigrationInputs;
  const plan = () => planRemoval(new Publisher(git, options), inputs, [500, 501]);
  return { git, plan };
}

describe('retired frame removal', () => {
  it('plans one LIVE commit without the rows and one RECORD that keeps every snapshot', () => {
    const { git, plan } = fixture();
    const data = git.head(D)!;
    const live = git.head(L)!;
    const expected = JSON.parse(git.blob(git.tree(live)['liveDescriptions.json']));
    delete expected.perks[500];
    delete expected.perks[501];
    const result = plan();
    expect(result.removed.map(({ hash }) => hash)).toEqual([500, 501]);
    // 501 equals Bungie's description, which only some outputs repeat.
    expect(result.lost).toMatchObject({ dim: ['500'], crayon: ['500', '501'] });
    expect(git.commitParents(git.head(L)!)).toEqual([live]);
    expect(git.commitParents(git.head(D)!)).toEqual([data]);
    expect(git.blob(git.tree(git.head(L)!)['liveDescriptions.json'])).toBe(json(expected));
    const {
      [Object.keys(git.tree(git.head(D)!)).find((path) => !git.tree(data)[path])!]: log,
      ...rest
    } = git.tree(git.head(D)!);
    expect(rest).toEqual(git.tree(data));
    expect(JSON.parse(git.blob(log))).toMatchObject({
      liveCommit: git.head(L),
      result: { message: 'Remove 2 retired legendary frame texts (owner approved)' },
    });
  });

  it.each<[string, Parameters<typeof fixture>[0], string]>([
    ['an exotic', { items: { 501: item(501, 'weapon-frame', true) } }, 'not a legendary'],
    ['another category', { items: { 501: item(501, 'weapon-trait') } }, 'not a legendary'],
    [
      'canonical text',
      { data: { 'tooltips/500.json': tooltip(500, 'New') } },
      'missing":[500,501]',
    ],
    [
      'text in another language',
      {
        data: {
          'tooltips/500.json': {
            ...tooltip(500, ''),
            text: { ...text(''), de: text('Neu').en },
          },
        },
      },
      'editor text',
    ],
    ['a marker', { data: { 'live/pushed.json': { 501: 'a'.repeat(64) } } }, 'publication marker'],
    [
      'a stub that needs the row',
      { perks: { 800: { hash: 800, aliasOf: 501, aliasKind: 'frame' } } },
      'named by LIVE 800',
    ],
    [
      'a LIVE association',
      { perks: { 700: row(700, 'Trait', { associated: [501] }) } },
      'named by LIVE 700',
    ],
    [
      'an editor import of a grouped member',
      { data: { 'tooltips/700.json': tooltip(700, 'import Old from (501)') } },
      'named by tooltip 700',
    ],
    [
      'batch text',
      { data: { 'schedule/batches/x/tooltips/501.json': tooltip(501, 'Batch') } },
      'batch text',
    ],
    [
      'an unapproved row',
      { perks: { 502: row(502, 'Old') }, items: { 502: item(502, 'weapon-frame') } },
      'unapproved":[502]',
    ],
    [
      'a queued request',
      { data: { 'publish/requests/01M89FS7CXACKP7X0BXT3PAQ1P.json': {} } },
      'Drain',
    ],
    ['an unrecorded receipt', { live: { '.publish/receipts/2026-11/x.json': {} } }, 'Drain'],
  ])('refuses %s without writing', (_, change, message) => {
    const { git, plan } = fixture(change);
    const heads = [git.head(D), git.head(L)];
    expect(plan).toThrow(message);
    expect([git.head(D), git.head(L)]).toEqual(heads);
  });

  it('refuses a publish candidate and a save that lands while planning', () => {
    const { git, plan } = fixture();
    const candidate = 'refs/heads/publish-candidate/01M89FS7CXACKP7X0BXT3PAQ1P';
    git.cas(candidate, undefined, git.head(L)!);
    expect(plan).toThrow('Drain');
    git.cas(candidate, git.head(L)!, undefined);
    const data = git.head(D)!;
    const moved = git.commit(data, git.tree(data), 'Concurrent save', appCredits);
    const commit = git.commit.bind(git);
    git.commit = (...args) => {
      const next = commit(...args);
      if (git.head(D) === data) git.cas(D, data, moved);
      return next;
    };
    expect(plan).toThrow('Atomic publication raced');
    expect(git.head(D)).toBe(moved);
  });
});
