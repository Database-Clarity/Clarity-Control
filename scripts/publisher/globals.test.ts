import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { inventoryGlobals, projectGlobals } from '../../packages/core/src/globals/projection.js';
import {
  reconcileGlobalStore,
  observeGlobalSources,
} from '../../packages/core/src/globalsRelease/index.js';
import { exportLegacy } from '../../packages/core/src/exportLegacy.js';
import {
  stableStringify,
  translationPublishCapability,
  translationPublishIntentDigest,
  type TranslationPublishPayload,
  type TranslationPublishRow,
} from '../../packages/core/src/index.js';
import { compile, newStyleFile } from '../../packages/export/src/index.js';
import { buildLegacy, type LegacyInput } from '../../packages/export/src/legacy.js';
import { descriptionConverter, expandAliases } from '../../packages/export/src/converter/index.js';
import {
  globalsInPlaceCapability,
  globalsInPlacePath,
  type GlobalsPending,
} from '../../packages/core/src/globals/inPlaceReview.js';
import { inactivePublishableHash } from '../../packages/core/src/inactiveMoves.js';
import type { Tooltip } from '../../packages/core/src/schemas.js';
import {
  batchSchema,
  batchStatusSchema,
  type Batch,
  type BatchStatus,
} from '../../packages/core/src/schedule/schemas.js';
import { GlobalsPublisher, globalTreeOid } from './globals.js';
import { migrateInPlace } from './globalsInPlace.js';
import { dryRunGlobalsMigration, restoreGlobalsMigration } from './globalsMigration.js';
import { Publisher, paths, type Options } from './publisher.js';
import { bundleTranslations } from './translations.js';
import { createRequest } from './request.js';
import { LocalRepository, RefRace, type Repository, type Tree } from './git.js';
import { RemoteRepository, TransportUnresolved } from './remote.js';
import {
  globalsHandler,
  namePaths,
  type GlobalsContext,
} from '../../apps/worker/src/globals/handlers.js';
import type { GlobalsStorage } from '../../apps/worker/src/globals/storage.js';

const D = 'refs/heads/editor-data',
  L = 'refs/heads/converter-v2-test';
const A = '01K95H00000000000000000001';
const now = [...A.slice(0, 10)].reduce(
  (value, character) => value * 32 + '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(character),
  0,
);
const cell = (text: string) => ({ text, updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'alice' });
const tooltip = (hash: number, text: string): Tooltip => ({
  hash,
  associated: [],
  text: { en: cell(text) },
});
const encode = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

class Memory implements Repository {
  blobs = new Map<string, string>();
  trees = new Map<string, Tree>();
  parents = new Map<string, string | undefined>();
  refs = new Map<string, string>();
  sequence = 0;
  beforeAtomic?: () => void;
  beforeCas?: () => void;
  blob(oid: string) {
    const value = this.blobs.get(oid);
    if (value === undefined) throw new Error('Missing blob');
    return value;
  }
  writeBlob(bytes: string) {
    const oid = createHash('sha1')
      .update(`blob ${Buffer.byteLength(bytes)}\0`)
      .update(bytes)
      .digest('hex');
    this.blobs.set(oid, bytes);
    return oid;
  }
  tree(commit: string) {
    const tree = this.trees.get(commit);
    if (!tree) throw new Error('Missing commit');
    return { ...tree };
  }
  head(ref: string) {
    return this.refs.get(ref);
  }
  commit(parent: string | undefined, tree: Tree) {
    const oid = (++this.sequence).toString(16).padStart(40, '0');
    this.trees.set(oid, { ...tree });
    this.parents.set(oid, parent);
    return oid;
  }
  cas(ref: string, old: string | undefined, next: string | undefined) {
    const callback = this.beforeCas;
    this.beforeCas = undefined;
    callback?.();
    if (this.head(ref) !== old) throw new RefRace();
    if (next) this.refs.set(ref, next);
    else this.refs.delete(ref);
  }
  casMany(updates: { ref: string; old: string; next: string }[]) {
    const callback = this.beforeAtomic;
    this.beforeAtomic = undefined;
    callback?.();
    if (updates.some(({ ref, old }) => this.head(ref) !== old)) throw new RefRace();
    for (const { ref, next } of updates) this.refs.set(ref, next);
  }
  ancestor(a: string, b: string) {
    return this.history(b).includes(a);
  }
  history(ref: string) {
    const result: string[] = [];
    let oid = this.head(ref) ?? ref;
    while (oid) {
      result.push(oid);
      oid = this.parents.get(oid)!;
    }
    return result;
  }
  additions(head: string, path: string) {
    if (path === '.publish/receipts')
      return this.history(head)
        .reverse()
        .flatMap((commit) => {
          const parent = this.parents.get(commit);
          const previous = parent ? this.tree(parent) : {};
          return Object.keys(this.tree(commit))
            .filter((file) => file.startsWith(`${path}/`) && !previous[file])
            .map((file) => ({ commit, path: file }));
        });
    return this.history(head)
      .filter(
        (commit) => this.tree(commit)[path] && !this.tree(this.parents.get(commit) ?? commit)[path],
      )
      .map((commit) => ({ commit, path }));
  }
}

async function fixture(titleSource = '', exports = false, translatedVariables = false, offset = 0) {
  const git = new Memory();
  const docs = [
    tooltip(1, exports ? 'export Barrier (\nOld\n)' : ''),
    tooltip(2, '// ordered\nvar Alpha = 10\n\nvar Beta = 20\n'),
    tooltip(3, titleSource),
    tooltip(40 + offset, exports ? 'import Barrier from global' : '#Alpha'),
    tooltip(41 + offset, '#Beta'),
    tooltip(42 + offset, 'unrelated'),
  ];
  if (translatedVariables) {
    docs[1].text.de = {
      ...cell('var Alpha = 10\nvar Beta = 80'),
      sourceUpdatedAt: '2026-01-01T00:00:00Z',
    };
    docs[4].text.de = cell('#Beta');
  }
  let id = 0;
  const published = inventoryGlobals(
    docs.filter(
      (document) => (exports && document.hash === 1) || document.hash === 2 || document.hash === 3,
    ),
    {
      repository: 'owner/data',
      revision: 'initial',
      locate: (hash, lang) => ({ path: `tooltips/${hash}.json`, selector: ['text', lang, 'text'] }),
    },
    () => `g_fixture${++id}000`,
  );
  const saved = structuredClone(published);
  for (const entry of saved.entries) {
    entry.revision = `${entry.name}2`;
    entry.definitions.en!.revision = entry.revision;
    entry.definitions.en!.body += '0';
  }
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const options: Options = {
    repo: 'owner/data',
    dataBranch: 'editor-data',
    liveBranch: 'converter-v2-test',
    publisherSha: 'a'.repeat(40),
    publisherDigest: 'c'.repeat(64),
    generatorSha: 'b'.repeat(40),
    publicKey,
    keyFingerprint: createHash('sha256')
      .update(keys.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex'),
    aliases: {},
    facts: Object.fromEntries(
      docs.map((document) => [document.hash, { name: String(document.hash), type: 'Weapon Perk' }]),
    ),
    now: () => now,
    runUrl: '',
  };
  const tree: Tree = {};
  const write = (path: string, value: unknown) => (tree[path] = git.writeBlob(encode(value)));
  for (const document of docs) {
    write(`tooltips/${document.hash}.json`, document);
    write(`live/tooltips/${document.hash}.json`, document);
  }
  write('config/permissions.json', {
    users: {
      '1': { login: 'alice', role: 'maintainer' },
      '2': { login: 'translator', role: 'translator', languages: ['de'] },
    },
  });
  write('live/pushed.json', {});
  write('globals/layout.json', { version: 1, aggregates: published.aggregates });
  write('globals/live/converter-v2-test.json', {
    version: 1,
    destination: options.liveBranch,
    store: published,
  });
  for (const entry of saved.entries) write(`globals/entries/${entry.id}.json`, entry);
  write('globals/sync.json', {
    version: 1,
    status: 'current',
    causeIds: [],
    causeEntries: {},
    lastFailure: null,
  });
  write('.publisher/PIN', {
    sourceSha: options.publisherSha,
    sha256: options.publisherDigest,
    capabilities: ['globalsRelease', ...(exports ? ['globalsExportsV1'] : [])],
  });
  write('.publisher/config.json', {
    generatorSha: options.generatorSha,
    aliases: options.aliases,
    facts: options.facts,
  });
  git.refs.set(D, git.commit(undefined, tree));
  git.refs.set(
    L,
    git.commit(undefined, {
      'liveDescriptions.json': git.writeBlob(
        encode({ perks: exportLegacy(docs, 0, options.facts), databaseSettings: {} }),
      ),
    }),
  );
  const pub = new Publisher(git, options),
    globals = new GlobalsPublisher(pub);
  const current = () => git.tree(git.head(D)!);
  const read = (path: string) => JSON.parse(git.blob(current()[path]));
  const change = (changes: Record<string, unknown>) => {
    const tree = current();
    for (const [path, value] of Object.entries(changes)) {
      if (value === undefined) delete tree[path];
      else tree[path] = git.writeBlob(encode(value));
    }
    git.refs.set(D, git.commit(git.head(D), tree));
  };
  const request = async (
    hashes: number[],
    opId = A,
    globals?: { id: string; expected: string }[],
  ) => {
    const aliases = pub.aliasesAt(current());
    const expected = Object.fromEntries(
      await Promise.all(
        hashes.map(async (hash) => [
          hash,
          await inactivePublishableHash(tooltipSchemaRead(hash), aliases, pub.movesAt(current())),
        ]),
      ),
    );
    await createRequest(
      git,
      {
        opId,
        kind: 'push',
        repo: options.repo,
        dataBranch: options.dataBranch,
        liveBranch: options.liveBranch,
        requester: { id: 1, login: 'alice' },
        hashes,
        expected,
        ...(globals ? { globals } : {}),
      },
      () => now,
      (payload) => sign(null, Buffer.from(payload), keys.privateKey).toString('base64'),
    );
  };
  const tooltipSchemaRead = (hash: number) =>
    (current()[`tooltips/${hash}.json`]
      ? read(`tooltips/${hash}.json`)
      : { hash, text: {}, associated: [] }) as Tooltip;
  return {
    git,
    pub,
    globals,
    saved,
    published,
    options,
    current,
    read,
    change,
    request,
    sign: (bytes: string) => sign(null, Buffer.from(bytes), keys.privateKey).toString('base64'),
  };
}

async function inPlaceFixture(titleSource = '', exports = false, secondary?: string) {
  const f = await fixture(titleSource, exports, true, 100);
  const legacyData = f.pub.head(f.options.dataBranch);
  let legacyLive = f.pub.head(f.options.liveBranch);
  if (secondary !== undefined) {
    const tree = f.git.tree(legacyLive);
    const input = f.pub.read<LegacyInput>(tree, 'liveDescriptions.json')!;
    const row = input.perks[141];
    if (!('editor' in row) || !row.editor.en) throw new Error('Missing test tooltip');
    row.editor.en.secondary = secondary;
    const historical = f.git.commit(legacyLive, {
      ...tree,
      'liveDescriptions.json': f.git.writeBlob(encode(input)),
    });
    f.git.cas(L, legacyLive, historical);
    legacyLive = historical;
  }
  const tree = f.git.tree(legacyLive);
  const before = f.pub.read<LegacyInput>(tree, 'liveDescriptions.json')!;
  const migratedLive = f.git.commit(legacyLive, {
    ...tree,
    'liveDescriptions.json': f.git.writeBlob(encode(migrateInPlace(before))),
  });
  f.git.cas(L, legacyLive, migratedLive);
  const entry = f.saved.entries.find(({ name }) => name === 'Beta')!;
  entry.definitions.en!.updatedAt = '2026-06-01T00:00:00Z';
  const entryPath = `globals/entries/${entry.id}.json`;
  const pin = f.read('.publisher/PIN');
  pin.capabilities.push(globalsInPlaceCapability);
  f.change({
    '.publisher/PIN': pin,
    [globalsInPlacePath]: {
      state: 'active',
      destination: f.options.liveBranch,
      legacyData,
      legacyLive,
      migratedLive,
    },
    [entryPath]: entry,
  });
  return { ...f, entry, entryPath };
}

describe('in-place shared text publication', () => {
  it('refuses ordinary publication before the migration and leaves every ref unchanged', async () => {
    const f = await fixture();
    await f.request([40]);
    const refs = new Map(f.git.refs);
    const inactive = 'Publication requires an active config/globals-in-place.json migration.';
    await expect(f.pub.run()).rejects.toThrow(inactive);
    await expect(f.pub.operation(A)).rejects.toThrow(inactive);
    expect(() => f.pub.bundle()).toThrow(inactive);
    expect(f.git.refs).toEqual(refs);
  });
  const pending = (f: Awaited<ReturnType<typeof inPlaceFixture>>): GlobalsPending => {
    f.pub.bundle();
    return f.pub.read<{ globalsPending: GlobalsPending }>(
      f.git.tree(f.pub.head('editor-data-bundle')),
      'bundle.json',
    )!.globalsPending;
  };
  const selection = (row: GlobalsPending[number]) => [{ id: row.id, expected: row.digest }];
  const live = (f: Awaited<ReturnType<typeof inPlaceFixture>>) =>
    f.pub.read<LegacyInput>(f.git.tree(f.pub.head(f.options.liveBranch)), 'liveDescriptions.json')!;
  it('refills only the reviewed global language, then withdraws it with the same scope', async () => {
    const f = await inPlaceFixture();
    const { id } = f.entry;
    const catalogPath = 'globals/live/converter-v2-test.json';
    const source = f
      .read(catalogPath)
      .store.entries.find((entry: { id: string }) => entry.id === id);
    const pin = f.read('.publisher/PIN');
    pin.capabilities.push(translationPublishCapability);
    const publish = async (opId: string, entry: typeof f.entry, revokedAtFence = false) => {
      f.change({ [f.entryPath]: entry, '.publisher/PIN': pin });
      const preview = await bundleTranslations(f.pub, f.current(), f.git.head(L)!, {});
      const review = preview.lanes.de?.find((row) => row.kind === 'global' && row.id === id);
      expect(review).toMatchObject({ status: 'ready', affectedHashes: [141] });
      if (!review || review.status !== 'ready' || review.kind !== 'global')
        throw new Error('Expected a reviewable German global');
      const { expected, english, before, effects, affected } = review;
      const row: TranslationPublishRow = {
        kind: 'global',
        id,
        lang: 'de',
        expected,
        english,
        before,
        effects,
        affected,
      };
      const payload: TranslationPublishPayload = {
        kind: 'push',
        opId,
        scope: 'translations',
        rows: [row],
        repo: f.options.repo,
        dataBranch: f.options.dataBranch,
        liveBranch: f.options.liveBranch,
        requester: { id: 2, login: 'translator' },
        createdAt: new Date(now).toISOString(),
        intentDigest: '',
      };
      payload.intentDigest = await translationPublishIntentDigest(payload);
      const bytes = stableStringify(payload);
      f.change({ [paths(opId).request]: { payload: bytes, sig: f.sign(bytes) } });
      if (revokedAtFence)
        f.git.beforeAtomic = () => f.change({
          'config/permissions.json': { users: { 1: { login: 'alice', role: 'maintainer' } } },
        });
      await f.pub.operation(opId);
      if (revokedAtFence)
        expect(f.read(paths(opId).log).result).toMatchObject({
          status: 'rejected', error: expect.stringContaining('revoked'),
        });
      else
        expect(f.read(paths(opId).log).result).toMatchObject({
          status: 'done',
          rows: [{ id, lang: 'de', status: 'published' }],
        });
      return review;
    };
    const initial = live(f);
    const { provenance, ...definition } = source.definitions.en;
    expect(provenance.lang).toBe('en');
    const selected = {
      ...source,
      definitions: { ...source.definitions, de: { ...definition, body: '35' } },
    };
    await publish(A, selected);
    const landed = f.git.head(L)!;
    const frozen = f.pub.receipt(landed, A)!.sourceCommit;
    const permissions = f.read('config/permissions.json');
    f.git.refs.set(D, frozen);
    f.change({
      'config/permissions.json': { users: { 1: { login: 'alice', role: 'maintainer' } } },
    });
    await f.pub.operation(A);
    expect(f.git.head(L)).toBe(landed);
    expect(f.read(paths(A).log).result).toMatchObject({ status: 'done' });
    f.change({ 'config/permissions.json': permissions });
    const filled = live(f);
    expect(filled.perks[141]).toMatchObject({
      ...initial.perks[141],
      editor: { en: { main: '20' }, de: { main: '35' } },
    });
    for (const [hash, perk] of Object.entries(initial.perks))
      if (hash !== '141') expect(filled.perks[hash]).toEqual(perk);
    expect(
      f.read(catalogPath).store.entries.find((entry: { id: string }) => entry.id === id),
    ).toEqual(selected);
    const removed = { ...source, definitions: { en: source.definitions.en } };
    const withdrawal = await publish(A.slice(0, -1) + '2', removed);
    expect(withdrawal).toMatchObject({ removed: true, englishFallback: true });
    expect(live(f).perks[141]).toMatchObject({
      editor: { en: { main: '20' }, de: { main: '20', englishFallback: true } },
    });
    const beforeRevoked = f.git.head(L);
    await publish(A.slice(0, -1) + '3', selected, true);
    expect(f.git.head(L)).toBe(beforeRevoked);
  });
  const formatV2Text = (
    input: LegacyInput,
    hash: number,
    language: 'en' | 'de',
    languageFiles: 'combined' | 'perLanguage' = 'combined',
  ) => {
    const file = newStyleFile('reader', 'structured', {
      categories: ['Weapon Perk'],
      sandboxPerks: [],
      frameAliases: true,
      languages: [language],
      keys: ['name'],
      languageFiles,
      bungieIdentical: true,
    });
    const output = compile(input, file, {
      catalog: {
        items: { [hash]: { categoryId: 'Weapon Perk' } },
        categories: [{ id: 'Weapon Perk' }],
      },
    });
    return Buffer.from(output.bytes).toString('utf8');
  };

  it('refills published text only, preserves upload stamps and markers, and restores a translation', async () => {
    const f = await inPlaceFixture();
    const draft = f.read('tooltips/141.json') as Tooltip;
    draft.text.en!.text = 'Unpublished draft #Beta';
    f.change({ 'tooltips/141.json': draft });
    const before = live(f);
    const pushed = f.read('live/pushed.json');
    const published = f.read('live/tooltips/141.json');
    const row = pending(f).find(({ name }) => name === 'Beta')!;
    expect(row.affected).toEqual([141]);
    expect(row.languages.de).toEqual({
      before: '80',
      after: '80',
      beforeAvailable: true,
      afterAvailable: false,
    });
    await f.request([], A, selection(row));
    await f.pub.run(false);
    const result = f.read(paths(A).log).result;
    expect(result).toMatchObject({ status: 'done', globals: [f.entry.id] });
    expect(live(f).perks[141]).toMatchObject({
      ...before.perks[141],
      editor: {
        en: { main: '200', secondary: '200' },
        de: { main: '200', secondary: '200', englishFallback: true },
      },
    });
    expect(live(f).perks[140]).toEqual(before.perks[140]);
    expect(f.read('live/tooltips/141.json')).toEqual(published);
    expect(f.read('live/pushed.json')).toEqual(pushed);
    expect(f.pub.receipt(f.pub.head(f.options.liveBranch), A)).toMatchObject({
      entries: [],
      changed: [],
      inPlace: { globals: [f.entry.id], refills: [141] },
    });
    f.entry.definitions.de!.sourceUpdatedAt = f.entry.definitions.en!.updatedAt;
    f.change({ [f.entryPath]: f.entry });
    const restored = A.replace(/1$/, '2');
    const restoration = pending(f).find(({ name }) => name === 'Beta')!;
    expect(restoration.languages.de).toEqual({
      before: '80',
      after: '80',
      beforeAvailable: false,
      afterAvailable: true,
    });
    await f.request([], restored, selection(restoration));
    await f.pub.run(false);
    const localized = live(f).perks[141];
    expect('editor' in localized && localized.editor.de).toEqual({ main: '80', secondary: '80' });
  });

  it('uses published bodies for ordinary requests and requires approvals for new names', async () => {
    const f = await inPlaceFixture();
    const doc = f.read('tooltips/141.json') as Tooltip;
    doc.text.en!.text = 'Approved #Beta';
    f.change({ 'tooltips/141.json': doc });
    await f.request([141]);
    await f.pub.run(false);
    expect(live(f).perks[141]).toMatchObject({ editor: { en: { main: 'Approved 20' } } });

    const extra = { ...structuredClone(f.entry), id: 'g_newfixture000', name: 'Extra' };
    doc.text.en!.text = 'Approved #Extra';
    f.change({ 'tooltips/141.json': doc, [`globals/entries/${extra.id}.json`]: extra });
    const refused = A.replace(/1$/, '2');
    await f.request([141], refused);
    await f.pub.run(false);
    expect(f.read(paths(refused).log).result.error).toContain(
      'Publish the shared change for Extra first',
    );
    const approved = A.replace(/1$/, '3');
    await f.request([141], approved, selection(pending(f).find(({ id }) => id === extra.id)!));
    await f.pub.run(false);
    expect(live(f).perks[141]).toMatchObject({ editor: { en: { main: 'Approved 200' } } });
  });

  it('falls back to the whole English tooltip when a shared note uses a stale variable', async () => {
    const f = await inPlaceFixture('title Help (\nValue #Beta\n)');
    const store = structuredClone(f.published);
    const note = store.entries.find(({ name }) => name === 'Help')!;
    note.definitions.de = {
      body: 'Wert #Beta',
      revision: note.revision,
      updatedAt: '2026-01-01T00:00:00Z',
      updatedBy: 'alice',
    };
    store.aggregates = reconcileGlobalStore(store.aggregates, store.entries).aggregates;
    const doc = f.read('tooltips/141.json') as Tooltip;
    doc.text.en!.text = 'English 6.5 <title Details [Help] />';
    doc.text.de!.text = 'Deutsch 6,5 <title Details [Help] />';
    f.change({
      'tooltips/141.json': doc,
      'globals/live/converter-v2-test.json': {
        version: 1,
        destination: f.options.liveBranch,
        store,
      },
      [`globals/entries/${note.id}.json`]: note,
    });
    await f.request([141]);
    await f.pub.run(false);
    const op = A.replace(/1$/, '2');
    await f.request([], op, selection(pending(f).find(({ name }) => name === 'Beta')!));
    await f.pub.run(false);
    expect(f.read(paths(op).log).result.status).toBe('done');
    const row = live(f).perks[141];
    expect('editor' in row && row.editor.de?.englishFallback).toBe(true);
    expect('editor' in row && row.editor.de?.main).toContain('English 6.5');
  });

  it('uses English for a missing named shared export and keeps the saved translation', async () => {
    const f = await inPlaceFixture('', true);
    const doc = f.read('tooltips/141.json') as Tooltip;
    doc.text.en!.text = 'English 6.5\nimport Barrier from global';
    doc.text.de!.text = 'Deutsch 6,5\nimport Barrier from global';
    f.change({ 'tooltips/141.json': doc });
    await f.request([141]);
    await f.pub.run(false);
    const row = live(f).perks[141];
    expect('editor' in row && row.editor.de).toMatchObject({
      englishFallback: true,
      main: 'English 6.5\nOld',
    });
    expect(f.read('tooltips/141.json')).toEqual(doc);
  });

  it('keeps a pure rename neutral in LIVE and in authored pending state', async () => {
    const f = await inPlaceFixture();
    const prior = f.read('live/tooltips/141.json') as Tooltip;
    const doc = structuredClone(prior);
    const entry = structuredClone(f.published.entries.find(({ id }) => id === f.entry.id)!);
    for (const lang of ['Tempo', 'Magnitude']) {
      const from = entry.name;
      entry.name = lang;
      for (const cell of Object.values(doc.text))
        cell.text = cell.text.replace(`#${from}`, `#${lang}`);
      f.change({ [f.entryPath]: entry, 'tooltips/141.json': doc });
    }
    const mark = await inactivePublishableHash(prior, {});
    const expected = await inactivePublishableHash(doc, {});
    const saved = structuredClone(doc);
    saved.text.en!.updatedBy = 'an unrelated save stamp';
    f.change({ 'live/pushed.json': { 141: mark }, 'tooltips/141.json': saved });
    const row = pending(f).find(({ id }) => id === entry.id)!;
    const bundle = f.pub.read<{ pushed: Record<number, string> }>(
      f.git.tree(f.pub.head('editor-data-bundle')),
      'bundle.json',
    )!;
    expect(bundle.pushed[141]).toBe(expected);
    expect(f.read('live/pushed.json')[141]).toBe(mark);
    const before = live(f);
    await f.request([141], A, selection(row));
    await f.pub.run(false);
    expect(f.read(paths(A).log).result).toMatchObject({ status: 'unchanged', globals: [entry.id] });
    expect(live(f)).toEqual(before);
    expect(f.pub.receipt(f.pub.head(f.options.liveBranch), A)?.changed).toEqual([]);
    expect(f.read('live/tooltips/141.json')).toEqual(doc);
    expect(f.read('live/pushed.json')[141]).toBe(expected);

    const reused = { ...structuredClone(f.entry), id: 'g_reusedfixture0', name: 'Beta' };
    f.change({ [`globals/entries/${reused.id}.json`]: reused });
    const returned = pending(f).find(({ id }) => id === reused.id)!;
    const reuse = A.replace(/1$/, '2');
    await f.request([], reuse, selection(returned));
    await f.pub.run(false);
    expect(f.read(paths(reuse).log).result).toMatchObject({
      status: 'unchanged',
      globals: [reused.id],
    });
    expect(live(f)).toEqual(before);
  });

  it.each([
    ['Beta', 'Magnitude', 'Before #Magnitude'],
    ['Beta', 'Magnitude', 'var Magnitude = 10\nBefore #Beta'],
    ['Help', 'LocalNote', 'Before <title Details [LocalNote] />'],
    ['Help', 'LocalNote', 'title LocalNote (\nLocal content\n)\nBefore <title Details [Help] />'],
  ])(
    'refuses renaming %s to %s when its new name is already used in published text: %s',
    async (from, to, source) => {
      const f = await inPlaceFixture('title Help (\nHelp content\n)');
      const document = tooltip(142, source);
      f.change({ 'tooltips/142.json': document });
      await f.request([142]);
      await f.pub.run(false);
      expect(f.read(paths(A).log).result.status).toBe('done');
      const before = f.pub.head(f.options.liveBranch);
      const snapshot = f.read('live/tooltips/142.json');
      const original = f.published.entries.find(({ name }) => name === from)!;
      f.change({ [`globals/entries/${original.id}.json`]: { ...original, name: to } });
      const row = pending(f).find(({ id }) => id === original.id)!;
      expect(row.refusal).toBe(
        `Tooltip 142 already uses or declares ${to}. Choose a different name.`,
      );
      const rename = A.replace(/1$/, '2');
      await f.request([], rename, selection(row));
      await f.pub.run(false);
      expect(f.read(paths(rename).log).result).toMatchObject({ status: 'rejected' });
      expect(f.pub.head(f.options.liveBranch)).toBe(before);
      expect(f.read('live/tooltips/142.json')).toEqual(snapshot);
    },
  );

  it('allows a shared note to return to the name still in its filled LIVE text', async () => {
    const f = await inPlaceFixture('title G_refill (\nHelp content\n)');
    const doc = tooltip(142, 'Before <title Details [G_refill] />');
    f.change({ 'tooltips/142.json': doc });
    await f.request([142]);
    await f.pub.run(false);
    expect(f.read(paths(A).log).result.status).toBe('done');
    const before = live(f);
    const original = f.published.entries.find(({ name }) => name === 'G_refill')!;
    const path = `globals/entries/${original.id}.json`;
    const history = (entry: typeof original) => ({
      name: entry.name,
      revision: entry.revision,
      at: new Date(now).toISOString(),
      by: 'alice',
    });
    const moved = {
      ...original,
      name: 'G_newrefill',
      nameHistory: [history(original)],
    };
    f.change({
      [path]: moved,
      'tooltips/142.json': tooltip(142, 'Before <title Details [G_newrefill] />'),
    });
    const first = A.replace(/1$/, '2');
    await f.request([], first, selection(pending(f).find(({ id }) => id === original.id)!));
    await f.pub.run(false);
    expect(f.read(paths(first).log).result.status).toBe('unchanged');
    expect(live(f)).toEqual(before);

    f.change({
      [path]: { ...original, nameHistory: [...moved.nameHistory, history(moved)] },
      'tooltips/142.json': doc,
    });
    const row = pending(f).find(({ id }) => id === original.id)!;
    expect(row).toMatchObject({ renameOnly: true });
    expect(row.refusal).toBeUndefined();
    const back = A.replace(/1$/, '3');
    await f.request([], back, selection(row));
    await f.pub.run(false);
    expect(f.read(paths(back).log).result.status).toBe('unchanged');
    expect(live(f)).toEqual(before);
    expect(f.read('live/tooltips/142.json')).toEqual(doc);
  });

  it.each([false, true])(
    'reports a refused pending note rename with tombstone present: %s',
    async (tombstone) => {
      const f = await inPlaceFixture('title G_refill (\nHelp content\n)');
      f.change({ 'tooltips/142.json': tooltip(142, 'Before <title Details [G_refills] />') });
      await f.request([142]);
      await f.pub.run(false);
      expect(f.read(paths(A).log).result.status).toBe('done');
      const before = f.pub.head(f.options.liveBranch);
      const original = f.published.entries.find(({ name }) => name === 'G_refill')!;
      f.change({
        ...(tombstone && {
          'globals/entries/g_00000000.json': {
            ...original,
            id: 'g_00000000',
            name: 'G_refills',
            definitions: {},
            tombstone: { at: new Date(now).toISOString(), by: 'alice' },
          },
        }),
        [`globals/entries/${original.id}.json`]: { ...original, name: 'G_refills' },
        'tooltips/142.json': tooltip(142, 'After <title Details [G_refills] />'),
      });
      const row = pending(f).find(({ id }) => id === original.id)!;
      expect(row.refusal).toBe(
        'Tooltip 142 already uses or declares G_refills. Choose a different name.',
      );
      const edit = A.replace(/1$/, '2');
      await f.request([142], edit);
      await f.pub.run(false);
      expect(f.read(paths(edit).log).result).toMatchObject({
        status: 'rejected',
        error: expect.stringContaining(row.refusal!),
      });
      expect(f.pub.head(f.options.liveBranch)).toBe(before);
    },
  );

  it('undoes a saved rename through Worker intake before the global goes live', async () => {
    const f = await inPlaceFixture('title G_refill (\nHelp content\n)');
    const original = f.published.entries.find(({ name }) => name === 'G_refill')!;
    const path = `globals/entries/${original.id}.json`;
    f.change({ [path]: original, 'tooltips/142.json': tooltip(142, '<title Help [G_refill] />') });
    const port = await mutationPort(f);
    const rename = (name: string) =>
      port.post(`/${original.id}/rename`, {
        operation: 'rename',
        id: original.id,
        revision: f.read(path).revision,
        name,
      });
    const baseline = f.git.head(L);
    expect((await rename('G_refills')).status).toBe(202);
    await f.globals.maintainAuthored();
    expect((await rename('G_refills')).status).toBe(200);
    await f.globals.maintainAuthored();
    expect(f.read(path).name).toBe('G_refills');
    expect(f.read('tooltips/142.json').text.en.text).toContain('[G_refills]');
    const oldName = await namePaths('titles', original.name);
    expect(f.current()[oldName.claim]).toBeUndefined();
    expect(f.read(oldName.proof).occupiedBy).toBe(original.id);

    expect((await rename(original.name)).status).toBe(202);
    await f.globals.maintainAuthored();
    expect((await rename(original.name)).status).toBe(200);
    await f.globals.maintainAuthored();
    expect(f.read(path).name).toBe(original.name);
    expect(f.read('tooltips/142.json').text.en.text).toContain('[G_refill]');
    expect(pending(f).find(({ id }) => id === original.id)).toBeUndefined();
    expect(f.git.head(L)).toBe(baseline);
  });

  it('drops a reversed rename, but publishes a rename and body edit without the tooltip draft', async () => {
    const f = await inPlaceFixture();
    const original = f.published.entries.find(({ id }) => id === f.entry.id)!;
    const prior = f.read('live/tooltips/141.json') as Tooltip;
    const renamed = structuredClone(prior);
    for (const cell of Object.values(renamed.text)) cell.text = '#Magnitude';
    const moved = { ...original, name: 'Magnitude' };
    f.change({ [f.entryPath]: moved, 'tooltips/141.json': renamed });
    expect(pending(f)).toContainEqual(
      expect.objectContaining({ id: original.id, name: 'Magnitude' }),
    );
    f.change({ [f.entryPath]: { ...original, revision: 'reverted' }, 'tooltips/141.json': prior });
    expect(pending(f).some(({ id }) => id === original.id)).toBe(false);

    const draft = structuredClone(renamed);
    draft.text.en!.text = 'An unpublished edit #Magnitude';
    const changed = { ...structuredClone(f.entry), name: 'Magnitude' };
    const marker = await inactivePublishableHash(prior, {});
    f.change({
      [f.entryPath]: changed,
      'tooltips/141.json': draft,
      'live/pushed.json': { 141: marker },
    });
    const row = pending(f).find(({ id }) => id === changed.id)!;
    await f.request([141]);
    await f.pub.run(false);
    expect(f.read(paths(A).log).result.error).toContain(
      'Publish the shared change for Magnitude first',
    );
    const approved = A.replace(/1$/, '2');
    await f.request([], approved, selection(row));
    await f.pub.run(false);
    expect(live(f).perks[141]).toMatchObject({ editor: { en: { main: '200' } } });
    expect(f.read('live/tooltips/141.json')).toEqual(renamed);
    expect(f.read('tooltips/141.json')).toEqual(draft);
    expect(f.read('live/pushed.json')[141]).toBe(await inactivePublishableHash(renamed, {}));
  });

  it('waits on a renamed withdrawal while the published source still refers to it', async () => {
    const f = await inPlaceFixture();
    const entry = {
      ...f.entry,
      name: 'Magnitude',
      tombstone: { at: new Date(now).toISOString(), by: 'alice' },
    };
    const saved = f.read('tooltips/141.json') as Tooltip;
    for (const cell of Object.values(saved.text)) cell.text = 'Saved without the global';
    f.change({ [f.entryPath]: entry, 'tooltips/141.json': saved });
    const row = pending(f).find(({ id }) => id === entry.id)!;
    expect(row.refusal).toContain('still uses Magnitude');
    const before = live(f);
    await f.request([], A, selection(row));
    await f.pub.run(false);
    expect(f.read(paths(A).log).result.status).toBe('rejected');
    expect(live(f)).toEqual(before);
    const alpha = pending(f).find(({ name }) => name === 'Alpha')!;
    const other = A.replace(/1$/, '2');
    await f.request([], other, [...selection(row), ...selection(alpha)]);
    await f.pub.run(false);
    expect(f.read(paths(other).log).result).toMatchObject({
      status: 'done',
      globals: [alpha.id],
      globalRefusals: [{ id: row.id, error: expect.stringContaining('still uses') }],
    });
    expect(live(f).perks[141]).toEqual(before.perks[141]);
  });

  it('refuses raw compatibility library roots', async () => {
    const f = await inPlaceFixture();
    const before = live(f);
    await f.request([2]);
    await f.pub.run(false);
    expect(f.read(paths(A).log).result.error).toContain('Review → Globals');
    expect(live(f)).toEqual(before);
  });

  it('publishes an independent tooltip when a selected global cannot be removed', async () => {
    const f = await inPlaceFixture();
    const before = live(f);
    const doc = tooltip(140, 'Approved edit');
    f.change({
      'tooltips/140.json': doc,
      [f.entryPath]: { ...f.entry, tombstone: { at: new Date(now).toISOString(), by: 'alice' } },
    });
    const beta = pending(f).find(({ id }) => id === f.entry.id)!;
    await f.request([140], A, selection(beta));
    await f.pub.run(false);
    expect(f.read(paths(A).log).result).toMatchObject({
      status: 'done',
      globalRefusals: [{ id: beta.id, error: expect.stringContaining('still uses Beta') }],
    });
    expect(live(f).perks[140]).toMatchObject({ editor: { en: { main: 'Approved edit' } } });
    expect(live(f).perks[141]).toEqual(before.perks[141]);
  });

  it('ignores unpublished global names in inline and block comments', async () => {
    const f = await inPlaceFixture('', true);
    const extra = { ...structuredClone(f.entry), id: 'g_newfixture000', name: 'Extra' };
    const named = {
      ...extra,
      id: 'g_namedfixture00',
      kind: 'exports',
      definitions: { en: { ...extra.definitions.en!, provenance: undefined } },
    };
    const doc = tooltip(140, 'Approved text // #Extra\n/*\nimport Extra from global\n*/');
    f.change({
      'tooltips/140.json': doc,
      [`globals/entries/${extra.id}.json`]: extra,
      [`globals/entries/${named.id}.json`]: named,
    });
    await f.request([140]);
    await f.pub.run(false);
    expect(f.read(paths(A).log).result.status).toBe('done');
    const before = live(f);
    const beta = pending(f).find(({ id }) => id === f.entry.id)!;
    expect(beta.refusal).toBeUndefined();
    const op = A.replace(/1$/, '2');
    await f.request([], op, selection(beta));
    await f.pub.run(false);
    expect(f.read(paths(op).log).result.status).toBe('done');
    expect(live(f).perks[140]).toEqual(before.perks[140]);
  });

  it('refills existing published text independently of unrelated saved-only names', async () => {
    const f = await inPlaceFixture();
    f.change({ 'tooltips/140.json': tooltip(140, 'Literal #Extra') });
    await f.request([140]);
    await f.pub.run(false);
    expect(f.read(paths(A).log).result.status).toBe('done');
    const extra = { ...structuredClone(f.entry), id: 'g_newfixture000', name: 'Extra' };
    f.change({ [`globals/entries/${extra.id}.json`]: extra });
    const before = live(f).perks[140];
    const beta = pending(f).find(({ id }) => id === f.entry.id)!;
    expect(beta.refusal).toBeUndefined();
    const op = A.replace(/1$/, '2');
    await f.request([], op, selection(beta));
    await f.pub.run(false);
    expect(f.read(paths(op).log).result.status).toBe('done');
    expect(live(f).perks[140]).toEqual(before);
  });

  it('publishes a tooltip edit when a published note contains a saved-only name', async () => {
    const f = await inPlaceFixture('title Help (\nValue #Extra\n)');
    const original = tooltip(141, 'See <title Details [Help] />');
    f.change({ 'tooltips/141.json': original });
    await f.request([141]);
    await f.pub.run(false);
    expect(f.read(paths(A).log).result.status).toBe('done');

    const pendingExtra = { ...structuredClone(f.entry), id: 'g_extraoriginal1', name: 'Extra' };
    f.change({
      [`globals/entries/${pendingExtra.id}.json`]: pendingExtra,
      'tooltips/141.json': tooltip(141, 'Open <title Details [Help] />'),
    });
    const next = A.replace(/1$/, '2');
    await f.request([141], next);
    await f.pub.run(false);
    expect(f.read(paths(next).log).result).toMatchObject({ status: 'done' });
    expect(live(f).perks[141]).toMatchObject({
      editor: { en: { main: 'title Help (\nValue #Extra\n)\nOpen <title Details [Help] />' } },
    });
  });

  it.each([
    ['published', 'Beta', '<title Up to #Beta [Local] />\ntitle Local (\nNote\n)'],
    ['saved', 'Newvar', '<link Up to #{Newvar} [https://example.com] />'],
    ['nested destination', 'Beta', '<link Up to #Beta [https://example.com/?q=a[b]] />'],
    ['nested line marker', 'Beta', '<link <bold/> Up to #Beta [https://example.com] />'],
    ['comment opens a tag', 'Beta', '/* <title foo */ #Beta <link b [https://example.com] />'],
  ])('refuses a %s variable in a tooltip label', async (state, name, text) => {
    const f = await inPlaceFixture();
    const saved = { ...structuredClone(f.entry), id: 'g_savedlabelcase00', name: 'Newvar' };
    f.change({
      [`globals/entries/${saved.id}.json`]: saved,
      'tooltips/142.json': tooltip(142, text),
    });
    const before = f.git.head(L);
    await f.request([142]);
    await f.pub.run(false);
    expect(f.read(paths(A).log).result).toMatchObject({
      status: 'rejected',
      error: expect.stringContaining(
        `Shared variables can't be used inside a title or link label: #${name}.`,
      ),
    });
    expect(f.git.head(L)).toBe(before);
    if (state === 'published') {
      f.change({
        'tooltips/142.json': tooltip(
          142,
          'var Beta = 10\n<link Up to #Beta [https://example.com] />\n// <link #Missing [https://example.com] />',
        ),
      });
      const next = A.replace(/1$/, '2');
      await f.request([142], next);
      await f.pub.run(false);
      expect(f.read(paths(next).log).result.status).toBe('done');
      expect(formatV2Text(live(f), 142, 'en')).toContain('Up to 10');
      expect(Buffer.from(buildLegacy(live(f), 'clarity')).toString()).toContain('Up to 10');
      const affected = pending(f).find(({ id }) => id === f.entry.id)!;
      expect(affected.affected).not.toContain(142);
      const change = A.replace(/1$/, '3');
      await f.request([], change, selection(affected));
      await f.pub.run(false);
      expect(f.read(paths(change).log).result.status).toBe('done');
      expect(formatV2Text(live(f), 142, 'en')).toContain('Up to 10');
    }
  });

  it.each([
    ['titles', '<title Up to #Beta [Local] />'],
    ['exports', '<link Up to #{Beta} [https://example.com] />'],
    ['titles', '<link Up to #Later [https://example.com] />'],
  ])('refuses a nonlocal variable in an approved %s label (%s)', async (kind, body) => {
    const f = await inPlaceFixture('title Help (\nRead\n)', kind === 'exports');
    const entry = structuredClone(f.published.entries.find((record) => record.kind === kind)!);
    entry.definitions.en!.body = body;
    f.change({ [`globals/entries/${entry.id}.json`]: entry });
    const changed = pending(f).find(({ id }) => id === entry.id)!;
    expect(changed.refusal).toContain(
      "Shared variables can't be used inside a title or link label",
    );
    const before = f.git.head(L);
    await f.request([], A, selection(changed));
    await f.pub.run(false);
    expect(f.read(paths(A).log).result.status).toBe('rejected');
    expect(f.git.head(L)).toBe(before);
  });

  it('refuses a label that uses the old variable name in a joint rename and approval', async () => {
    const f = await inPlaceFixture('title Help (\nRead\n)');
    const note = structuredClone(f.published.entries.find(({ name }) => name === 'Help')!);
    note.definitions.en!.body = '<link Up to #Beta [https://example.com] />';
    const renamed = {
      ...f.published.entries.find(({ name }) => name === 'Beta')!,
      name: 'Magnitude',
    };
    f.change({ [f.entryPath]: renamed, [`globals/entries/${note.id}.json`]: note });
    const rows = pending(f);
    await f.request(
      [],
      A,
      rows.filter(({ id }) => id === note.id || id === renamed.id).flatMap(selection),
    );
    await f.pub.run(false);
    expect(f.read(paths(A).log).result.globalRefusals).toEqual(
      expect.arrayContaining([{ id: note.id, error: expect.stringContaining('label: #Beta') }]),
    );
  });

  it.each(['rename', 'remove'] as const)(
    'refuses a %s when a published source uses an untracked variable',
    async (operation) => {
      const f = await inPlaceFixture();
      const source = tooltip(141, 'See https://example.com/#Beta now');
      const entry =
        operation === 'rename'
          ? { ...f.entry, name: 'Magnitude' }
          : { ...f.entry, tombstone: { by: 'alice', at: new Date(now).toISOString() } };
      f.change({
        [f.entryPath]: entry,
        'live/tooltips/141.json': source,
        'tooltips/141.json': source,
      });
      const row = pending(f).find(({ id }) => id === entry.id)!;
      expect(row.refusal).toContain('Tooltip 141');
      expect(row.refusal).toContain(operation === 'rename' ? 'Move #Beta' : 'still uses Beta');
      const liveBefore = f.git.head(L);
      await f.request([], A, selection(row));
      await f.pub.run(false);
      expect(f.read(paths(A).log).result.status).toBe('rejected');
      expect(f.git.head(L)).toBe(liveBefore);
    },
  );

  it('lands a tooltip edit when a published variable supplies a note whose definition is only saved', async () => {
    const f = await inPlaceFixture();
    const variable = structuredClone(f.published.entries.find(({ name }) => name === 'Alpha')!);
    variable.definitions.en!.body = 'A <title q [Extra] />';
    f.change({ [`globals/entries/${variable.id}.json`]: variable });
    await f.request([], A, selection(pending(f).find(({ id }) => id === variable.id)!));
    await f.pub.run(false);
    const source = A.replace(/1$/, '2');
    f.change({ 'tooltips/142.json': tooltip(142, 'Start #Alpha') });
    await f.request([142], source);
    await f.pub.run(false);
    expect(f.read(paths(source).log).result.status).toBe('done');
    const extra = {
      ...structuredClone(variable),
      id: 'g_fixtureextra99',
      kind: 'titles',
      name: 'Extra',
    };
    extra.definitions = {
      en: {
        body: 'A saved-only note',
        revision: 'new-note',
        updatedAt: extra.definitions.en!.updatedAt,
        updatedBy: extra.definitions.en!.updatedBy,
      },
    };
    f.change({
      [`globals/entries/${extra.id}.json`]: extra,
      'tooltips/142.json': tooltip(142, 'Edited #Alpha'),
    });
    const later = A.replace(/1$/, '3');
    await f.request([142], later);
    await f.pub.run(false);
    expect(f.read(paths(later).log).result.status).toBe('done');
    expect(live(f).perks[142]).toMatchObject({
      editor: { en: { main: 'Edited A <title q [Extra] />' } },
    });
  });

  it.each(['change', 'rename', 'create'] as const)(
    'reads whole-variable link destinations in both readers and catches an unsafe %s',
    async (operation) => {
      const f = await inPlaceFixture();
      const entry = structuredClone(f.published.entries.find(({ name }) => name === 'Beta')!);
      entry.definitions.en!.body = 'https://example.com/old';
      f.change({ [f.entryPath]: entry });
      await f.request([], A, selection(pending(f).find(({ id }) => id === entry.id)!));
      await f.pub.run(false);
      const next = A.replace(/1$/, '2');
      f.change({
        'tooltips/142.json': tooltip(142, '<link Reference [#{Beta}] /> <link Anchor [#Known] />'),
      });
      await f.request([142], next);
      await f.pub.run(false);
      expect(f.read(paths(next).log).result.status).toBe('done');
      expect(JSON.stringify(formatV2Text(live(f), 142, 'en'))).toContain('https://example.com/old');
      expect(Buffer.from(buildLegacy(live(f), 'clarity')).toString()).toContain(
        'https://example.com/old',
      );
      const proposed =
        operation === 'change'
          ? {
              ...entry,
              definitions: { en: { ...entry.definitions.en!, body: 'https://example.com/#Beta' } },
            }
          : {
              ...entry,
              name: 'Known',
              ...(operation === 'create' ? { id: 'g_fixtureknown99' } : {}),
            };
      f.change({ [`globals/entries/${proposed.id}.json`]: proposed });
      const row = pending(f).find(({ id }) => id === proposed.id);
      expect(row?.refusal).toContain('Tooltip 142');
      expect(row?.refusal).toContain(
        operation === 'change' ? 'plain, single-line destination' : 'Choose a different name',
      );
    },
  );

  it.each(['import self', 'Independent older text'])(
    'preserves the LIVE secondary %s in a refill',
    async (secondary) => {
      const f = await inPlaceFixture('', false, secondary);
      const row = pending(f).find(({ id }) => id === f.entry.id)!;
      expect(row.refusal).toBeUndefined();
      await f.request([], A, selection(row));
      await f.pub.run(false);
      expect(f.read(paths(A).log).result.status).toBe('done');
      expect(live(f).perks[141]).toMatchObject({ editor: { en: { main: '200', secondary } } });
    },
  );

  it('waits while an independent historical secondary uses the selected global', async () => {
    const f = await inPlaceFixture('', false, 'Older #Beta');
    const blocked = pending(f).find(({ id }) => id === f.entry.id)!;
    expect(blocked.refusal).toContain('older text still uses Beta');
    await f.request([141]);
    await f.pub.run(false);
    expect(f.read(paths(A).log).result.status).toBe('done');
    const next = pending(f).find(({ id }) => id === f.entry.id)!;
    expect(next.refusal).toBeUndefined();
    const op = A.replace(/1$/, '2');
    await f.request([], op, selection(next));
    await f.pub.run(false);
    expect(f.read(paths(op).log).result.status).toBe('done');
  });

  it('refuses unsupported markup introduced by a refilled definition', async () => {
    const f = await inPlaceFixture();
    f.entry.definitions.en!.body = '#{ x';
    f.change({ [f.entryPath]: f.entry });
    const row = pending(f).find(({ id }) => id === f.entry.id)!;
    expect(row.refusal).toContain('still holds unlowered markup');
    await f.request([], A, selection(row));
    await f.pub.run(false);
    expect(f.read(paths(A).log).result.status).toBe('rejected');
  });

  it.each(['note', 'export', 'rename'] as const)(
    'waits for the unpublished shared name in an approved %s definition',
    async (kind) => {
      const isExport = kind === 'export';
      const f = await inPlaceFixture(isExport ? '' : 'title Help (\nValue #Beta\n)', isExport);
      if (!isExport) {
        f.change({ 'tooltips/141.json': tooltip(141, 'See <title Details [Help] />') });
        await f.request([141], A);
        await f.pub.run(false);
        expect(f.read(paths(A).log).result.status).toBe('done');
      }
      const approved = structuredClone(
        f.published.entries.find((entry) =>
          isExport ? entry.kind === 'exports' : entry.name === 'Help',
        )!,
      );
      const name = kind === 'rename' ? 'Magnitude' : 'Newvar';
      const dependency =
        kind === 'rename'
          ? { ...structuredClone(f.published.entries.find(({ id }) => id === f.entry.id)!), name }
          : { ...structuredClone(f.entry), id: 'g_zznewvarfixture0', name };
      approved.definitions.en!.body = `Changed value #${name}`;
      approved.revision = approved.definitions.en!.revision = 'new-shared-reference';
      f.change({
        [`globals/entries/${approved.id}.json`]: approved,
        [`globals/entries/${dependency.id}.json`]: dependency,
      });
      const before = f.git.head(L);
      const rows = pending(f);
      const changed = rows.find(({ id }) => id === approved.id)!;
      expect(changed.refusal).toContain(`Publish the shared change for ${name} first.`);
      const blocked = A.replace(/1$/, '2');
      await f.request([], blocked, selection(changed));
      await f.pub.run(false);
      expect(f.read(paths(blocked).log).result).toMatchObject({ status: 'rejected' });
      expect(f.git.head(L)).toBe(before);
      const selected = A.replace(/1$/, '3');
      await f.request([], selected, [
        ...selection(changed),
        ...selection(rows.find(({ id }) => id === dependency.id)!),
        ...(kind === 'note' ? [{ id: f.entry.id, expected: '0'.repeat(64) }] : []),
      ]);
      await f.pub.run(false);
      const result = f.read(paths(selected).log).result;
      expect(result).toMatchObject({
        status: 'done',
        globals: expect.arrayContaining([approved.id, dependency.id]),
      });
      if (kind === 'note')
        expect(result.globalRefusals).toEqual([
          { id: f.entry.id, error: expect.stringContaining('changed. Review it again.') },
        ]);
      const filled = `Changed value ${dependency.definitions.en!.body}`;
      expect(Buffer.from(buildLegacy(live(f), isExport ? 'dim' : 'clarity')).toString()).toContain(
        filled,
      );
      expect(formatV2Text(live(f), isExport ? 140 : 141, 'en')).toContain(filled);
    },
  );

  it('keeps independent publication available with a missing published snapshot and a pending rename', async () => {
    const f = await inPlaceFixture();
    f.change({
      'live/tooltips/141.json': undefined,
      'tooltips/140.json': tooltip(140, 'Independent edit'),
      [f.entryPath]: { ...f.entry, name: 'Magnitude' },
    });
    const row = pending(f).find(({ id }) => id === f.entry.id)!;
    expect(row.refusal).toContain('Missing the published source for tooltip 141');
    await f.request([140]);
    await f.pub.run();
    expect(f.read(paths(A).log).result.status).toBe('done');
    expect(live(f).perks[140]).toMatchObject({ editor: { en: { main: 'Independent edit' } } });
  });

  it('falls back and restores the whole importing tooltip with its shared translation', async () => {
    const f = await inPlaceFixture();
    const source = tooltip(140, 'English source\nexport Info (\nEnglish info #Beta\n)');
    source.text.de = cell('Deutsche Quelle\nexport Info (\nDeutsche Info #Beta\n)');
    const independent = tooltip(141, 'Other source\nexport Details (\nEnglish details\n)');
    independent.text.de = cell('Andere Quelle\nexport Details (\nDeutsche Details\n)');
    const imports = '\nimport Info from 140\nimport Details from 141';
    const reader = tooltip(142, `English introduction${imports}`);
    reader.text.de = cell(`Deutsche Einleitung${imports}`);
    f.change({
      'tooltips/140.json': source,
      'tooltips/141.json': independent,
      'tooltips/142.json': reader,
    });
    await f.request([140, 141, 142]);
    await f.pub.run(false);
    expect(f.read(paths(A).log).result.status).toBe('done');
    const renderedGerman = () => {
      const database = expandAliases(live(f).perks);
      return JSON.stringify(
        descriptionConverter({
          database,
          hash: 142,
          language: 'de',
          editorType: 'main',
          descriptionString: database[142].editor.de!.main,
        }),
      );
    };
    expect(renderedGerman()).toContain('Deutsche Details');

    const original = f.published.entries.find(({ id }) => id === f.entry.id)!;
    const withdrawn = structuredClone(original);
    delete withdrawn.definitions.de;
    f.change({ [f.entryPath]: withdrawn });
    const row = pending(f).find(({ id }) => id === original.id)!;
    expect(row.affected).toContain(142);
    const withdraw = A.replace(/1$/, '2');
    await f.request([], withdraw, selection(row));
    await f.pub.run(false);
    expect(f.read(paths(withdraw).log).result.status).toBe('done');
    expect(live(f).perks[142]).toMatchObject({
      editor: {
        de: {
          main: `English introduction${imports}`,
          englishFallback: true,
        },
      },
    });
    expect(renderedGerman()).toContain('English details');
    expect(renderedGerman()).not.toContain('Deutsche Details');
    for (const languageFiles of ['combined', 'perLanguage'] as const) {
      const text = formatV2Text(live(f), 142, 'de', languageFiles);
      expect(text).toContain('English details');
      expect(text).not.toContain('Deutsche Details');
    }

    reader.text.en!.text = `Updated English introduction${imports}`;
    f.change({ 'tooltips/142.json': reader });
    const republish = A.replace(/1$/, '3');
    await f.request([142], republish);
    await f.pub.run(false);
    expect(f.read(paths(republish).log).result.status).toBe('done');
    expect(live(f).perks[142]).toMatchObject({
      editor: {
        de: {
          main: `Updated English introduction${imports}`,
          englishFallback: true,
        },
      },
    });
    f.change({ [f.entryPath]: original });
    const restore = A.replace(/1$/, '4');
    await f.request([], restore, selection(pending(f).find(({ id }) => id === original.id)!));
    await f.pub.run(false);
    expect(f.read(paths(restore).log).result.status).toBe('done');
    const restored = live(f).perks[142];
    expect('editor' in restored && restored.editor.de).toEqual({
      main: `Deutsche Einleitung${imports}`,
      secondary: `Deutsche Einleitung${imports}`,
    });

    reader.text.en!.text = 'English text with a different import\nimport Details from 141';
    f.change({ 'tooltips/142.json': reader });
    const independentEnglish = A.replace(/1$/, '5');
    await f.request([142], independentEnglish);
    await f.pub.run(false);
    expect(f.read(paths(independentEnglish).log).result.status).toBe('done');
    f.change({ [f.entryPath]: withdrawn });
    const again = A.replace(/1$/, '6');
    await f.request([], again, selection(pending(f).find(({ id }) => id === original.id)!));
    await f.pub.run(false);
    expect(renderedGerman()).toContain('English details');
    const marker = f.read('live/pushed.json')[142];
    const authored = f.read('live/tooltips/142.json');
    source.text.de!.text = 'Deutsche Quelle\nexport Info (\nDeutsche Info ohne geteilten Wert\n)';
    f.change({ 'tooltips/140.json': source });
    const sourceOnly = A.replace(/1$/, '7');
    await f.request([140], sourceOnly);
    await f.pub.run(false);
    expect(f.read(paths(sourceOnly).log).result.status).toBe('done');
    expect(f.pub.receipt(f.pub.head(f.options.liveBranch), sourceOnly)).toMatchObject({
      changed: [140],
      inPlace: { refills: [142] },
    });
    expect(renderedGerman()).toContain('Deutsche Einleitung');
    expect(renderedGerman()).toContain('Deutsche Info ohne geteilten Wert');
    expect(renderedGerman()).toContain('Deutsche Details');
    expect(f.read('live/pushed.json')[142]).toBe(marker);
    expect(f.read('live/tooltips/142.json')).toEqual(authored);
  });

  it.each(['main', 'named'] as const)(
    'publishes English changes through a %s import after fallback',
    async (kind) => {
      const f = await inPlaceFixture();
      const withdrawn = structuredClone(f.published.entries.find(({ id }) => id === f.entry.id)!);
      delete withdrawn.definitions.de;
      f.change({ [f.entryPath]: withdrawn });
      const publish = async (
        number: string,
        hashes: number[],
        globals?: ReturnType<typeof selection>,
      ) => {
        const op = A.replace(/1$/, number);
        await f.request(hashes, op, globals);
        await f.pub.run(false);
        expect(f.read(paths(op).log).result).toMatchObject({ status: 'done' });
      };
      await publish('1', [], selection(pending(f).find(({ id }) => id === withdrawn.id)!));
      const source = (english: string, german: string) => {
        const text = (body: string) =>
          kind === 'named' ? `Source\nexport Info (\n${body}\n)` : body;
        const doc = tooltip(140, text(english));
        doc.text.de = cell(text(german));
        return doc;
      };
      const imported = kind === 'named' ? 'Info' : 'main';
      const reader = tooltip(142, `English introduction\nimport ${imported} from 140`);
      reader.text.de = cell(`Deutsche Einleitung\nimport ${imported} from 140`);
      f.change({
        'tooltips/140.json': source('English info', 'Deutsche Info'),
        'tooltips/142.json': reader,
      });
      await publish('2', [140, 142]);
      f.change({ 'tooltips/140.json': source('English info #Beta', 'Deutsche Info #Beta') });
      await publish('3', [140]);
      expect(live(f).perks[142]).toMatchObject({ editor: { de: { englishFallback: true } } });
      f.change({
        'tooltips/140.json': source('Updated English info #Beta', 'Deutsche Info #Beta'),
      });
      await publish('4', [140]);
      withdrawn.definitions.en!.body = '25';
      withdrawn.revision = withdrawn.definitions.en!.revision = 'beta-25';
      f.change({ [f.entryPath]: withdrawn });
      await publish('5', [], selection(pending(f).find(({ id }) => id === withdrawn.id)!));
      const database = expandAliases(live(f).perks);
      const rendered = descriptionConverter({
        database,
        hash: 142,
        language: 'de',
        editorType: 'main',
        descriptionString: database[142].editor.de!.main,
      });
      expect(JSON.stringify(rendered)).toContain('Updated English info 25');
      expect(formatV2Text(live(f), 142, 'de')).toContain('Updated English info 25');
      if (kind === 'main') {
        const prior = f.git.head(L);
        f.change({ 'tooltips/140.json': source('import main from 999', 'Deutsche Info #Beta') });
        const refused = A.replace(/1$/, '6');
        await f.request([140], refused);
        await f.pub.run(false);
        expect(f.read(paths(refused).log).result).toMatchObject({ status: 'rejected' });
        expect(f.git.head(L)).toBe(prior);
      }
    },
  );

  it('validates inactive removal without reading its discarded markup', async () => {
    const f = await inPlaceFixture();
    f.change({
      'config/inactive.json': { 141: { by: 1, at: new Date(now).toISOString() } },
      'tooltips/141.json': tooltip(141, 'import main from 2'),
    });
    await f.request([141]);
    await f.pub.run(false);
    expect(f.read(paths(A).log).result.status).toBe('done');
    expect(live(f).perks[141]).toBeUndefined();
  });

  it('lets authorized translators withdraw and restore only their own translations', async () => {
    const f = await inPlaceFixture();
    const original = f.published.entries.find(({ id }) => id === f.entry.id)!;
    const port = await mutationPort(f, {
      role: 'translator',
      login: 'translator',
      languages: ['de'],
    });
    const remove = (lang?: string) =>
      port.post(`/${original.id}/remove`, {
        operation: 'remove',
        id: original.id,
        revision: f.read(f.entryPath).revision,
        lang,
      });
    const draft = f.read('tooltips/141.json') as Tooltip;
    draft.text.en!.text = 'English 6.5 #Beta';
    draft.text.de!.text = 'Unveröffentlicht 6,5 #Beta';
    f.change({ [f.entryPath]: original, 'tooltips/141.json': draft });
    const before = live(f);
    for (const lang of ['fr', 'en', undefined]) expect((await remove(lang)).status).toBe(403);
    expect((await remove('de')).status).toBe(200);
    expect(live(f)).toEqual(before);
    expect(pending(f).find(({ id }) => id === original.id)?.languages.de?.after).toBeNull();
    const originalTranslation = original.definitions.de!.body;
    await f.globals.maintainAuthored();
    expect((await port.edit(original.id, originalTranslation, 'de')).status).toBe(200);
    expect(pending(f).find(({ id }) => id === original.id)).toBeUndefined();

    expect((await remove('de')).status).toBe(200);
    await f.request([], A, selection(pending(f).find(({ id }) => id === original.id)!));
    await f.pub.run();
    expect(live(f).perks[141]).toMatchObject({
      editor: { en: { main: '20' }, de: { main: '20', englishFallback: true } },
    });
    expect(f.read('tooltips/141.json')).toEqual(draft);
    const publishDraft = A.replace(/1$/, '2');
    await f.request([141], publishDraft);
    await f.pub.run(false);
    expect(live(f).perks[141]).toMatchObject({
      editor: { de: { main: 'English 6.5 20', englishFallback: true } },
    });

    expect((await port.edit(original.id, originalTranslation, 'de')).status).toBe(200);
    const restore = A.replace(/1$/, '3');
    await f.request([], restore, selection(pending(f).find(({ id }) => id === original.id)!));
    await f.pub.run(false);
    const restored = live(f).perks[141];
    expect('editor' in restored && restored.editor.de).toEqual({
      main: 'Unveröffentlicht 6,5 80',
      secondary: 'Unveröffentlicht 6,5 80',
    });
  });

  it('keeps proof and role checks for whole removals and for withdrawals before activation', async () => {
    const f = await inPlaceFixture();
    const translator = await mutationPort(f, {
      role: 'translator',
      login: 'translator',
      languages: ['de'],
    });
    const editor = await mutationPort(f, { role: 'editor', login: 'bob' });
    const maintainer = await mutationPort(f);
    const id = f.entry.id;
    const withdraw = (port: typeof maintainer, lang?: string) =>
      port.post(`/${id}/remove`, {
        operation: 'remove',
        id,
        revision: f.read(f.entryPath).revision,
        lang,
      });
    expect((await withdraw(maintainer)).status).toBe(503);
    expect((await withdraw(maintainer, 'en')).status).toBe(503);
    expect((await withdraw(editor)).status).toBe(403);
    expect((await withdraw(editor, 'en')).status).toBe(403);
    f.change({ [globalsInPlacePath]: undefined });
    expect((await withdraw(translator, 'de')).status).toBe(403);
    expect((await withdraw(maintainer, 'de')).status).toBe(503);
  });

  it('rechecks use of a withdrawn English definition when its global is approved', async () => {
    const f = await inPlaceFixture();
    const before = live(f);
    delete f.entry.definitions.en;
    f.change({ [f.entryPath]: f.entry });
    const beta = pending(f).find(({ id }) => id === f.entry.id)!;
    expect(beta.refusal).toContain('still uses Beta');
    await f.request([], A, selection(beta));
    await f.pub.run(false);
    expect(f.read(paths(A).log).result.status).toBe('rejected');
    expect(live(f)).toEqual(before);
  });

  it('rejects a released catalogue that disagrees with legacy LIVE before writing the hold', async () => {
    const f = await fixture('', false, true, 100);
    const published = structuredClone(f.published);
    published.entries.find(({ name }) => name === 'Beta')!.definitions.en!.body = '999';
    const pin = f.read('.publisher/PIN');
    pin.capabilities.push(globalsInPlaceCapability);
    f.change({
      '.publisher/PIN': pin,
      'globals/live/converter-v2-test.json': {
        version: 1,
        destination: f.options.liveBranch,
        store: published,
      },
    });
    mkdirSync('.agents', { recursive: true });
    const root = mkdtempSync(resolve('.agents/globals-in-place-migration-'));
    execFileSync('git', ['init', '--bare', root], { stdio: 'pipe' });
    execFileSync('git', ['--git-dir', root, 'config', 'publisher.simulator', 'true']);
    const git = new LocalRepository(root);
    const copy = (ref: string) =>
      git.commit(
        undefined,
        Object.fromEntries(
          Object.entries(f.git.tree(f.git.head(ref)!)).map(([path, blob]) => [
            path,
            git.writeBlob(f.git.blob(blob)),
          ]),
        ),
        'Legacy fixture',
      );
    const data = copy(D),
      currentLive = copy(L);
    git.cas(D, undefined, data);
    git.cas(L, undefined, currentLive);
    const inputs = {
      catalog: { items: {}, categories: [] },
      inventoryItems: {},
      sandboxPerks: {},
    };
    const publisher = new Publisher(git, f.options);
    await expect(dryRunGlobalsMigration(publisher, inputs)).rejects.toThrow(
      'Published snapshots differ from actual live inputs',
    );
    expect(git.head(D)).toBe(data);
    expect(git.head(L)).toBe(currentLive);

    const aligned = git.commit(
      data,
      {
        ...git.tree(data),
        'globals/live/converter-v2-test.json': git.writeBlob(
          encode({
            version: 1,
            destination: f.options.liveBranch,
            store: f.published,
          }),
        ),
      },
      'Use the aligned catalogue',
    );
    git.cas(D, data, aligned);
    const legacy = publisher.read<LegacyInput>(git.tree(currentLive), 'liveDescriptions.json')!;
    const library = legacy.perks[2];
    if (!('editor' in library) || !library.editor.en) throw new Error('Missing variable library');
    library.editor.en.secondary = 'var Beta = 999';
    const overriding = git.commit(
      currentLive,
      {
        ...git.tree(currentLive),
        'liveDescriptions.json': git.writeBlob(encode(legacy)),
      },
      'Secondary library overrides the catalogue',
    );
    git.cas(L, currentLive, overriding);
    await expect(dryRunGlobalsMigration(publisher, inputs)).rejects.toThrow(
      'Published definitions differ from the effective LIVE libraries',
    );
    expect(git.head(D)).toBe(aligned);
    expect(git.head(L)).toBe(overriding);

    const stale = structuredClone(f.published);
    stale.entries.find(({ name }) => name === 'Beta')!.definitions.en!.updatedAt =
      '2026-06-01T00:00:00Z';
    const staleCatalogue = git.commit(
      aligned,
      {
        ...git.tree(aligned),
        'globals/live/converter-v2-test.json': git.writeBlob(
          encode({
            version: 1,
            destination: f.options.liveBranch,
            store: stale,
          }),
        ),
      },
      'Keep legacy output while recording stale German shared text',
    );
    git.cas(D, aligned, staleCatalogue);
    git.cas(L, overriding, currentLive);
    await expect(dryRunGlobalsMigration(publisher, inputs)).rejects.toThrow(
      'Published availability for Beta (de) differs from LIVE',
    );
    expect(git.head(D)).toBe(staleCatalogue);
    expect(git.head(L)).toBe(currentLive);

    const staleAggregate = structuredClone(f.published);
    staleAggregate.aggregates.find(
      ({ document }) => document.hash === 2,
    )!.languages.en!.metadata.updatedAt = '2026-06-01T00:00:00Z';
    const projected = projectGlobals(staleAggregate);
    const fallbackLibrary = exportLegacy(Object.values(projected), 0, f.options.facts)[2];
    expect(fallbackLibrary).toMatchObject({ editor: { de: { englishFallback: true } } });
    const fallbackLive = git.commit(
      currentLive,
      {
        ...git.tree(currentLive),
        'liveDescriptions.json': git.writeBlob(
          encode({
            ...legacy,
            perks: { ...legacy.perks, 2: fallbackLibrary },
          }),
        ),
      },
      'Fallback for the whole German variable library',
    );
    const fallbackCatalogue = git.commit(
      aligned,
      {
        ...git.tree(aligned),
        'globals/layout.json': git.writeBlob(
          encode({ version: 1, aggregates: staleAggregate.aggregates }),
        ),
        'live/tooltips/2.json': git.writeBlob(encode(projected[2])),
        'tooltips/2.json': git.writeBlob(encode(projected[2])),
        'globals/live/converter-v2-test.json': git.writeBlob(
          encode({
            version: 1,
            destination: f.options.liveBranch,
            store: staleAggregate,
          }),
        ),
      },
      'Catalogue with current German definitions but an older aggregate',
    );
    git.cas(D, staleCatalogue, fallbackCatalogue);
    git.cas(L, currentLive, fallbackLive);
    const migrationInputs = {
      catalog: { items: { 140: { categoryId: 'perk' } }, categories: [{ id: 'perk' }] },
      inventoryItems: { 140: { displayProperties: { description: 'Fixture game text' } } },
      sandboxPerks: {},
    };
    await expect(dryRunGlobalsMigration(publisher, migrationInputs)).rejects.toThrow(
      /library 2.*de.*falls back/i,
    );
    expect(git.head(D)).toBe(fallbackCatalogue);
    expect(git.head(L)).toBe(fallbackLive);
    git.cas(D, fallbackCatalogue, aligned);
    git.cas(L, fallbackLive, currentLive);
    const label = '<link Up to #{Beta} [https://example.com] />';
    const labelledDraft = git.commit(
      aligned,
      {
        ...git.tree(aligned),
        'tooltips/142.json': git.writeBlob(encode(tooltip(142, label))),
      },
      'Keep a legacy shared variable label in an authored draft',
    );
    git.cas(D, aligned, labelledDraft);
    await expect(dryRunGlobalsMigration(publisher, migrationInputs)).rejects.toThrow(
      "Tooltip 142 (en): Shared variables can't be used inside a title or link label: #Beta.",
    );
    expect(git.head(D)).toBe(labelledDraft);
    expect(git.head(L)).toBe(currentLive);
    git.cas(D, labelledDraft, aligned);

    const labelledLive = publisher.read<LegacyInput>(
      git.tree(currentLive),
      'liveDescriptions.json',
    )!;
    const row = labelledLive.perks[142];
    if (!('editor' in row) || !row.editor.en) throw new Error('Missing fixture tooltip');
    row.editor.en.secondary = label;
    const labelledSecondary = git.commit(
      currentLive,
      {
        ...git.tree(currentLive),
        'liveDescriptions.json': git.writeBlob(encode(labelledLive)),
      },
      'Keep a legacy shared variable label in a historical secondary',
    );
    git.cas(L, currentLive, labelledSecondary);
    await expect(dryRunGlobalsMigration(publisher, migrationInputs)).rejects.toThrow(
      "LIVE tooltip 142 (en): Shared variables can't be used inside a title or link label: #Beta.",
    );
    expect(git.head(D)).toBe(aligned);
    expect(git.head(L)).toBe(labelledSecondary);
    git.cas(L, labelledSecondary, currentLive);

    for (const step of ['hold', 'live', 'record'] as const) {
      await expect(
        dryRunGlobalsMigration(publisher, migrationInputs, (checkpoint) => {
          if (checkpoint === step) throw new Error(`Interrupted after ${step}`);
        }),
      ).rejects.toThrow(`Interrupted after ${step}`);
      const resumed = await dryRunGlobalsMigration(publisher, migrationInputs);
      expect(resumed.files).toHaveLength(34);
      expect(resumed.olderSecondaries).toEqual([]);
      restoreGlobalsMigration(publisher);
      expect(git.head(D)).toBe(aligned);
      expect(git.head(L)).toBe(currentLive);
    }
  }, 90_000);
});
async function mutationPort(
  f: Awaited<ReturnType<typeof fixture>>,
  access: GlobalsContext['access'] = { role: 'maintainer', login: 'alice' },
) {
  for (const entry of f.saved.entries)
    f.change({
      [(await namePaths(entry.kind, entry.name)).claim]: {
        id: entry.id,
        kind: entry.kind,
        name: entry.name,
      },
    });
  const storage: GlobalsStorage = {
    async readFiles(paths, head) {
      const tree = f.git.tree(head);
      return paths.map((path) =>
        tree[path]
          ? { sha: tree[path], bytes: new TextEncoder().encode(f.git.blob(tree[path])) }
          : null,
      );
    },
    async commit(head, files) {
      if (head !== f.git.head(D)) throw new RefRace();
      f.change(files);
      return f.git.head(D)!;
    },
  };
  const load = async (): Promise<GlobalsContext> => ({
    storage,
    head: f.git.head(D)!,
    sources: await f.globals.sources(f.current(), f.git.head(L)!),
    access,
    user: { id: access.login === 'alice' ? 1 : 2, login: access.login },
    repository: f.options.repo,
    destinations: [f.options.liveBranch],
  });
  const post = (path: string, mutation: object) =>
    globalsHandler(
      new Request(`https://api.invalid/globals${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedHead: f.git.head(D),
          mutation,
        }),
      }),
      load,
    );
  const edit = (id: string, body: string, lang = 'en') =>
    post(`/${id}/body`, {
      operation: 'edit',
      id,
      revision: f.read(`globals/entries/${id}.json`).revision,
      lang,
      body,
    });
  return { load, edit, post };
}

describe('in-place atomic landing fences', () => {
  const sibling = '01K95H00000000000000000002';
  const siblingKick = 'publish/kicks/' + sibling + '-12345.json';

  async function pendingTooltip() {
    const f = await inPlaceFixture();
    f.change({ 'tooltips/142.json': tooltip(142, 'Edited tooltip') });
    await f.globals.maintainAuthored();
    await f.request([142]);
    return f;
  }

  it.each(['beforeCas', 'beforeAtomic'] as const)(
    'publishes the signed 28 rows when its own kick advances DATA at %s',
    async (race) => {
      const f = await inPlaceFixture();
      const hashes = [142, ...Array.from({ length: 27 }, (_, index) => 200 + index)];
      f.change(
        Object.fromEntries(
          hashes.map((hash) => {
            f.options.facts[hash] = { name: String(hash), type: 'Weapon Perk' };
            return ['tooltips/' + hash + '.json', tooltip(hash, 'Edited ' + hash)];
          }),
        ),
      );
      await f.globals.maintainAuthored();
      await f.request(hashes);
      const kick = 'publish/kicks/' + A + '-12345.json';
      f.git[race] = () => f.change({ [kick]: { opId: A } });
      await f.pub.operation(A);
      expect(f.read(paths(A).log).result.status).toBe('done');
      expect(f.read(kick)).toEqual({ opId: A });
      const output = f.pub.read<LegacyInput>(f.git.tree(f.git.head(L)!), 'liveDescriptions.json')!;
      for (const hash of hashes)
        expect(output.perks[hash]).toMatchObject({ editor: { en: { main: 'Edited ' + hash } } });
    },
  );

  it.each(['enqueue', 'drain', 'round trip'] as const)(
    'records the signed tooltip during a name-proof %s',
    async (action) => {
      const f = await inPlaceFixture();
      if (action === 'round trip')
        f.change({ 'tooltips/142.json': tooltip(142, 'var NeverUsed = 42\n#NeverUsed') });
      await f.globals.maintainAuthored();
      const proofId = '3283270b-d921-468b-8d09-6b4a90659d30';
      const proofPath = 'globals/retries/' + proofId + '.json';
      const proofRequest = {
        version: 1,
        type: 'name-proof',
        id: proofId,
        operation: 'create',
        kind: 'variables',
        name: 'NeverUsed',
        globalId: null,
        revision: null,
        expectedHead: f.git.head(D),
        sources: await f.globals.sources(f.current(), f.git.head(L)!),
        by: 'alice',
        at: new Date(now).toISOString(),
      };
      if (action === 'drain') f.change({ [proofPath]: proofRequest });
      await f.request([142]);
      const originalHead = f.git.head(D);
      const originalTree = f.current();
      const record = f.pub.record.bind(f.pub);
      const completed = '01K95H00000000000000000003';
      vi.spyOn(f.pub, 'record').mockImplementationOnce(async (...args) => {
        expect(args[6]).toBeDefined();
        if (action === 'round trip') {
          f.change({ [proofPath]: proofRequest });
          await f.globals.maintainAuthored();
          expect(f.git.head(D)).not.toBe(originalHead);
          expect(f.current()).toEqual(originalTree);
        } else {
          await f.request([142], sibling);
          f.change({
            [siblingKick]: { opId: sibling },
            ['publish/kicks/batch-' + sibling + '-12345.json']: {},
            ['publish/kicks/current-save-' + sibling + '.json']: {},
            'publish/kicks/due-202611231625-12345.json': {},
            [paths(completed).log]: { result: {} },
          });
          if (action === 'drain') await f.globals.maintainAuthored();
          else f.change({ [proofPath]: proofRequest });
        }
        return record(...args);
      });
      await f.pub.operation(A);
      expect(f.read(paths(A).log).result.status).toMatch(/done|unchanged/);
      expect(f.current()[proofPath] !== undefined).toBe(action === 'enqueue');
      const clashProof = (await namePaths('variables', 'NeverUsed')).proof;
      if (action === 'round trip') {
        expect(f.current()[clashProof]).toBeUndefined();
      } else {
        expect(f.current()[paths(sibling).request]).toBeDefined();
        expect(f.current()[paths(completed).log]).toBeDefined();
        expect(f.read(clashProof).name).toBe('NeverUsed');
      }
    },
  );

  it.each([
    ['upload markers', { 'live/pushed.json': { 142: 'tampered' } }],
    ['a non-proof retry', { 'globals/retries/3283270b-d921-468b-8d09-6b4a90659d30.json': {} }],
    ['an unrelated addition', { toString: { other: true } }],
    ['a retired release certificate', { 'globals/proofs/publication/test/142-en.json': {} }],
    ['a frozen LIVE snapshot', { 'live/tooltips/141.json': tooltip(141, 'Changed snapshot') }],
  ] as const)('rejects a sibling kick accompanied by %s', async (_label, changes) => {
    const f = await pendingTooltip();
    const live = f.git.head(L);
    let pushed: string | undefined;
    f.git.beforeAtomic = () => {
      f.change({ [siblingKick]: {}, ...changes });
      pushed = f.current()['live/pushed.json'];
    };
    await f.pub.operation(A);
    expect(f.read(paths(A).log).result).toMatchObject({
      status: 'rejected',
      error: expect.stringContaining('Global receipt identity mismatch'),
    });
    expect(f.git.head(L)).toBe(live);
    expect(f.read('live/tooltips/142.json')).toEqual(tooltip(142, 'unrelated'));
    expect(pushed).toBeDefined();
    expect(f.current()['live/pushed.json']).toBe(pushed);
  });

  it.each(['100755', undefined])('rejects a retry kick with file mode %s', async (mode) => {
    const f = await pendingTooltip();
    const git: Repository = f.git;
    git.treeModes = (head) => {
      const modes = Object.fromEntries(Object.keys(git.tree(head)).map((path) => [path, '100644']));
      if (Object.hasOwn(modes, siblingKick)) {
        if (mode) modes[siblingKick] = mode;
        else delete modes[siblingKick];
      }
      return modes;
    };
    const live = f.git.head(L);
    f.git.beforeAtomic = () => f.change({ [siblingKick]: { opId: sibling } });
    await f.pub.operation(A);
    expect(f.read(paths(A).log).result).toMatchObject({
      status: 'rejected',
      error: expect.stringContaining('Global receipt identity mismatch'),
    });
    expect(f.git.head(L)).toBe(live);
  });

  it('detects an explicit empty config subtree alongside an otherwise valid kick', async () => {
    const f = await pendingTooltip();
    const root = mkdtempSync(resolve(tmpdir(), 'globals-empty-config-'));
    try {
      execFileSync('git', ['init', '--bare', root], { stdio: 'pipe' });
      execFileSync('git', ['--git-dir', root, 'config', 'publisher.simulator', 'true']);
      const git = new LocalRepository(root);
      const pub = new Publisher(git, f.options);
      const tree = Object.fromEntries(
        Object.entries(f.current()).map(([path, oid]) => [path, git.writeBlob(f.git.blob(oid))]),
      );
      const source = git.commit(undefined, tree, 'Freeze active editor data');
      const kicked = git.commit(
        source,
        { ...tree, [siblingKick]: git.writeBlob('{}') },
        'Kick sibling',
      );
      expect(pub['sourceAdvance'](source, kicked, git.tree(kicked), A)).toBe('bookkeeping');

      const empty = git.git(['mktree'], '').trim();
      const config = git.git(['rev-parse', kicked + ':config']).trim();
      const changedConfig = git
        .git(['mktree'], git.git(['ls-tree', config]) + '040000 tree ' + empty + '\tempty\n')
        .trim();
      const changedRoot = git
        .git(['mktree'], git.git(['ls-tree', kicked]).replace(config, changedConfig))
        .trim();
      const changed = git
        .git(['commit-tree', changedRoot, '-p', source], 'Kick and change config identity')
        .trim();
      expect(git.tree(changed)).toEqual(git.tree(kicked));
      expect(git.treeModes(changed)['config/empty']).toBe('040000');
      expect(pub['sourceAdvance'](source, changed, git.tree(changed), A)).toBe('blocked');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records the candidate that wins its exact replacement lease', async () => {
    const f = await pendingTooltip();
    f.git.beforeAtomic = () =>
      f.change({ 'tooltips/141.json': tooltip(141, 'Saved concurrently') });
    const create = f.pub.createCandidate.bind(f.pub);
    let winner: string | undefined;
    vi.spyOn(f.pub, 'createCandidate').mockImplementation((opId, blob, live, receipt, previous) => {
      if (previous) {
        winner = f.pub.buildCandidate(live, receipt);
        f.git.beforeCas = () => f.git.cas(paths(opId).candidate, previous, winner);
      }
      return create(opId, blob, live, receipt, previous);
    });
    await f.pub.operation(A);
    expect(winner).toBeDefined();
    expect(f.read(paths(A).log).candidateCommit).toBe(winner);
    expect(f.git.head(L)).toBe(winner);
  });

  it('reconciles another publisher completing recovery during authored upkeep', async () => {
    const f = await pendingTooltip();
    f.git.beforeAtomic = () =>
      f.change({ 'tooltips/141.json': tooltip(141, 'Saved concurrently') });
    const maintain = GlobalsPublisher.prototype.maintainAuthored;
    const spy = vi
      .spyOn(GlobalsPublisher.prototype, 'maintainAuthored')
      .mockImplementationOnce(async function (this: GlobalsPublisher, head) {
        const checked = await maintain.call(this, head);
        await new Publisher(f.git, f.options).operation(A);
        return checked;
      });
    try {
      await f.pub.operation(A);
    } finally {
      spy.mockRestore();
    }
    expect(f.read(paths(A).log).candidateCommit).toBe(f.git.head(L));
    expect(f.git.additions(f.git.head(D)!, paths(A).log)).toHaveLength(1);
    expect(f.git.head(paths(A).candidate)).toBeUndefined();
  });

  it.each([true, false])(
    'reconciles a candidate removed after observation only if recorded (recorded=%s)',
    async (recorded) => {
      const f = await pendingTooltip();
      f.pub.record = async () => {
        throw new RefRace('Runner interrupted');
      };
      await expect(f.pub.operation(A)).rejects.toThrow('Runner interrupted');
      expect(f.git.head(paths(A).candidate)).toBeDefined();
      f.change({ 'tooltips/141.json': tooltip(141, 'Saved before recovery') });
      const pending = new Map(f.git.refs);
      await new Publisher(f.git, f.options).operation(A);
      const completed = new Map(f.git.refs);
      expect(f.read(paths(A).log).candidateCommit).toBe(completed.get(L));
      f.git.refs = pending;

      const runner = new Publisher(f.git, f.options);
      const lookup = runner.candidate.bind(runner);
      vi.spyOn(runner, 'candidate').mockImplementationOnce((...args) => {
        const observed = lookup(...args);
        expect(observed).toBeDefined();
        if (recorded) f.git.refs = completed;
        else f.git.refs.delete(paths(A).candidate);
        return observed;
      });
      if (recorded) {
        await expect(runner.operation(A)).resolves.toBeUndefined();
        expect(f.git.head(D)).toBe(completed.get(D));
        expect(f.git.head(L)).toBe(completed.get(L));
        expect(f.git.additions(f.git.head(D)!, paths(A).log)).toHaveLength(1);
      } else {
        await expect(runner.operation(A)).rejects.toThrow('Candidate disappeared');
        expect(f.current()[paths(A).request]).toBeDefined();
        expect(f.current()[paths(A).log]).toBeUndefined();
      }
    },
  );

  it('rebuilds around a saved global and its projection without publishing its draft', async () => {
    const f = await pendingTooltip();
    const port = await mutationPort(f);
    const record = f.pub.record.bind(f.pub);
    vi.spyOn(f.pub, 'record').mockImplementationOnce(async (...args) => {
      expect(args[6]).toBeDefined();
      expect((await port.edit(f.entry.id, '999')).status).toBe(200);
      return record(...args);
    });
    await f.pub.operation(A);
    const output = f.pub.read<LegacyInput>(f.git.tree(f.git.head(L)!), 'liveDescriptions.json')!;
    expect(output.perks[141]).toMatchObject({ editor: { en: { main: '20' } } });
    expect(output.perks[142]).toMatchObject({ editor: { en: { main: 'Edited tooltip' } } });
    expect(f.read(f.entryPath).definitions.en.body).toBe('999');
    expect(f.read('tooltips/2.json').text.en.text).toContain('var Beta = 999');
    expect(f.read(paths(A).log).result.status).toBe('done');
  });

  it('preserves a pending request when the published store becomes inconsistent during landing', async () => {
    const f = await inPlaceFixture();
    f.change({ 'tooltips/142.json': tooltip(142, 'reads #Beta') });
    await f.globals.maintainAuthored();
    await f.request([142]);
    const publishedPath = 'globals/live/converter-v2-test.json';
    f.git.beforeAtomic = () => {
      const published = f.read(publishedPath) as { store: typeof f.published };
      published.store.entries = published.store.entries.filter(({ name }) => name !== 'Beta');
      f.change({ [publishedPath]: published });
    };
    const live = f.git.head(L);
    await expect(f.pub.operation(A)).rejects.toThrow('Invalid or duplicate projection entry');
    expect(f.git.head(L)).toBe(live);
    expect(f.current()[paths(A).request]).toBeDefined();
    expect(f.current()[paths(A).log]).toBeUndefined();
  });
});

describe('authored globals maintenance', () => {
  it('pins identities to exact OIDs and changes them on layout, alias, fallback, or resolver drift', async () => {
    const input = {
      authored: 'a'.repeat(40),
      definitions: 'b'.repeat(40),
      projections: 'c'.repeat(40),
      layout: 'd'.repeat(40),
      published: '5'.repeat(40),
      config: 'e'.repeat(40),
      live: 'f'.repeat(40),
      upcoming: '1'.repeat(40),
      aliasGroups: null,
      sandboxPointers: null,
      generator: '2'.repeat(40),
      resolverRevision: '3'.repeat(40),
    };
    const a = await observeGlobalSources(input);
    expect((await observeGlobalSources({ ...input, layout: '4'.repeat(40) })).projections).not.toBe(
      a.projections,
    );
    expect(
      (await observeGlobalSources({ ...input, resolverRevision: '4'.repeat(40) })).fallback,
    ).not.toBe(a.fallback);
    expect(globalTreeOid({}, 'tooltips')).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    expect(globalTreeOid({ 'tooltips/a.json': 'a'.repeat(40) }, 'tooltips')).not.toBe(
      globalTreeOid({ 'tooltips/a.json': 'b'.repeat(40) }, 'tooltips'),
    );
  });
  it('keeps all consecutive causes, atomically drains them, and retains their Git audit', async () => {
    const f = await inPlaceFixture();
    const entry = structuredClone(f.saved.entries[0]);
    const causeIds: string[] = [];
    for (let n = 0; n < 2; n++) {
      const head = f.git.head(D)!,
        tree = f.current(),
        before = structuredClone(entry);
      const sources = await f.globals.sources(tree, f.git.head(L)!);
      entry.revision = `edit${n}`;
      entry.definitions.en!.revision = entry.revision;
      entry.definitions.en!.body += '0';
      const causeId = `cause${n}`;
      causeIds.push(causeId);
      const blob = f.git.writeBlob(encode(entry));
      f.change({
        [`globals/entries/${entry.id}.json`]: entry,
        [`globals/causes/${causeId}.json`]: {
          version: 1,
          id: causeId,
          operation: 'edit',
          globalId: entry.id,
          lang: 'en',
          beforeSources: sources,
          expectedHead: head,
          at: new Date(now).toISOString(),
          by: 'alice',
          before: {
            path: `globals/entries/${entry.id}.json`,
            blob: tree[`globals/entries/${entry.id}.json`],
            revision: before.revision,
          },
          after: { path: `globals/entries/${entry.id}.json`, blob, revision: entry.revision },
          intentId: null,
        },
        'globals/sync.json': {
          version: 1,
          status: 'sync-pending',
          causeIds: [...causeIds],
          causeEntries: Object.fromEntries(causeIds.map((id) => [id, entry.id])),
          lastFailure: null,
        },
      });
    }
    await f.globals.maintainAuthored();
    expect(f.read('globals/sync.json').causeIds).toEqual([]);
    expect(f.current()['globals/causes/cause0.json']).toBeUndefined();
    expect(f.git.additions(f.git.head(D)!, 'globals/causes/cause0.json')).toHaveLength(1);
    expect(f.read('globals/entries/' + entry.id + '.json').revision).toBe('edit1');
  });
  it('applies one rename intent per revision and releases every superseded name claim', async () => {
    const f = await inPlaceFixture(),
      entry = f.saved.entries[0],
      head = f.git.head(D)!;
    const sources = await f.globals.sources(f.current(), f.git.head(L)!);
    for (const [id, name] of [
      ['intent1', 'First'],
      ['intent2', 'Second'],
    ]) {
      f.change({
        [`globals/intents/${id}.json`]: {
          version: 1,
          id,
          operation: 'rename',
          globalId: entry.id,
          revision: entry.revision,
          expectedHead: head,
          sources,
          name,
          by: 'alice',
          at: new Date(now).toISOString(),
        },
        [(await namePaths(entry.kind, name)).claim]: {
          id: entry.id,
          kind: entry.kind,
          name,
          intentId: id,
        },
      });
    }
    await f.globals.maintainAuthored();
    expect(f.read(`globals/entries/${entry.id}.json`)).toMatchObject({
      name: 'First',
      revision: 'intent1',
      nameHistory: [{ name: 'Alpha', revision: 'Alpha2', by: 'alice' }],
    });
    expect(f.read('tooltips/140.json').text.en.text).toBe('#First');
    expect(Object.keys(f.current()).filter((path) => path.startsWith('globals/intents/'))).toEqual(
      [],
    );
    expect(f.current()[(await namePaths(entry.kind, 'Second')).claim]).toBeUndefined();
    expect(f.read((await namePaths(entry.kind, 'First')).claim)).not.toHaveProperty('intentId');
  });
  it('refuses missing live snapshots and drift in actual destination inputs', async () => {
    const f = await fixture();
    f.change({ 'live/tooltips/40.json': undefined });
    expect(() => f.globals.capture(f.current(), f.git.head(D)!, f.git.head(L)!)).toThrow(
      'last-published consumer snapshot',
    );
    expect(f.current()['globals/reviews/40.json']).toBeUndefined();
  });
  it('uses effective canonical snapshots while preserving stored alias archives and removed live snapshots', async () => {
    const f = await fixture();
    f.options.aliases[140] = { to: 40, kind: 'sandbox' };
    f.options.facts[140] = { name: 'Archived alias', type: 'Weapon Perk' };
    f.options.facts[141] = { name: 'Removed live row', type: 'Weapon Perk' };
    f.change({
      'tooltips/140.json': tooltip(140, '#Beta'),
      'live/tooltips/140.json': tooltip(140, '#Beta'),
      'tooltips/141.json': tooltip(141, '#Alpha'),
      'live/tooltips/141.json': tooltip(141, '#Alpha'),
    });
    const captured = f.globals.capture(f.current(), f.git.head(D)!, f.git.head(L)!);
    expect(captured.authored.tooltips[140]).toBeUndefined();
    expect(captured.live.tooltips[140]).toBeUndefined();
    expect(captured.live.tooltips[141]).toBeUndefined();
    expect(f.read('tooltips/140.json').text.en.text).toBe('#Beta');
  });
  it('uses real Git transactions locally and remotely, including lost acknowledgements', () => {
    mkdirSync('.agents', { recursive: true });
    const root = mkdtempSync(resolve('.agents/globals-s4-atomic-'));
    const upstream = resolve(root, 'upstream.git'),
      cache = resolve(root, 'cache.git');
    execFileSync('git', ['init', '--bare', upstream], { stdio: 'pipe' });
    execFileSync('git', ['--git-dir', upstream, 'config', 'publisher.simulator', 'true']);
    const local = new LocalRepository(upstream);
    const initial = local.commit(
      undefined,
      { 'globals/entries/g_fixture000.json': local.writeBlob('{}\n') },
      'Initial',
    );
    local.cas(D, undefined, initial);
    local.cas(L, undefined, initial);
    expect(globalTreeOid(local.tree(initial), 'globals')).toBe(
      local.git(['rev-parse', `${initial}:globals`]).trim(),
    );
    const next = local.commit(
      initial,
      { ...local.tree(initial), updated: local.writeBlob('next') },
      'Next',
    );
    expect(() =>
      local.casMany([
        { ref: D, old: initial, next },
        { ref: L, old: 'f'.repeat(40), next },
      ]),
    ).toThrow(RefRace);
    expect(local.head(D)).toBe(initial);
    expect(local.head(L)).toBe(initial);
    execFileSync('git', ['clone', '--mirror', upstream, cache], { stdio: 'pipe' });
    execFileSync('git', ['--git-dir', cache, 'remote', 'remove', 'origin']);
    execFileSync('git', ['--git-dir', cache, 'config', 'publisher.simulator', 'true']);
    const remote = new RemoteRepository(cache, { fileUrl: pathToFileURL(upstream).href });
    const remoteNext = remote.commit(
      initial,
      { ...remote.tree(initial), updated: remote.writeBlob('remote') },
      'Remote next',
    );
    const original = remote.remoteGit.bind(remote);
    remote.remoteGit = (args) => {
      const result = original(args);
      if (args[0] === 'push') throw new TransportUnresolved('Lost acknowledgement');
      return result;
    };
    remote.casMany([
      { ref: D, old: initial, next: remoteNext },
      { ref: L, old: initial, next: remoteNext },
    ]);
    expect(local.head(D)).toBe(remoteNext);
    expect(local.head(L)).toBe(remoteNext);
  });
});

it('withholds a title-local name proof and keeps real S2 from creating a conflicting entry', async () => {
  const f = await inPlaceFixture('title Info (\nvar Local = 1\n#Local\nText\n)');
  const port = await mutationPort(f);
  f.change({
    'globals/catalog.json': { version: 1, lastPage: 0 },
    'globals/pages/p0.json': { version: 1, ids: [], nextCursor: null },
  });
  const sources = await f.globals.sources(f.current(), f.git.head(L)!);
  f.change({
    'globals/retries/local.json': {
      version: 1,
      type: 'name-proof',
      id: 'local',
      operation: 'create',
      kind: 'variables',
      name: 'Local',
      globalId: null,
      revision: null,
      expectedHead: f.git.head(D),
      sources,
      by: 'alice',
      at: new Date(now).toISOString(),
    },
  });
  await f.globals.maintainAuthored();
  const response = await globalsHandler(
    new Request('https://api.invalid/globals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedHead: f.git.head(D),
        mutation: {
          operation: 'create',
          kind: 'variables',
          name: 'Local',
          lang: 'en',
          body: '999',
        },
      }),
    }),
    port.load,
  );
  expect(f.current()[(await namePaths('variables', 'Local')).proof]).toBeUndefined();
  expect(response.status).toBe(202);
  expect(f.globals.store(f.current()).entries.some((entry) => entry.name === 'Local')).toBe(false);
});

it.each([2, 3, 40])(
  'ignores historical derived secondary without changing live bytes for %s',
  async (hash) => {
    const f = await fixture('title Help (\nDetails\n)');
    const currentLive = f.git.head(L)!;
    const tree = f.git.tree(currentLive);
    const actual = JSON.parse(f.git.blob(tree['liveDescriptions.json']));
    const write = () => {
      tree['liveDescriptions.json'] = f.git.writeBlob(encode(actual));
      return f.git.commit(currentLive, tree);
    };
    expect(() => f.globals.capture(f.current(), f.git.head(D)!, currentLive)).not.toThrow();
    actual.perks[hash].editor.en.secondary = '';
    expect(() => f.globals.capture(f.current(), f.git.head(D)!, write())).not.toThrow();
    actual.perks[hash].editor.en.secondary = 'different';
    const historical = write();
    const bytes = f.git.blob(f.git.tree(historical)['liveDescriptions.json']);
    expect(() => f.globals.capture(f.current(), f.git.head(D)!, historical)).not.toThrow();
    expect(f.git.blob(f.git.tree(historical)['liveDescriptions.json'])).toBe(bytes);
    const main = actual.perks[hash].editor.en.main;
    actual.perks[hash].editor.en.main = 'different main';
    expect(() => f.globals.capture(f.current(), f.git.head(D)!, write())).toThrow(
      'Published snapshots differ',
    );
    actual.perks[hash].editor.en.main = main;
    actual.perks[hash].editor.en.unexpected = 'still strict';
    expect(() => f.globals.capture(f.current(), f.git.head(D)!, write())).toThrow(
      'Published snapshots differ',
    );
  },
);

describe('upcoming batches', () => {
  const B = '01K95H00000000000000000B01',
    notBefore = '2026-01-02T00:00:00.000Z',
    at = '2026-01-01T00:00:00Z',
    alice = { id: 1, login: 'alice' };
  const batch = (status: BatchStatus): Batch => {
    const operation = ['scheduled', 'publishing', 'published'].includes(status),
      claimed = ['publishing', 'published'].includes(status);
    return batchSchema.parse({
      id: B,
      name: 'Batch',
      createdBy: alice,
      createdAt: at,
      revision: 1,
      contentRevision: 1,
      status,
      notBefore: operation ? notBefore : null,
      zone: operation ? 'UTC' : null,
      opId: operation ? A : null,
      scheduledContentRevision: operation ? 1 : null,
      claim: claimed ? { opId: A, claimedAt: at } : null,
      result:
        status === 'published'
          ? {
              opId: A,
              status: 'published',
              landedAt: at,
              landedAtSource: 'cas',
              recordedAt: at,
              exportNow: at,
              liveCommit: 'f'.repeat(40),
            }
          : null,
      events: [],
      ...(['preparing', 'needs_attention'].includes(status)
        ? {
            preparation: {
              requestId: A,
              kind: 'save',
              returnStatus: 'draft',
              requestedAt: at,
              attempt: 1,
            },
          }
        : {}),
    });
  };
  const member = (proposed: Tooltip, base: Tooltip | null = null) => ({
    hash: proposed.hash,
    base,
    baseCommit: 'f'.repeat(40),
    proposed,
    updatedAt: at,
    updatedBy: 'alice',
  });
  const batchPath = `schedule/batches/${B}/batch.json`,
    memberPath = (hash: number) => `schedule/batches/${B}/tooltips/${hash}.json`,
    conflictPath = (hash: number) => `schedule/activation-conflicts/${hash}.json`;

  it.each(batchStatusSchema.options)('counts a %s batch unless it is final', async (status) => {
    const f = await fixture();
    const proposed = tooltip(42, 'proposed');
    f.change({ [batchPath]: batch(status), [memberPath(42)]: member(proposed) });
    expect(f.globals.upcoming(f.current())).toEqual(
      ['cancelled', 'published'].includes(status) ? [] : [{ 42: proposed }],
    );
  });

  it('groups each side, and counts unproven final batches and open activation conflicts', async () => {
    const f = await fixture();
    const base = tooltip(41, 'base'),
      one = tooltip(41, 'one'),
      two = tooltip(42, 'two');
    f.change({
      [batchPath]: batch('draft'),
      [memberPath(41)]: member(one, base),
      [memberPath(42)]: member(two),
    });
    expect(f.globals.upcoming(f.current())).toEqual([{ 41: base }, { 41: one, 42: two }]);
    for (const status of ['published', 'cancelled'] as const) {
      f.change({ [batchPath]: batch(status), [conflictPath(41)]: {} });
      expect(f.globals.upcoming(f.current())).toEqual([{ 41: base }, { 41: one }]);
      f.change({ [conflictPath(41)]: undefined });
      expect(f.globals.upcoming(f.current())).toEqual([]);
      // Anything but this batch's own valid final record keeps counting.
      for (const unproven of [
        undefined,
        { status },
        { ...batch(status), id: A },
        { ...batch(status), claim: { opId: B, claimedAt: at } },
      ]) {
        f.change({ [batchPath]: unproven });
        expect(f.globals.upcoming(f.current())).toEqual([{ 41: base }, { 41: one, 42: two }]);
      }
    }
    f.change({ [batchPath]: batch('published'), [memberPath(42)]: { hash: 42 } });
    expect(() => f.globals.upcoming(f.current())).toThrow();
  });

  it('keeps removal and name proofs away until a batch is final, and stales them if it changes', async () => {
    const f = await inPlaceFixture();
    const plain = tooltip(141, 'unrelated'),
      proposed = tooltip(141, '#Beta\nvar Local = 1\n#Local');
    const docs = Object.keys(f.current())
      .filter((path) => path.startsWith('live/tooltips/'))
      .map((path) => f.read(path) as Tooltip);
    f.git.refs.set(
      L,
      f.git.commit(f.git.head(L), {
        'liveDescriptions.json': f.git.writeBlob(
          encode(
            migrateInPlace({
              perks: exportLegacy(
                docs.map((document) => (document.hash === 141 ? plain : document)),
                0,
                f.options.facts,
              ) as LegacyInput['perks'],
              databaseSettings: {},
            }),
          ),
        ),
      }),
    );
    f.change({ 'tooltips/141.json': plain, 'live/tooltips/141.json': plain });
    const beta = f.saved.entries.find((entry) => entry.name === 'Beta')!;
    const removal = `globals/proofs/removal/${beta.id}-all.json`,
      name = (await namePaths('variables', 'Local')).proof;
    const drain = async () => {
      f.change({
        'globals/retries/local.json': {
          version: 1,
          type: 'name-proof',
          id: 'local',
          operation: 'create',
          kind: 'variables',
          name: 'Local',
          globalId: null,
          revision: null,
          expectedHead: f.git.head(D),
          sources: await f.globals.sources(f.current(), f.git.head(L)!),
          by: 'alice',
          at: new Date(now).toISOString(),
        },
      });
      await f.globals.maintainAuthored();
      return [removal, name].map((path) => f.current()[path] !== undefined);
    };
    f.change({ [memberPath(141)]: member(proposed, plain) });
    for (const status of ['draft', 'scheduled', 'publishing', 'needs_attention'] as const) {
      f.change({ [batchPath]: batch(status) });
      expect(await drain()).toEqual([false, false]);
    }
    // Published with an activation conflict: the resolve route can still write the proposal.
    f.change({ [batchPath]: batch('published'), [conflictPath(141)]: { hash: 141 } });
    expect(await drain()).toEqual([false, false]);
    f.change({ [conflictPath(141)]: undefined });
    expect(await drain()).toEqual([true, true]);
    // A proof names the exact schedule tree, so no later batch write can use it.
    const stored = f.read(removal).sources;
    expect((await f.globals.sources(f.current(), f.git.head(L)!)).upcoming).toBe(stored.upcoming);
    f.change({ [batchPath]: batch('draft') });
    expect((await f.globals.sources(f.current(), f.git.head(L)!)).upcoming).not.toBe(
      stored.upcoming,
    );
    expect(await drain()).toEqual([false, false]);
  });
});
