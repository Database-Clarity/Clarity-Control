import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { bootstrapFiles, json, sha256 } from './bootstrap-model.js';
import { legacyGlobalsCensus, legacySnapshot } from './census.js';
import { main } from './bootstrap.js';
import type { Tooltip } from '../../packages/core/src/schemas.js';
import {
  changedGlobalIds,
  planGlobalRelease,
} from '../../packages/core/src/globalsRelease/index.js';
import { exportLegacy } from '../../packages/core/src/exportLegacy.js';
import { projectGlobals } from '../../packages/core/src/globals/projection.js';

const tooltip = (hash: number, text: string): Tooltip => ({
  hash,
  associated: [],
  custom: { name: String(hash), categoryId: 'Test' },
  text: { en: { text, updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'alice' } },
});
const documents = () =>
  Object.fromEntries(
    [
      tooltip(1, 'export hidden Keep (\nText\n)'),
      tooltip(2, '// preserve\r\nvar e = ➜\r\nvar Empty = empty\r\nvar Damage = 10  \r\n'),
      tooltip(3, 'title Info (\n#Damage\n)\n'),
      tooltip(40, '#Damage'),
    ].map((v) => [v.hash, v]),
  );
const inventory = (docs = documents(), revision = 'saved') => ({
  documents: docs,
  source: {
    repository: 'owner/data',
    revision,
    locate: (hash: 1 | 2 | 3, lang: string) => ({
      path: `tooltips/${hash}.json`,
      selector: ['text', lang, 'text'],
    }),
  },
});

it('adds only exports to installed stores and refuses existing identity/projection drift', () => {
  const docs = documents();
  docs[1].text.en!.text =
    'export anti_barrier (\nBarrier\n)\nexport overload (\nOverload\n)\nexport unstoppable (\nUnstoppable\n)';
  const saved = inventory(docs),
    live = inventory(structuredClone(docs), 'published');
  const original = bootstrapFiles(saved, live, 'test');
  const existing = { saved: original.savedStore, published: original.liveStore };
  const result = bootstrapFiles(saved, live, 'test', {}, existing);
  expect(result.savedStore.entries.slice(0, existing.saved.entries.length)).toEqual(
    existing.saved.entries,
  );
  expect(result.liveStore.entries.slice(0, existing.published.entries.length)).toEqual(
    existing.published.entries,
  );
  expect(result.savedStore.entries.filter((entry) => entry.kind === 'exports')).toHaveLength(3);
  expect(projectGlobals(result.savedStore)).toEqual({ 1: docs[1], 2: docs[2], 3: docs[3] });
  expect(changedGlobalIds(result.liveStore, result.savedStore)).toEqual([]);
  expect(result.files['globals/sync.json']).toBeUndefined();
  for (const entry of existing.saved.entries)
    expect(result.files[`globals/entries/${entry.id}.json`]).toBeUndefined();
  const drift = { ...saved, documents: structuredClone(saved.documents) };
  drift.documents[2].text.en!.text += '\nvar Added = 1';
  expect(() => bootstrapFiles(drift, live, 'test', {}, existing)).toThrow('identity/projection');
});

it('preserves recipes, absence, empty values, #e, and stable IDs across independent inventories', async () => {
  const saved = inventory(),
    live = inventory(documents(), 'published');
  const result = bootstrapFiles(saved, live, 'converter-v2-test');
  expect(projectGlobals(result.savedStore)).toEqual({
    2: saved.documents[2],
    3: saved.documents[3],
  });
  expect(result.savedStore.entries.find((v) => v.name === 'Empty')!.definitions.en!.body).toBe('');
  expect(result.savedStore.entries.every((v) => v.definitions.de === undefined)).toBe(true);
  expect(result.liveStore.entries).toEqual(result.savedStore.entries);
  expect(result.identityEvidence.every((v) => v.shared)).toBe(true);
  expect(changedGlobalIds(result.liveStore, result.savedStore)).toEqual([]);
  expect(bootstrapFiles(saved, live, 'converter-v2-test', result.ids).files).toEqual(result.files);
  const snapshot = {
    repository: 'owner/data',
    revision: 'r1',
    aliases: {},
    mode: 'authored' as const,
    tooltips: saved.documents,
    types: { 1: 'Test', 2: 'Test', 3: 'Test', 40: 'Test' },
  };
  expect(
    await planGlobalRelease({
      saved: result.savedStore,
      published: result.liveStore,
      authored: snapshot,
      live: { ...snapshot, mode: 'live' },
      causes: [],
      destination: 'converter-v2-test',
    }),
  ).toEqual([]);
  const different = documents();
  different[2].text.en!.updatedAt = '2026-02-01T00:00:00Z';
  const edited = bootstrapFiles(inventory(different), live, 'converter-v2-test', result.ids);
  expect(changedGlobalIds(edited.liveStore, edited.savedStore)).toHaveLength(3);
  expect(edited.identityEvidence.filter((v) => !v.shared)).toHaveLength(3);
  const tooLarge = documents();
  tooLarge[2].text.en!.text = `var Large = ${'x'.repeat(8193)}`;
  expect(() => bootstrapFiles(inventory(tooLarge), live, 'test')).toThrow('admission');
});

it('accepts live alias stubs, retains conditional contexts, and refuses malformed or dangling aliases', () => {
  const docs = documents();
  docs[0] = { ...tooltip(0, '#Damage'), custom: { name: 'Default perk', categoryId: 'none' } };
  docs[40].text.en!.text = 'enhanced (\n#Damage\n)\nBase';
  const perks = exportLegacy(Object.values(docs), 0);
  Object.assign(perks[40], { name: 'Base', type: 'Weapon Trait' });
  perks[41] = {
    hash: 41,
    aliasOf: 40,
    aliasKind: 'frame',
    name: 'Enhanced',
    type: 'Weapon Trait Enhanced',
  };
  perks[42] = { hash: 42, aliasOf: 40, aliasKind: 'sandbox' };
  const source = { repository: 'owner/data', revision: 'r1', path: 'liveDescriptions.json' };
  const input = { perks, databaseSettings: { folders: {}, enhancedPerks: {} } };
  Object.assign(perks[0], { associated: [40] });
  expect(legacySnapshot(input, source).tooltips[0].associated).toEqual([40]);
  const result = legacyGlobalsCensus(input, source);
  expect(result.resolverComplete).toBe(true);
  expect(result.resolvedConsumerCells).toBe(3);
  expect(result.tooltips).toBe(5);
  expect(() =>
    legacyGlobalsCensus(
      { ...input, perks: { ...perks, 41: { ...perks[41], aliasOf: 999 } } },
      source,
    ),
  ).toThrow('canonical');
  expect(() =>
    legacyGlobalsCensus(
      { ...input, perks: { ...perks, 41: { ...perks[41], editor: {} } } },
      source,
    ),
  ).toThrow();
  const fallback = structuredClone(input);
  (fallback.perks[0] as { editor: { en: { englishFallback?: true } } }).editor.en.englishFallback =
    true;
  expect(() => legacySnapshot(fallback, source)).toThrow('English-fallback provenance');
});

it('plans, stages, independently verifies, and restores only the exact offline contract tree', async () => {
  mkdirSync('.agents/globals-bootstrap/tests', { recursive: true });
  const root = mkdtempSync(resolve('.agents/globals-bootstrap/tests/fixture-'));
  const repo = join(root, 'data');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  git('init');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.autocrlf', 'false');
  const write = (path: string, value: string) => {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), value);
  };
  const docs = documents();
  for (const doc of Object.values(docs)) write(`tooltips/${doc.hash}.json`, json(doc));
  write('.exports/engine.mjs', 'export const frozen = true;\n');
  write('.exports/PIN', 'a'.repeat(40) + '\n');
  const config = {
    repo: 'owner/data',
    dataBranch: 'editor-data',
    liveBranch: 'converter-v2-test',
    aliases: { 41: { to: 40, kind: 'frame' as const } },
    generatorSha: 'a'.repeat(40),
    facts: Object.fromEntries(
      [...Object.values(docs), tooltip(41, 'Old frame text')].map((doc) => [
        doc.hash,
        { name: String(doc.hash), type: 'Test' },
      ]),
    ),
  };
  write('.publisher/config.json', json(config));
  write('.publisher/publisher.mjs', '// fixture\n');
  write('.publisher/PIN', json({ sourceSha: 'b'.repeat(40), sha256: sha256('// fixture\n') }));
  write('live/tooltips/40.json', json(docs[40]));
  const legacy = exportLegacy(Object.values(docs), 0, config.facts);
  legacy[41] = exportLegacy([tooltip(41, 'Old frame text')], 0, config.facts)[41];
  legacy[42] = { hash: 42, aliasOf: 40, aliasKind: 'sandbox' };
  for (const hash of [2, 3])
    (legacy[hash] as { editor: { en: { secondary: string } } }).editor.en.secondary = '';
  write(
    'liveDescriptions.json',
    json({ perks: legacy, databaseSettings: { folders: {}, enhancedPerks: {} } }),
  );
  git('add', '.');
  git('commit', '-m', 'Fixture');
  const head = git('rev-parse', 'HEAD'),
    out = join(root, 'plan');
  await main([
    'plan',
    '--repo',
    repo,
    '--out',
    out,
    '--head',
    head,
    '--live',
    head,
    '--converter',
    head,
  ]);
  expect(git('status', '--porcelain')).toBe('');
  const planBytes = readFileSync(join(out, 'plan.json')),
    plan = JSON.parse(planBytes.toString());
  expect(plan.compatibilityRequired).toEqual(['2/en', '3/en']);
  expect(plan.publishedSnapshots.map((snapshot: { path: string }) => snapshot.path)).toEqual([
    'live/tooltips/1.json',
    'live/tooltips/2.json',
    'live/tooltips/3.json',
    'live/tooltips/41.json',
  ]);
  expect(plan.historicalPublishedAliases).toEqual([
    expect.objectContaining({
      hash: 41,
      target: 40,
      classification: 'historical published baseline, now a frame alias in config',
      differsFromPublishedCanonical: true,
    }),
  ]);
  expect(plan.files['live/tooltips/40.json']).toBeUndefined();
  expect(plan.files['live/tooltips/42.json']).toBeUndefined();
  const command = (operation: string, digest = sha256(planBytes)) =>
    main([operation, '--repo', repo, '--out', out, '--expect-plan', digest]);
  await expect(command('apply', '0'.repeat(64))).rejects.toThrow('SHA mismatch');
  await command('apply');
  expect(git('write-tree')).toBe(plan.targetTree);
  expect(git('diff', '--cached', '--', 'tooltips')).toBe('');
  await command('verify');
  write('globals/sync.json', '{}\n');
  await expect(command('restore')).rejects.toThrow('differs');
  write('globals/sync.json', plan.files['globals/sync.json']);
  await command('restore');
  expect(git('status', '--porcelain')).toBe('');
  expect(git('rev-parse', 'HEAD')).toBe(head);
  expect(git('write-tree')).toBe(plan.baseTree);
  write('globals/sync.json', plan.files['globals/sync.json']);
  git('add', 'globals/sync.json');
  await command('restore'); // A crash between file writes is safely recoverable.
  expect(git('write-tree')).toBe(plan.baseTree);
  await command('apply');
  git('commit', '-m', 'Post-bootstrap mutation');
  await expect(command('restore')).rejects.toThrow('HEAD changed');
  // Split exports on an already-installed tree. Existing records and arbitrary
  // review/proof bytes survive both apply and restore without reserialization.
  write('globals/reviews/preserved.json', '{ "preserved": true }\n');
  write('globals/proofs/preserved.json', '{ "proof": true }\n');
  git('add', '.');
  git('commit', '-m', 'Preserve installed metadata');
  const installedHead = git('rev-parse', 'HEAD');
  const conversionOut = join(root, 'exports-plan');
  await main([
    'plan',
    '--repo',
    repo,
    '--out',
    conversionOut,
    '--head',
    installedHead,
    '--live',
    head,
    '--converter',
    head,
  ]);
  const conversionBytes = readFileSync(join(conversionOut, 'plan.json'));
  const conversion = JSON.parse(conversionBytes.toString());
  expect(
    Object.keys(conversion.files).some(
      (path) => path.startsWith('globals/reviews/') || path.startsWith('globals/proofs/'),
    ),
  ).toBe(false);
  const convert = (operation: string) =>
    main([
      operation,
      '--repo',
      repo,
      '--out',
      conversionOut,
      '--expect-plan',
      sha256(conversionBytes),
    ]);
  const priorGlobals = git('rev-parse', 'HEAD:globals');
  await convert('apply');
  await convert('verify');
  expect(readFileSync(join(repo, 'globals/reviews/preserved.json'), 'utf8')).toBe(
    '{ "preserved": true }\n',
  );
  await convert('restore');
  expect(git('write-tree')).toBe(conversion.baseTree);
  expect(git('rev-parse', `${git('write-tree')}:globals`)).toBe(priorGlobals);
  expect(git('status', '--porcelain')).toBe('');
}, 120_000);
