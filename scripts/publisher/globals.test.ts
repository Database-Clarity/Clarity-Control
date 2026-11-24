import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { inventoryGlobals, projectGlobals } from '../../packages/core/src/globals/projection.js';
import {
  composeGlobalRelease,
  reconcileGlobalStore,
  globalsConfigWithoutMarks,
  observeGlobalSources,
} from '../../packages/core/src/globalsRelease/index.js';
import { exportLegacy, usesEnglishFallback } from '../../packages/core/src/exportLegacy.js';
import { buildLegacy, type LegacyInput } from '../../packages/export/src/legacy.js';
import { descriptionConverter, expandAliases } from '../../packages/export/src/converter/index.js';
import { languages } from '../../packages/core/src/languages.js';
import { publicationSourcesPath } from '../../packages/core/src/globalsRelease/admission.js';
import { calculateGlobalImpact } from '../../packages/core/src/globals/impact.js';
import { inactivePublishableHash, type InactiveMoves } from '../../packages/core/src/inactiveMoves.js';
import type { Tooltip } from '../../packages/core/src/schemas.js';
import {
  batchSchema,
  batchStatusSchema,
  type Batch,
  type BatchStatus,
} from '../../packages/core/src/schedule/schemas.js';
import { globalFileBytes, rowSchema, syncSchema } from '../../apps/worker/src/globals/model.js';
import { GlobalsPublisher, globalTreeOid } from './globals.js';
import { Publisher, paths, type Options } from './publisher.js';
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
    return this.history(head)
      .filter(
        (commit) => this.tree(commit)[path] && !this.tree(this.parents.get(commit) ?? commit)[path],
      )
      .map((commit) => ({ commit, path }));
  }
}

async function fixture(titleSource = '', exports = false, translatedVariables = false) {
  const git = new Memory();
  const docs = [
    tooltip(1, exports ? 'export Barrier (\nOld\n)' : ''),
    tooltip(2, '// ordered\nvar Alpha = 10\n\nvar Beta = 20\n'),
    tooltip(3, titleSource),
    tooltip(40, exports ? 'import Barrier from global' : '#Alpha'),
    tooltip(41, '#Beta'),
    tooltip(42, 'unrelated'),
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
    backoff: async () => {},
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
  const approve = (hash: number, by = 'alice') => {
    for (const path of Object.keys(current()).filter((path) =>
      path.startsWith('globals/reviews/'),
    )) {
      const row = rowSchema.parse(read(path));
      if (row.review.consumer.hash !== hash) continue;
      row.review.acknowledgement = {
        by,
        at: new Date(now).toISOString(),
        decision: 'no-text-change',
        contentDigest: row.review.contentDigest,
        dependencyDigest: row.review.dependencyDigest,
        impactDigest: row.impactDigest,
      };
      change({ [path]: row });
    }
  };
  const request = async (hashes: number[], opId = A) => {
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
      },
      () => now,
      (payload) => sign(null, Buffer.from(payload), keys.privateKey).toString('base64'),
    );
  };
  const tooltipSchemaRead = (hash: number) =>
    (current()[`tooltips/${hash}.json`]
      ? read(`tooltips/${hash}.json`)
      : { hash, text: {}, associated: [] }) as Tooltip;
  return { git, pub, globals, saved, published, options, current, read, change, approve, request };
}

async function mutationPort(f: Awaited<ReturnType<typeof fixture>>) {
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
    access: { role: 'maintainer', login: 'alice' },
    user: { id: 1, login: 'alice' },
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
  const acknowledge = async (row: ReturnType<typeof rowSchema.parse>, id: string) => {
    const response = await post(`/${id}/acknowledge`, {
      operation: 'acknowledge',
      id,
      consumerId: row.id,
      contentDigest: row.review.contentDigest,
      dependencyDigest: row.review.dependencyDigest,
      impactDigest: row.impactDigest,
      decision: 'no-text-change',
    });
    expect(response.status, await response.text()).toBe(200);
  };
  return { load, edit, post, acknowledge };
}

const withdrawalScenarios = [
  'language',
  'entry',
  'resave',
  'last language',
  'two withdrawals',
  'unpublished',
  'redundant',
] as const;

// B4 and C of the withdrawal reproducers. Beta and Delta are fresh on LIVE.
// A newly saved Alpha.de uses Alpha's older English stamp for the whole library.
async function withdrawalFixture(scenario: (typeof withdrawalScenarios)[number]) {
  const f = await fixture();
  const published = structuredClone(f.published);
  const alpha = published.entries.find(({ name }) => name === 'Alpha')!;
  const beta = published.entries.find(({ name }) => name === 'Beta')!;
  const variables = published.aggregates.find(({ document }) => document.hash === 2)!;
  const sourceUpdatedAt = '2026-09-01T00:00:00Z';
  const de = { updatedAt: '2026-09-02T00:00:00Z', updatedBy: 'alice', sourceUpdatedAt };
  const delta = {
    ...structuredClone(alpha),
    id: 'g_fixture9000',
    name: 'Delta',
    definitions: {
      en: {
        body: scenario === 'unpublished' || scenario === 'redundant' ? '#Alpha' : '10',
        revision: alpha.revision,
        updatedAt: sourceUpdatedAt,
        updatedBy: 'alice',
      },
      ...(scenario !== 'unpublished' && { de: { body: '7', revision: 'dde', ...de } }),
    },
  };
  const segment = (entryId: string) => ({
    entryId,
    beforeName: 'var ',
    afterName: ' = ',
    afterBody: '',
  });
  published.entries.push(delta);
  const epsilon = { ...structuredClone(alpha), id: 'g_fixture8500', name: 'Epsilon' };
  beta.definitions.en!.updatedAt = sourceUpdatedAt;
  beta.definitions.de = { body: '80', revision: 'bde', ...de };
  variables.languages.en!.metadata.updatedAt = sourceUpdatedAt;
  variables.languages.en!.segments.push({ literal: '\n' }, segment(delta.id));
  if (scenario === 'redundant') {
    published.entries.push(epsilon);
    variables.languages.en!.segments.push({ literal: '\n' }, segment(epsilon.id));
  }
  variables.languages.de = {
    metadata: de,
    segments: [{ literal: '' }, segment(beta.id)],
  };
  if (delta.definitions.de)
    variables.languages.de.segments.push({ literal: '\n' }, segment(delta.id));
  const liveVariables = projectGlobals(published)[2];
  const unrelated = tooltip(40, 'unrelated');
  const reader = tooltip(41, '#Beta');
  reader.text.de = cell('#Beta');
  const live = JSON.parse(f.git.blob(f.git.tree(f.git.head(L)!)['liveDescriptions.json']));
  Object.assign(live.perks, exportLegacy([liveVariables, unrelated, reader], 0, f.options.facts));
  f.git.refs.set(
    L,
    f.git.commit(f.git.head(L), {
      'liveDescriptions.json': f.git.writeBlob(encode(live)),
    }),
  );
  f.change({
    ...Object.fromEntries(
      published.entries.map((entry) => [`globals/entries/${entry.id}.json`, entry]),
    ),
    'globals/layout.json': { version: 1, aggregates: published.aggregates },
    'globals/live/converter-v2-test.json': {
      version: 1,
      destination: f.options.liveBranch,
      store: published,
    },
    'globals/catalog.json': { version: 1, lastPage: 0 },
    'globals/pages/p0.json': {
      version: 1,
      ids: published.entries.map(({ id }) => id),
      nextCursor: null,
    },
    'live/tooltips/2.json': liveVariables,
    'live/pushed.json': { 2: await inactivePublishableHash(liveVariables, {}) },
    'live/tooltips/40.json': unrelated,
    'tooltips/40.json': unrelated,
    'live/tooltips/41.json': reader,
    'tooltips/41.json': reader,
  });
  f.saved.entries = published.entries;
  const port = await mutationPort(f);
  await f.globals.drain();
  return { f, port, alpha, delta, epsilon };
}

describe('withdrawal alongside a pending fallback change', () => {
  it.each(withdrawalScenarios)('attributes the Beta review and publishes unrelated edits (%s)', async (scenario) => {
    const { f, port, alpha, delta, epsilon } = await withdrawalFixture(scenario);
    const saved = async (response: Response) => {
      expect(response.status, await response.text()).toBe(200);
    };
    const remove = (id: string, lang?: string) =>
      port.post(`/${id}/remove`, {
        operation: 'remove',
        id,
        revision: f.read(`globals/entries/${id}.json`).revision,
        ...(lang && { lang }),
      });
    await saved(await port.edit(alpha.id, '112', 'de'));
    await f.globals.drain();
    if (scenario === 'resave' || scenario === 'unpublished') {
      await saved(await port.edit(delta.id, '8', 'de'));
      await f.globals.drain();
    }
    if (scenario === 'redundant') {
      await saved(await port.edit(epsilon.id, '113', 'de'));
      await f.globals.drain();
    }
    let gamma: string | undefined;
    if (scenario === 'last language' || scenario === 'two withdrawals') {
      const create = () =>
        port.post('', {
          operation: 'create',
          kind: 'variables',
          name: 'Gamma',
          lang: 'de',
          body: '30',
        });
      expect((await create()).status).toBe(202);
      await f.globals.drain();
      const created = await create();
      expect(created.status, await created.clone().text()).toBe(200);
      const {
        value: { entry },
      } = await created.json();
      gamma = entry.id;
      await f.globals.drain();
      await saved(await remove(entry.id, 'de'));
      expect(f.read(`globals/entries/${entry.id}.json`).definitions).toEqual({});
      await f.globals.drain();
    }
    if (scenario !== 'last language') {
      await saved(await remove(delta.id, scenario === 'entry' ? undefined : 'de'));
      await f.globals.drain();
    }

    const publish = async (hash: number, sequence: number) => {
      const op = `01K95H0000000000000000000${sequence}`;
      await f.request([hash], op);
      await f.pub.operation(op);
      return f.read(paths(op).log).result;
    };
    const publishUnrelated = async (sequence: number) => {
      const independent = f.read('tooltips/42.json') as Tooltip;
      independent.text.en!.text = sequence === 2 ? 'unrelated edit' : 'next unrelated edit';
      f.change({ 'tooltips/42.json': independent });
      await f.globals.drain();
      expect(await publish(42, sequence)).toMatchObject({
        status: 'done',
        outcomes: [{ hash: 42, status: 'published' }],
      });
    };
    await publishUnrelated(2);
    if (scenario === 'resave' || scenario === 'last language') {
      await saved(await port.edit(alpha.id, '113', 'de'));
      await f.globals.drain();
      await publishUnrelated(3);
    }
    expect(f.read('globals/sync.json')).toMatchObject({ status: 'current', causeIds: [] });
    expect(await publish(41, 4)).toMatchObject({
      status: 'rejected',
      error: expect.stringContaining('global dependency review required'),
    });
    const reviewPage = async (id: string) => {
      const response = await globalsHandler(
        new Request(`https://api.invalid/globals/${id}/reviews`),
        port.load,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()).value.impacts[id];
    };
    expect(await reviewPage(delta.id)).toEqual([]);
    if (gamma) expect(await reviewPage(gamma)).toEqual([]);
    const rows = await reviewPage(alpha.id);
    expect(rows).toHaveLength(1);
    const row = rowSchema.parse(f.read(`globals/reviews/${rows[0].id}.json`));
    expect(row.review.consumer).toMatchObject({ hash: 41, lang: 'de' });
    const responsible = scenario === 'redundant' ? [alpha.id, epsilon.id] : [alpha.id];
    expect(new Set(row.review.causes.map(({ globalId }) => globalId))).toEqual(
      new Set(responsible),
    );
    if (scenario === 'redundant') expect(await reviewPage(epsilon.id)).toEqual(rows);
    expect(row.view.before?.rendered).toContain('80');
    expect(row.view.after?.rendered).toContain('20');
    await port.acknowledge(row, alpha.id);
    await f.globals.drain();
    expect(f.read(`globals/reviews/${row.id}.json`).review.acknowledgement.by).toBe('alice');
    expect(await publish(2, 1)).toMatchObject({ status: 'done' });
    const german = f.read('live/tooltips/2.json').text.de.text;
    if (scenario === 'last language') expect(german).toContain('var Delta = 7');
    else expect(german).not.toContain('Delta');
    expect(await reviewPage(alpha.id)).toEqual([]);
  });
});

describe('withdrawing a global read by a historical tooltip revision', () => {
  it.each([
    ['Delta edit', 'de'],
    ['Delta edit', undefined],
    ['Alpha fallback edit', 'de'],
    ['Alpha edit', 'de'],
    ['Alpha edit', undefined],
    ['published reader', 'de'],
    ['published reader', undefined],
    ['stale published reader', undefined],
  ] as const)('syncs after the reader moves off Delta (%s, %s)', async (scenario, lang) => {
    const { f, port, alpha, delta } = await withdrawalFixture('language');
    const publishedReader = scenario === 'published reader' || scenario === 'stale published reader';
    const saveReader = (de: string) => f.change({
      'tooltips/44.json': {
        ...tooltip(44, 'x'),
        text: scenario === 'stale published reader' && de === 'plain'
          ? {
              en: { ...cell('x'), updatedAt: '2026-09-01T00:00:00Z' },
              de: { ...cell(de), sourceUpdatedAt: '2026-01-01T00:00:00Z' },
            }
          : { en: cell('x'), de: cell(de) },
      },
    });
    f.options.facts[44] = { name: 'Former Delta reader', type: 'Weapon Perk' };
    f.options.facts[45] = { name: 'Alpha reader', type: 'Weapon Perk' };
    f.change({
      '.publisher/config.json': { ...f.read('.publisher/config.json'), facts: f.options.facts },
    });
    saveReader('#Delta');
    if (scenario === 'Alpha edit' || publishedReader)
      f.change({ 'tooltips/45.json': tooltip(45, '#Alpha') });
    const publish = async (hashes: number[], sequence: number, expected = 'done') => {
      const op = `01K95H0000000000000000000${sequence}`;
      await f.request(hashes, op);
      await f.pub.operation(op);
      const result = f.read(paths(op).log).result;
      expect(result.status, JSON.stringify(result)).toBe(expected);
      return result;
    };
    await f.globals.drain();
    if (publishedReader) {
      await publish([44], 1);
      await publish([45], 2);
      await f.globals.drain();
    }
    const edit = scenario === 'Delta edit'
      ? await port.edit(delta.id, '8', 'de')
      : scenario === 'Alpha fallback edit'
        ? await port.edit(alpha.id, '112', 'de')
        : await port.edit(alpha.id, '12', 'en');
    expect(edit.status, await edit.text()).toBe(200);
    await f.globals.drain();
    saveReader('plain');
    await f.globals.drain();
    if (publishedReader) {
      await publish([44], 3);
      await f.globals.drain();
    }
    const liveReader = () => {
      const live = f.git.tree(f.git.head(L)!);
      const intermediate = JSON.parse(f.git.blob(live['liveDescriptions.json'])) as LegacyInput;
      const database = expandAliases(intermediate.perks);
      const perk = database[44];
      const rendered = languages.flatMap((language) => {
        const description = perk?.editor[language];
        if (!description) return [];
        return (['main', 'secondary'] as const).map((editorType) =>
          descriptionConverter({
            database, hash: 44, language, editorType, descriptionString: description[editorType],
          }),
        );
      });
      return { intermediate: perk, rendered };
    };
    const beforeRemoval = liveReader();
    if (publishedReader) {
      expect(beforeRemoval.rendered).toHaveLength(4);
      expect(beforeRemoval.intermediate.editor.de?.englishFallback).toBe(
        scenario === 'stale published reader' ? true : undefined,
      );
    }
    const removal = await port.post(`/${delta.id}/remove`, {
      operation: 'remove',
      id: delta.id,
      revision: f.read(`globals/entries/${delta.id}.json`).revision,
      ...(lang && { lang }),
    });
    expect(removal.status, await removal.text()).toBe(200);
    await f.globals.drain();
    f.change({ 'tooltips/42.json': tooltip(42, 'independent edit') });
    await f.globals.drain();
    await publish([42], 4);

    const rows = () => Object.keys(f.current())
      .filter((path) => path.startsWith('globals/reviews/'))
      .map((path) => rowSchema.parse(f.read(path)));
    const history = rows().find(({ review }) => review.consumer.hash === 44)!;
    expect(history.review.consumer.lang).toBe('de');
    expect(new Set(history.review.causes.map(({ globalId }) => globalId))).toEqual(new Set([delta.id]));
    expect(history.view.before?.rendered).toContain('7');
    expect(history.view.after?.rendered).toContain('plain');
    if (publishedReader) {
      const independentReview = rows().find(({ review }) => review.consumer.hash === 45)!;
      await port.acknowledge(independentReview, alpha.id);
      await f.globals.drain();
      for (const [hash, sequence] of [[45, 5], [44, 6]])
        expect((await publish([hash], sequence, 'rejected')).error).toContain(
          'global dependency review required',
        );
      expect(JSON.stringify(liveReader())).toBe(JSON.stringify(beforeRemoval));
    }
    await port.acknowledge(history, delta.id);
    await f.globals.drain();
    expect(rows().find(({ id }) => id === history.id)?.review.acknowledgement?.by).toBe('alice');
    if (publishedReader) {
      await publish([44, 45], 7);
      expect(JSON.stringify(liveReader())).toBe(JSON.stringify(beforeRemoval));
      expect(rows().some(({ id }) => id === history.id)).toBe(false);
    }
  });

  it.each(['#Delta', '#{Delta}', 'title Local (\n#Delta\n)\n<title a [Local] />'])(
    'continues to reject a current German read after a withdrawal (%s)',
    async (text) => {
      const { f, port, delta } = await withdrawalFixture('language');
      const removal = await port.post(`/${delta.id}/remove`, {
        operation: 'remove',
        id: delta.id,
        lang: 'de',
        revision: delta.revision,
      });
      expect(removal.status, await removal.text()).toBe(200);
      const reader = tooltip(41, '#Beta');
      reader.text.de = cell(text);
      f.change({ 'tooltips/41.json': reader });
      await expect(f.globals.drain()).rejects.toThrow(/still referenced|closure is incomplete/);
      expect(f.read('globals/sync.json').status).toBe('sync-failed');
    },
  );
});

describe('dependency-safe global release', () => {
  it('releases hash 1 from reviewed exports and refuses a missing export capability', async () => {
    const f = await fixture('', true);
    await f.globals.drain();
    await expect(
      f.globals.release(f.current(), f.git.head(D)!, [40], f.git.head(L)!),
    ).rejects.toThrow('review required');
    f.approve(40);
    await f.globals.drain();
    const release = (await f.globals.release(f.current(), f.git.head(D)!, [1], f.git.head(L)!))!;
    expect(release.documents.find((document) => document.hash === 1)?.text.en?.text).toBe(
      'export Barrier (\nOld0\n)',
    );
    expect(release.documents.find((document) => document.hash === 2)?.text.en?.text).toContain(
      'var Beta = 20',
    );
    expect(release.documents.find((document) => document.hash === 2)?.text.en?.text).not.toContain(
      'var Beta = 200',
    );
    f.change({
      '.publisher/PIN': {
        sourceSha: f.options.publisherSha,
        sha256: f.options.publisherDigest,
        capabilities: ['globalsRelease'],
      },
    });
    await expect(f.globals.sources(f.current(), f.git.head(L)!)).rejects.toThrow(
      'globalsExportsV1',
    );
  });
  it.each([false, true])(
    'repairs only never-published historical bad globals (published=%s)',
    async (published) => {
      const f = await fixture('title Info (\nBefore\n)');
      const port = await mutationPort(f);
      await f.globals.drain();
      const id = f.saved.entries.find((entry) => entry.kind === 'titles')!.id;
      expect((await port.edit(id, 'import main from 999')).status).toBe(200);
      if (published) {
        const store = f.globals.store(f.current());
        const documents = {
          ...f.globals.documents(f.current(), 'live/tooltips'),
          ...projectGlobals(store),
        };
        f.change({
          'globals/live/converter-v2-test.json': {
            version: 1,
            destination: f.options.liveBranch,
            store,
          },
          'live/tooltips/3.json': documents[3],
        });
        f.git.refs.set(
          L,
          f.git.commit(f.git.head(L), {
            'liveDescriptions.json': f.git.writeBlob(
              encode({
                perks: exportLegacy(Object.values(documents), 0, f.options.facts),
                databaseSettings: {},
              }),
            ),
          }),
        );
      }
      await expect(f.globals.drain()).rejects.toThrow('incomplete');
      const pending = f.read('globals/sync.json').causeIds;
      expect((await port.edit(id, 'Repaired')).status).toBe(200);
      if (published) await expect(f.globals.drain()).rejects.toThrow('incomplete');
      else {
        await f.globals.drain();
        expect(f.read('globals/sync.json').status).toBe('current');
        expect(f.read('globals/sync.json').causeIds).toEqual([]);
      }
      for (const cause of pending)
        expect(f.current()[`globals/causes/${cause}.json`]).toBeDefined();
    },
  );
  it.each(['publisher', 'generator'])(
    'reconstructs pending cause provenance across a %s upgrade',
    async (epoch) => {
      const f = await fixture('title Info (\nBefore\n)');
      const port = await mutationPort(f);
      await f.globals.drain();
      f.approve(40);
      const id = f.saved.entries.find((entry) => entry.kind === 'titles')!.id;
      expect((await port.edit(id, 'After')).status).toBe(200);
      const expectedHead = f.git.head(D)!,
        sources = await f.globals.sources(f.current(), f.git.head(L)!);
      const claim = (await namePaths('titles', 'Renamed')).claim;
      f.change({
        'globals/intents/stale.json': {
          version: 1,
          id: 'stale1',
          operation: 'rename',
          globalId: id,
          revision: f.read(`globals/entries/${id}.json`).revision,
          expectedHead,
          sources,
          name: 'Renamed',
          by: 'alice',
          at: new Date(now).toISOString(),
        },
        [claim]: { id, kind: 'titles', name: 'Renamed', intentId: 'stale1' },
      });
      if (epoch === 'publisher') {
        f.options.publisherSha = 'd'.repeat(40);
        f.options.publisherDigest = 'e'.repeat(64);
        f.change({
          '.publisher/PIN': {
            sourceSha: f.options.publisherSha,
            sha256: f.options.publisherDigest,
            capabilities: ['globalsRelease'],
          },
        });
      } else {
        f.options.generatorSha = 'f'.repeat(40);
        f.change({
          '.publisher/config.json': {
            generatorSha: f.options.generatorSha,
            facts: f.options.facts,
            aliases: {},
          },
        });
      }
      await f.globals.drain();
      expect(f.read('globals/sync.json').status).toBe('current');
      expect(f.current()['globals/intents/stale.json']).toBeUndefined();
      expect(f.current()[claim]).toBeUndefined();
      expect(f.read(`globals/entries/${id}.json`).name).toBe('Info');
      expect(
        Object.keys(f.current())
          .filter((path) => path.startsWith('globals/reviews/'))
          .map((path) => f.read(path))
          .filter((row) => row.review.consumer.hash === 40)
          .every((row) => !row.review.acknowledgement),
      ).toBe(true);
    },
  );
  it('requires explicit consumers to be ready even alongside an approved aggregate', async () => {
    const f = await fixture();
    const gamma = structuredClone(f.saved.entries[1]);
    gamma.id = 'g_newgamma000';
    gamma.name = 'Gamma';
    gamma.revision = 'gamma1';
    gamma.nameHistory = [];
    f.change({
      [`globals/entries/${gamma.id}.json`]: gamma,
      'tooltips/41.json': tooltip(41, 'Now #Gamma'),
    });
    await f.globals.drain();
    f.approve(40);
    await f.globals.drain();
    for (const roots of [[41], [2, 41]])
      await expect(
        f.globals.release(f.current(), f.git.head(D)!, roots, f.git.head(L)!),
      ).rejects.toThrow('review required');
    const live = f.git.head(L);
    await f.request([2, 41]);
    await f.pub.operation(A);
    expect(f.git.head(L)).toBe(live);
    expect(f.read(paths(A).log).result.status).toBe('rejected');
  });
  it('retains aggregate bytes, comments, ordering, missing languages, and unrelated definitions', async () => {
    const f = await fixture();
    expect(projectGlobals(composeGlobalRelease(f.published, f.saved, []))).toEqual(
      projectGlobals(f.published),
    );
    const partial = projectGlobals(
      composeGlobalRelease(f.published, f.saved, [f.saved.entries[0].id]),
    );
    expect(partial[2].text.en!.text).toBe('// ordered\nvar Alpha = 100\n\nvar Beta = 20\n');
    expect(partial[2].text.de).toBeUndefined();
  });
  it.each([1, 2, 3])(
    'publishes saved layout for aggregate %i with no entry edits',
    async (hash) => {
      const f = await fixture('title Info (\nBefore\n)', true);
      const layout = structuredClone(f.published.aggregates);
      const segments = layout.find((aggregate) => aggregate.document.hash === hash)!.languages.en!
        .segments;
      segments[0] = { literal: '// edited layout\n' };
      f.change({
        ...Object.fromEntries(
          f.published.entries.map((entry) => [`globals/entries/${entry.id}.json`, entry]),
        ),
        'globals/layout.json': { version: 1, aggregates: layout },
      });
      await f.globals.drain();
      const saved = f.read(`tooltips/${hash}.json`);
      const digest = await inactivePublishableHash(saved, {});
      await f.request([hash]);
      await f.pub.operation(A);
      expect(f.read(paths(A).log).result).toMatchObject({
        status: 'done',
        outcomes: [{ hash, digest, status: 'published' }],
      });
      expect(f.read('live/pushed.json')[hash]).toBe(digest);
      expect(f.read(`live/tooltips/${hash}.json`)).toEqual(saved);
      expect(f.pub.receipt(f.git.head(L)!, A)?.entries[0].digest).toBe(digest);
    },
  );
  it.each([
    'layout only',
    'unchanged row',
    'text edit',
    'inactive removal',
    'removal without a snapshot',
    'alias addition',
    'inactive alias',
    'aggregate alias',
    'all aggregates with a cleared entry',
    'all aggregates with only layouts',
  ] as const)('uses v2 for an unproven layout when the request has work (%s)', async (scenario) => {
    const allAggregates = scenario.startsWith('all aggregates');
    const f = await fixture('title Info (\nBefore\n)', allAggregates, true);
    const layout = structuredClone(f.published.aggregates);
    layout.find(({ document }) => document.hash === 2)!.languages.en!.metadata.updatedAt =
      '2026-09-01T00:00:00Z';
    const clearedEntry =
      scenario === 'all aggregates with a cleared entry'
        ? f.saved.entries.find(({ kind }) => kind === 'exports')
        : undefined;
    if (allAggregates)
      for (const aggregate of layout)
        if (aggregate.document.hash !== 2)
          aggregate.languages.en!.segments[0] = { literal: '// pending layout\n' };

    const previous = projectGlobals(f.published);
    const ordinary = f.read('tooltips/42.json') as Tooltip;
    const beforeAliases: Options['aliases'] =
      scenario === 'inactive alias' ? { 142: { to: 42, kind: 'sandbox' } } : {};
    const aliases: Options['aliases'] =
      scenario === 'aggregate alias'
        ? { 142: { to: 2, kind: 'sandbox' } }
        : scenario === 'alias addition'
          ? { 142: { to: 42, kind: 'sandbox' } }
          : beforeAliases;
    const moved = { by: 1, at: new Date(now).toISOString() };
    const moves: InactiveMoves =
      scenario === 'inactive removal'
        ? { 42: moved }
        : scenario === 'removal without a snapshot'
          ? { 43: moved }
          : scenario === 'inactive alias'
            ? { 142: moved }
            : {};
    if (Object.keys(aliases).length) f.options.facts[142] = { name: 'Alias', type: 'Weapon Perk' };
    f.options.aliases = aliases;
    if (scenario === 'inactive alias') {
      const live = JSON.parse(f.git.blob(f.git.tree(f.git.head(L)!)['liveDescriptions.json']));
      Object.assign(live.perks, exportLegacy([ordinary], 0, f.options.facts, beforeAliases));
      f.git.refs.set(
        L,
        f.git.commit(f.git.head(L), { 'liveDescriptions.json': f.git.writeBlob(encode(live)) }),
      );
    }
    f.change({
      ...Object.fromEntries(
        f.published.entries.map((entry) => [
          `globals/entries/${entry.id}.json`,
          entry.id === clearedEntry?.id ? clearedEntry : entry,
        ]),
      ),
      'globals/layout.json': { version: 1, aggregates: layout },
      'live/pushed.json': {
        2: await inactivePublishableHash(previous[2], {}),
        42: await inactivePublishableHash(ordinary, beforeAliases),
      },
      'config/inactive.json': moves,
      ...(scenario === 'text edit' && { 'tooltips/42.json': tooltip(42, 'cleared edit') }),
    });
    const hashes = allAggregates
      ? [1, 2, 3]
      : scenario === 'removal without a snapshot'
        ? [2, 43]
        : scenario === 'layout only' || scenario === 'aggregate alias'
          ? [2]
          : [2, 42];
    await f.globals.drain();
    if (clearedEntry) {
      f.approve(40);
      await f.globals.drain();
    }
    const liveHead = f.git.head(L);
    await f.request(hashes);
    await f.pub.operation(A);
    const result = f.read(paths(A).log).result;
    if (
      scenario === 'layout only' ||
      scenario === 'unchanged row' ||
      scenario === 'all aggregates with only layouts'
    ) {
      expect(result).toMatchObject({
        status: 'rejected',
        error: expect.stringContaining('saved global layout changes'),
      });
      expect(f.git.head(L)).toBe(liveHead);
      return;
    }
    expect(result.status, result.error).toBe(
      scenario === 'removal without a snapshot' ? 'unchanged' : 'done',
    );
    const expected = composeGlobalRelease(
      f.published,
      f.globals.store(f.current()),
      clearedEntry ? [clearedEntry.id] : [],
    );
    for (const hash of hashes.filter((hash) => hash <= 3))
      expect(f.read(`live/tooltips/${hash}.json`)).toEqual(projectGlobals(expected)[hash]);
    expect(f.read('live/pushed.json')[2]).not.toBe(
      await inactivePublishableHash(f.read('tooltips/2.json'), aliases, moves),
    );
    const live = JSON.parse(f.git.blob(f.git.tree(f.git.head(L)!)['liveDescriptions.json']));
    for (const hash of hashes.filter((hash) => hash > 3)) {
      const selected =
        hash === 43 ? { hash, text: {}, associated: [] } : f.read('tooltips/42.json');
      expect(f.read('live/pushed.json')[hash]).toBe(
        await inactivePublishableHash(selected, aliases, moves),
      );
      if (scenario.includes('removal')) expect(live.perks[hash]).toBeUndefined();
      else expect(f.read(`live/tooltips/${hash}.json`)).toEqual(selected);
    }
    if (scenario === 'alias addition' || scenario === 'aggregate alias')
      expect(live.perks[142].aliasOf).toBe(scenario === 'aggregate alias' ? 2 : 42);
    if (scenario === 'inactive alias') expect(live.perks[142]).toBeUndefined();
  });
  it.each([false, true])(
    'keeps a twice-saved translation releasable with v2 composition (already live=%s)',
    async (historical) => {
      const f = await fixture();
      const published = structuredClone(f.published);
      const alpha = published.entries.find(({ name }) => name === 'Alpha')!;
      const beta = published.entries.find(({ name }) => name === 'Beta')!;
      const variables = published.aggregates.find(({ document }) => document.hash === 2)!;
      alpha.definitions.en!.updatedAt = '2026-09-01T00:00:00Z';
      variables.languages.en!.metadata.updatedAt = alpha.definitions.en!.updatedAt;
      const reader = tooltip(41, '#Beta');
      reader.text.de = cell('#Beta');
      const live = JSON.parse(f.git.blob(f.git.tree(f.git.head(L)!)['liveDescriptions.json']));
      Object.assign(
        live.perks,
        exportLegacy([projectGlobals(published)[2], reader], 0, f.options.facts),
      );
      f.git.refs.set(
        L,
        f.git.commit(f.git.head(L), {
          'liveDescriptions.json': f.git.writeBlob(encode(live)),
        }),
      );
      f.change({
        ...Object.fromEntries(
          published.entries.map((entry) => [`globals/entries/${entry.id}.json`, entry]),
        ),
        'globals/layout.json': { version: 1, aggregates: published.aggregates },
        'globals/live/converter-v2-test.json': {
          version: 1,
          destination: f.options.liveBranch,
          store: published,
        },
        'live/tooltips/41.json': reader,
        'tooltips/41.json': reader,
      });
      const port = await mutationPort(f);
      await f.globals.drain();
      for (const body of ['80', '81']) {
        const response = await port.edit(beta.id, body, 'de');
        expect(response.status, await response.text()).toBe(200);
        await f.globals.drain();
      }
      if (historical) {
        // Emulate a v2 entry-only release where the German projection
        // was published without the definition's source date.
        const store = f.globals.store(f.current());
        delete store.aggregates.find(({ document }) => document.hash === 2)!.languages.de!.metadata
          .sourceUpdatedAt;
        const previous = projectGlobals(store)[2];
        Object.assign(live.perks, exportLegacy([previous], 0, f.options.facts));
        f.git.refs.set(
          L,
          f.git.commit(f.git.head(L), {
            'liveDescriptions.json': f.git.writeBlob(encode(live)),
          }),
        );
        f.change({
          ...Object.fromEntries(
            Object.keys(f.current())
              .filter((path) => /^globals\/(causes|reviews)\//.test(path))
              .map((path) => [path, undefined]),
          ),
          'globals/live/converter-v2-test.json': {
            version: 1,
            destination: f.options.liveBranch,
            store,
          },
          'live/tooltips/2.json': previous,
        });
        await f.globals.drain();
      }
      const reviews = Object.keys(f.current())
        .filter((path) => path.startsWith('globals/reviews/'))
        .map((path) => rowSchema.parse(f.read(path)))
        .filter((row) => row.review.causes.some((cause) => cause.globalId === beta.id));
      expect(reviews.some((row) => row.review.consumer.lang === 'de')).toBe(!historical);
      for (const row of reviews) await port.acknowledge(row, beta.id);
      await f.globals.drain();
      await f.request([2]);
      const liveHead = f.git.head(L);
      await f.pub.operation(A);
      if (historical) {
        expect(f.read(paths(A).log).result).toMatchObject({
          status: 'rejected',
          error: expect.stringContaining('saved global layout changes'),
        });
        expect(f.git.head(L)).toBe(liveHead);
      } else {
        expect(f.read(paths(A).log).result.status).toBe('done');
        expect(f.read('live/tooltips/2.json').text.de).toMatchObject({ text: '\nvar Beta = 81' });
        expect(f.read('live/tooltips/2.json').text.de.sourceUpdatedAt).toBeUndefined();
        expect(f.read('live/pushed.json')[2]).not.toBe(
          await inactivePublishableHash(f.read('tooltips/2.json'), {}),
        );
      }
    },
  );
  it('rejects layout-only publication that would overwrite meaningful legacy secondary output', async () => {
    const f = await fixture();
    const before = JSON.parse(f.git.blob(f.git.tree(f.git.head(L)!)['liveDescriptions.json']));
    const reader = tooltip(140, '#Alpha');
    f.options.facts[140] = { name: 'Reader', type: 'Weapon Perk' };
    Object.assign(before.perks, exportLegacy([reader], 0, f.options.facts));
    before.perks[2].editor.en.secondary = 'var Alpha = 77';
    f.git.refs.set(
      L,
      f.git.commit(f.git.head(L), {
        'liveDescriptions.json': f.git.writeBlob(encode(before)),
      }),
    );
    const layout = structuredClone(f.published.aggregates);
    layout[0].languages.en!.segments[0] = { literal: '// only the comment changed\n' };
    f.change({
      ...Object.fromEntries(
        f.published.entries.map((entry) => [`globals/entries/${entry.id}.json`, entry]),
      ),
      'globals/layout.json': { version: 1, aggregates: layout },
      'tooltips/140.json': reader,
      'live/tooltips/140.json': reader,
    });
    await f.globals.drain();
    const live = f.git.head(L);
    await f.request([2]);
    await f.pub.operation(A);
    expect(f.git.head(L)).toBe(live);
    expect(f.read(paths(A).log).result).toMatchObject({
      status: 'rejected',
      error: expect.stringContaining('changes legacy consumer output'),
    });
  });
  it.each([1, 2, 3] as const)('keeps withdrawal stamps consistent for library %i', (hash) => {
    const declaration = (name: string, value: string) =>
      hash === 2
        ? `var ${name} = ${value}`
        : `${hash === 1 ? 'export' : 'title'} ${name} (\n${value}\n)`;
    const englishDate = '2026-09-01T00:00:00Z';
    const priorDate = '2026-01-01T00:00:00Z';
    const newDate = '2026-10-01T00:00:00Z';
    const translations = ['de', 'fr', 'es', 'it'] as const;
    const library = tooltip(
      hash,
      `${declaration('Kept', '10')}\n${declaration('Withdrawn', '20')}`,
    );
    library.text.en!.updatedAt = englishDate;
    for (const lang of translations) {
      library.text[lang] = {
        ...cell(declaration('Kept', '30')),
        sourceUpdatedAt: lang === 'it' ? priorDate : englishDate,
      };
    }
    let nextId = 0;
    const published = inventoryGlobals(
      [1, 2, 3].map((value) => (value === hash ? library : tooltip(value, ''))),
      {
        repository: 'owner/data',
        revision: 'initial',
        locate: (value, lang) => ({
          path: `tooltips/${value}.json`,
          selector: ['text', lang, 'text'],
        }),
      },
      () => `g_matrix${++nextId}000`,
    );
    const readerText =
      hash === 1 ? 'import Kept from global' : hash === 2 ? '#Kept' : '<title Kept [Kept] />';
    const reader = tooltip(140, readerText);
    for (const lang of translations) reader.text[lang] = cell(readerText);
    const ids = {
      kept: published.entries.find((entry) => entry.name === 'Kept')!.id,
      withdrawn: published.entries.find((entry) => entry.name === 'Withdrawn')!.id,
    };
    const before = projectGlobals(published);
    const facts = Object.fromEntries(
      [1, 2, 3, 140].map((value) => [value, { name: String(value), type: 'Weapon Perk' }]),
    );
    const snapshot = (globals: Record<string, Tooltip>) => ({
      repository: 'owner/data',
      revision: 'initial',
      tooltips: { ...globals, 140: reader },
      aliases: {},
      types: { 140: 'Weapon Perk' },
      mode: 'live' as const,
    });
    const convert = (perks: ReturnType<typeof exportLegacy>) =>
      JSON.parse(Buffer.from(buildLegacy({ perks } as LegacyInput, 'clarity')).toString())[140]
        .descriptions;
    const previousPerks = exportLegacy(Object.values(snapshot(before).tooltips), 0, facts);
    const previousDescriptions = convert(previousPerks);
    const verify = (
      store: typeof published,
      untouched: readonly (typeof translations)[number][],
    ) => {
      const after = projectGlobals(store);
      expect(after[hash].text.en).toEqual(before[hash].text.en);
      const previousExport = previousPerks[hash];
      const currentPerks = exportLegacy(Object.values(snapshot(after).tooltips), 0, facts);
      const currentExport = currentPerks[hash];
      const currentDescriptions = convert(currentPerks);
      expect('editor' in previousExport && 'editor' in currentExport).toBe(true);
      if (!('editor' in previousExport) || !('editor' in currentExport))
        throw new Error('Missing export');
      const impact = calculateGlobalImpact(
        snapshot(before),
        snapshot(after),
        [
          {
            kind: 'titles',
            beforeName: 'Review',
            cause: { globalId: ids.withdrawn, beforeRevision: null, afterRevision: 'matrix' },
          },
        ],
        'converter-v2-test',
      );
      expect(impact.complete, impact.blockers.join('\n')).toBe(true);
      for (const lang of untouched) {
        expect(after[hash].text[lang]!.updatedAt).toBe(before[hash].text[lang]!.updatedAt);
        expect(after[hash].text[lang]!.sourceUpdatedAt).toBe(
          before[hash].text[lang]!.sourceUpdatedAt,
        );
        expect(usesEnglishFallback(after[hash], lang)).toBe(
          usesEnglishFallback(before[hash], lang),
        );
        expect(currentExport.editor[lang]?.englishFallback).toBe(
          previousExport.editor[lang]?.englishFallback,
        );
        expect(currentExport.editor[lang]?.main.trim()).toBe(
          previousExport.editor[lang]?.main.trim(),
        );
        expect(currentDescriptions[lang]).toEqual(previousDescriptions[lang]);
        const row = impact.rows.find(
          ({ consumer }) => consumer.hash === 140 && consumer.lang === lang,
        )!;
        expect(row.after!.rendered).toEqual(row.before!.rendered);
      }
    };

    const entries = structuredClone(published.entries);
    const withdrawn = entries.find(({ id }) => id === ids.withdrawn)!;
    const kept = entries.find(({ id }) => id === ids.kept)!;
    const temporary = {
      body: '40',
      revision: 'temporary',
      updatedAt: newDate,
      updatedBy: 'alice',
      sourceUpdatedAt: priorDate,
    };
    withdrawn.definitions.de = { ...temporary };
    withdrawn.definitions.fr = { ...temporary };
    const staged = reconcileGlobalStore(published.aggregates, entries);
    for (const lang of ['de', 'fr'] as const)
      expect(usesEnglishFallback(projectGlobals(staged)[hash], lang)).toBe(true);
    delete withdrawn.definitions.de;
    delete withdrawn.definitions.fr;
    const saved = reconcileGlobalStore(staged.aggregates, entries);
    verify(saved, ['es', 'it']);
    verify(composeGlobalRelease(published, saved, [ids.withdrawn]), translations);

    withdrawn.definitions.de = { ...temporary, revision: 'readded', sourceUpdatedAt: englishDate };
    withdrawn.definitions.de.updatedAt = '2026-10-02T00:00:00Z';
    const readded = reconcileGlobalStore(saved.aggregates, entries);
    expect(projectGlobals(readded)[hash].text.de!.updatedAt).toBe(withdrawn.definitions.de.updatedAt);
    expect(usesEnglishFallback(projectGlobals(readded)[hash], 'de')).toBe(false);
    verify(readded, ['es', 'it']);
    verify(composeGlobalRelease(published, readded, [ids.withdrawn]), ['fr', 'es', 'it']);

    kept.definitions.de = { ...temporary, body: '30' };
    delete withdrawn.definitions.de;
    const owned = reconcileGlobalStore(staged.aggregates, entries);
    expect(projectGlobals(owned)[hash].text.de!.updatedAt).toBe(newDate);
    expect(usesEnglishFallback(projectGlobals(owned)[hash], 'de')).toBe(true);
    verify(owned, ['es', 'it']);

    const held = structuredClone(saved);
    held.entries.find(({ id }) => id === ids.kept)!.definitions.en!.body = '999';
    held.aggregates.find(({ document }) => document.hash === hash)!.languages.en!.segments[0] = {
      literal: '// held layout\n',
    };
    const partial = composeGlobalRelease(published, held, [ids.withdrawn]);
    expect(projectGlobals(partial)[hash].text.en).toEqual(before[hash].text.en);
    verify(partial, translations);
  });
  it('publishes the selected exports layout without an independently approved variable edit', async () => {
    const f = await fixture('', true);
    const layout = structuredClone(f.published.aggregates);
    layout[0].languages.en!.segments[0] = { literal: '// edited exports layout\n' };
    f.change({
      ...Object.fromEntries(
        f.published.entries
          .filter(({ name }) => name !== 'Beta')
          .map((entry) => [`globals/entries/${entry.id}.json`, entry]),
      ),
      'globals/layout.json': { version: 1, aggregates: layout },
    });
    await f.globals.drain();
    expect(f.read('globals/proofs/publication/converter-v2-test/1-en.json').approved).toBe(true);
    expect(f.current()['globals/proofs/publication/converter-v2-test/2-en.json']).toBeUndefined();
    f.approve(41);
    await f.globals.drain();
    await f.request([1]);
    await f.pub.operation(A);
    expect(f.read(paths(A).log).result).toMatchObject({
      status: 'done',
      outcomes: [{ hash: 1, status: 'published' }],
    });
    expect(f.read('live/tooltips/2.json')).toEqual(projectGlobals(f.published)[2]);
  });
  it('can publish after creating and removing an unused variable in a translated library', async () => {
    const f = await fixture('', false, true);
    f.change({
      ...Object.fromEntries(
        f.published.entries.map((entry) => [`globals/entries/${entry.id}.json`, entry]),
      ),
      'globals/catalog.json': { version: 1, lastPage: 0 },
      'globals/pages/p0.json': {
        version: 1,
        ids: f.published.entries.map(({ id }) => id),
        nextCursor: null,
      },
    });
    const port = await mutationPort(f);
    await f.globals.drain();
    const before = f.read('tooltips/2.json');
    const create = () =>
      port.post('', {
        operation: 'create',
        kind: 'variables',
        name: 'Gamma',
        lang: 'en',
        body: '30',
      });
    let response = await create();
    if (response.status === 202) {
      await f.globals.drain();
      response = await create();
    }
    expect(response.status, await response.clone().text()).toBe(200);
    const {
      value: {
        entry: { id, revision },
      },
    } = await response.json();
    await f.globals.drain();
    expect(f.read('tooltips/2.json').text.en.updatedAt).not.toBe(before.text.en.updatedAt);
    response = await port.post(`/${id}/remove`, { operation: 'remove', id, revision });
    expect(response.status, await response.text()).toBe(200);
    await f.globals.drain();
    const saved = f.read('tooltips/2.json');
    expect(saved.text.en.updatedAt).not.toBe(before.text.en.updatedAt);
    expect(saved.text.de).toEqual(before.text.de);
    expect(f.read('globals/proofs/publication/converter-v2-test/2-de.json').approved).toBe(true);
    await f.request([2]);
    await f.pub.operation(A);
    expect(f.read(paths(A).log).result.status).toBe('done');
    expect(f.read('live/tooltips/2.json')).toEqual(before);
    expect(f.read('live/pushed.json')[2]).not.toBe(await inactivePublishableHash(saved, {}));
  });
  it.each(['empty', 'surviving', 'live', 'live-with-alpha'] as const)(
    'releases cleared entries after a German withdrawal (%s)',
    async (scenario) => {
      const translated = scenario.startsWith('live');
      const f = await fixture('', false, translated);
      const published = structuredClone(f.published);
      const alpha = published.entries.find(({ name }) => name === 'Alpha')!;
      const beta = published.entries.find(({ name }) => name === 'Beta')!;
      const variables = published.aggregates.find(({ document }) => document.hash === 2)!;
      if (scenario === 'live') {
        delete alpha.definitions.de;
        variables.languages.de!.segments = variables.languages.de!.segments.filter(
          (segment) => !('entryId' in segment) || segment.entryId !== alpha.id,
        );
      }
      const september = '2026-09-01T00:00:00Z';
      beta.definitions.en!.updatedAt = september;
      variables.languages.en!.metadata.updatedAt = september;
      if (translated) {
        beta.definitions.de!.sourceUpdatedAt = september;
        variables.languages.de!.metadata.sourceUpdatedAt = september;
      }
      const liveVariables = projectGlobals(published)[2];
      const reader = tooltip(41, '#Beta');
      reader.text.de = cell('#Beta');
      const live = JSON.parse(f.git.blob(f.git.tree(f.git.head(L)!)['liveDescriptions.json']));
      Object.assign(
        live.perks,
        exportLegacy([liveVariables, reader, tooltip(40, 'unrelated')], 0, f.options.facts),
      );
      f.git.refs.set(
        L,
        f.git.commit(f.git.head(L), { 'liveDescriptions.json': f.git.writeBlob(encode(live)) }),
      );
      f.change({
        ...Object.fromEntries(
          published.entries.map((entry) => [`globals/entries/${entry.id}.json`, entry]),
        ),
        'globals/layout.json': { version: 1, aggregates: published.aggregates },
        'globals/live/converter-v2-test.json': {
          version: 1,
          destination: f.options.liveBranch,
          store: published,
        },
        'live/tooltips/2.json': liveVariables,
        'live/pushed.json': { 2: await inactivePublishableHash(liveVariables, {}) },
        'live/tooltips/40.json': tooltip(40, 'unrelated'),
        'tooltips/40.json': tooltip(40, 'unrelated'),
        'live/tooltips/41.json': reader,
        'tooltips/41.json': reader,
      });
      const port = await mutationPort(f);
      const acknowledgeBeta = async () => {
        for (const path of Object.keys(f.current()).filter((path) =>
          path.startsWith('globals/reviews/'),
        )) {
          const row = rowSchema.parse(f.read(path));
          if (row.review.acknowledgement) continue;
          const id =
            row.review.causes.find((cause) => cause.globalId === beta.id)?.globalId ??
            row.review.causes[0].globalId;
          await port.acknowledge(row, id);
        }
        await f.globals.drain();
      };
      await f.globals.drain();
      if (scenario === 'surviving') {
        const kept = await port.edit(beta.id, '211', 'de');
        expect(kept.status, await kept.text()).toBe(200);
        await f.globals.drain();
      }
      const edit = await port.edit(alpha.id, '112', 'de');
      expect(edit.status, await edit.text()).toBe(200);
      await f.globals.drain();
      const removed = await port.post(`/${alpha.id}/remove`, {
        operation: 'remove',
        id: alpha.id,
        lang: 'de',
        revision: f.read(`globals/entries/${alpha.id}.json`).revision,
      });
      expect(removed.status, await removed.text()).toBe(200);
      await f.globals.drain();
      const saved = f.read('tooltips/2.json');
      expect(saved.text.de.text).not.toContain('Alpha');
      expect(usesEnglishFallback(saved, 'de')).toBe(true);
      await f.globals.drain();
      await acknowledgeBeta();
      expect(f.read('globals/proofs/publication/converter-v2-test/2-de.json').approved).toBe(true);
      const released = composeGlobalRelease(
        published,
        f.globals.store(f.current()),
        scenario === 'surviving' ? [alpha.id, beta.id] : [alpha.id],
      );
      const releasedTooltip = projectGlobals(released)[2];
      await f.request([2]);
      await f.pub.operation(A);
      expect(f.read(paths(A).log).result.status).toBe('done');
      expect(f.read('live/tooltips/2.json')).toEqual(releasedTooltip);
      expect(f.read('live/pushed.json')[2]).toBe(await inactivePublishableHash(releasedTooltip, {}));
      expect(f.read('live/pushed.json')[2]).not.toBe(await inactivePublishableHash(saved, {}));
      expect(f.read('globals/live/converter-v2-test.json').store).toEqual(released);
      const B = '01K95H00000000000000000002';
      await f.globals.drain();
      const liveHead = f.git.head(L);
      await f.request([2], B);
      await f.pub.operation(B);
      expect(f.read(paths(B).log).result).toMatchObject({
        status: 'rejected',
        error: expect.stringContaining('saved global layout changes'),
      });
      expect(f.git.head(L)).toBe(liveHead);
      // A new reviewed edit can still publish, with its exact saved stamp and layout.
      const later = await port.edit(beta.id, '212', 'de');
      expect(later.status, await later.text()).toBe(200);
      await f.globals.drain();
      await acknowledgeBeta();
      const C = '01K95H00000000000000000003';
      await f.request([2], C);
      await f.pub.operation(C);
      expect(f.read(paths(C).log).result.status).toBe('done');
      expect(f.read('live/tooltips/2.json')).toEqual(f.read('tooltips/2.json'));
    },
  );
  it('drains once, preserves audits on metadata-only retries, and produces bounded name/publication proofs', async () => {
    const f = await fixture();
    const sources = await f.globals.sources(f.current(), f.git.head(L)!);
    const proofRequest = {
      version: 1,
      type: 'name-proof',
      id: 'retry1',
      operation: 'create',
      kind: 'variables',
      name: 'NeverUsed',
      globalId: null,
      revision: null,
      expectedHead: f.git.head(D),
      sources,
      by: 'alice',
      at: new Date(now).toISOString(),
    };
    f.change({
      'globals/retries/one.json': proofRequest,
      'globals/retries/two.json': { ...proofRequest, id: 'retry2' },
    });
    await f.globals.drain();
    expect(Object.keys(f.current()).filter((path) => path.startsWith('globals/retries/'))).toEqual(
      [],
    );
    expect(syncSchema.parse(f.read('globals/sync.json')).status).toBe('current');
    const proofPaths = Object.keys(f.current()).filter((path) =>
      path.startsWith('globals/proofs/clashes/'),
    );
    expect(proofPaths.map((path) => f.read(path).name).sort()).toEqual([
      'Alpha',
      'Beta',
      'NeverUsed',
    ]);
    f.approve(40);
    await f.globals.drain();
    expect(f.read('globals/proofs/publication/converter-v2-test/40-en.json').approved).toBe(true);
    const row = Object.keys(f.current()).find(
      (path) => path.startsWith('globals/reviews/') && f.read(path).review.consumer.hash === 40,
    )!;
    expect(globalFileBytes(f.read(row))).toBeLessThan(16_384);
    const before = f.read(row).review.acknowledgement;
    await f.globals.drain();
    expect(f.read(row).review.acknowledgement).toEqual(before);
  });
  it('releases the cleared subset first and the exact layout after the held entry is reviewed', async () => {
    const f = await fixture();
    const layout = structuredClone(f.published.aggregates);
    layout[0].languages.en!.segments[0] = { literal: '// saved layout\n' };
    f.change({ 'globals/layout.json': { version: 1, aggregates: layout } });
    await f.globals.drain();
    f.approve(40);
    await f.globals.drain();
    const digest = await inactivePublishableHash(f.read('tooltips/2.json'), {});
    await f.request([2]);
    await f.pub.operation(A);
    const live = JSON.parse(f.git.blob(f.git.tree(f.git.head(L)!)['liveDescriptions.json']));
    expect(live.perks[2].editor.en.main).toBe('// ordered\nvar Alpha = 100\n\nvar Beta = 20\n');
    expect(f.read(paths(A).log).result.status).toBe('done');
    expect(f.read('live/pushed.json')[2]).not.toBe(digest);

    f.approve(41);
    await f.globals.drain();
    const B = '01K95H00000000000000000002';
    await f.request([2], B);
    await f.pub.operation(B);
    expect(f.read(paths(B).log).result.status).toBe('done');
    expect(f.read('live/tooltips/2.json')).toEqual(f.read('tooltips/2.json'));
    expect(f.read('live/pushed.json')[2]).toBe(digest);
  });
  it.each([false, true])(
    'refuses a full aggregate with inconsistent saved inputs (malformed=%s)',
    async (malformed) => {
      const f = await fixture();
      f.change(
        Object.fromEntries(
          f.published.entries.map((entry) => [`globals/entries/${entry.id}.json`, entry]),
        ),
      );
      await f.globals.drain();
      const document = f.read('tooltips/2.json');
      document.text.en.text = '// only the saved snapshot changed\n' + document.text.en.text;
      f.change({
        'tooltips/2.json': document,
        ...(malformed ? { 'globals/layout.json': {} } : {}),
      });
      const live = f.git.head(L);
      await f.request([2]);
      await f.pub.operation(A);
      expect(f.git.head(L)).toBe(live);
      expect(f.read(paths(A).log).result).toMatchObject({
        status: 'rejected',
        error: malformed
          ? 'ConsumerOutputRejected: Sync pending: global dependency review required'
          : expect.stringContaining('would publish a different revision than requested'),
      });
    },
  );
  it('publishes approved entry edits with layout only for the explicitly requested aggregate', async () => {
    const f = await fixture('title Info (\nBefore\n)', true);
    const layout = structuredClone(f.saved.aggregates);
    layout[0].languages.en!.segments[0] = { literal: '// unrelated export layout\n' };
    const variables = layout[1].languages.en!.segments;
    layout[1].languages.en!.segments = [
      { literal: '// reverse the order\n' },
      variables[3],
      { literal: '\n' },
      variables[1],
    ];
    f.change({
      'globals/layout.json': { version: 1, aggregates: layout },
      ...Object.fromEntries(
        f.published.entries
          .filter((entry) => entry.name !== 'Beta')
          .map((entry) => [`globals/entries/${entry.id}.json`, entry]),
      ),
    });
    await f.globals.drain();
    f.approve(41);
    await f.globals.drain();
    await f.request([2]);
    await f.pub.operation(A);
    expect(f.read(paths(A).log).result.status).toBe('done');
    expect(f.read('live/tooltips/2.json')).toEqual(f.read('tooltips/2.json'));
    expect(f.read('live/tooltips/1.json')).toEqual(projectGlobals(f.published)[1]);
  });
  it('allows an unrelated push and refuses unreviewed, stale, revoked, and trial audits', async () => {
    const f = await fixture();
    await f.globals.drain();
    await expect(
      f.globals.release(f.current(), f.git.head(D)!, [40], f.git.head(L)!),
    ).rejects.toThrow('review required');
    expect(
      (await f.globals.release(f.current(), f.git.head(D)!, [42], f.git.head(L)!))!.documents.map(
        (document) => document.hash,
      ),
    ).toEqual([42]);
    f.approve(40, 'translator');
    await expect(
      f.globals.release(f.current(), f.git.head(D)!, [40], f.git.head(L)!),
    ).rejects.toThrow();
    f.approve(40);
    f.change({ 'tooltips/40.json': tooltip(40, '#Alpha changed after review') });
    await expect(
      f.globals.release(f.current(), f.git.head(D)!, [40], f.git.head(L)!),
    ).rejects.toThrow();
    await f.globals.drain();
    expect(
      Object.keys(f.current())
        .filter((path) => path.startsWith('globals/reviews/'))
        .map((path) => f.read(path))
        .filter((row) => row.review.consumer.hash === 40)
        .every((row) => !row.review.acknowledgement),
    ).toBe(true);
  });
  it('does not transfer an old acknowledgement after permission and login ownership changes', async () => {
    const f = await fixture();
    await f.globals.drain();
    f.approve(40);
    f.change({
      'config/permissions.json': {
        users: { '1': { login: 'former', role: 'trial' }, '3': { login: 'alice', role: 'editor' } },
      },
    });
    await f.globals.drain();
    const rows = Object.keys(f.current())
      .filter((path) => path.startsWith('globals/reviews/'))
      .map((path) => f.read(path));
    expect(
      rows.find((row) => row.review.consumer.hash === 40).review.acknowledgement,
    ).toBeUndefined();
    await expect(
      f.globals.release(f.current(), f.git.head(D)!, [40], f.git.head(L)!),
    ).rejects.toThrow('review required');
  });
  it.each(['beforeCas', 'beforeAtomic'] as const)(
    'publishes 28 rows when its own kick advances data at %s',
    async (race) => {
      const f = await fixture();
      const hashes = [42, ...Array.from({ length: 27 }, (_, index) => 100 + index)];
      const changed = Object.fromEntries(
        hashes.map((hash) => {
          f.options.facts[hash] = { name: String(hash), type: 'Weapon Perk' };
          return [`tooltips/${hash}.json`, tooltip(hash, `Changed text ${hash}`)];
        }),
      );
      f.change(changed);
      await f.globals.drain();
      await f.request(hashes);
      const kick = `publish/kicks/${A}-12345.json`;
      f.git[race] = () => f.change({ [kick]: { opId: A } });
      await f.pub.operation(A);
      expect(f.read(paths(A).log).result).toMatchObject({ status: 'done' });
      expect(f.read(kick)).toEqual({ opId: A });
      const live = f.pub.read<{ perks: Record<number, unknown> }>(
        f.git.tree(f.git.head(L)!),
        'liveDescriptions.json',
      );
      for (const hash of hashes) {
        expect(live?.perks[hash]).toMatchObject({
          editor: { en: { main: `Changed text ${hash}` } },
        });
      }
    },
  );
  it.each(['enqueue', 'drain', 'round trip'] as const)(
    'records a candidate during a name-proof %s',
    async (action) => {
      const f = await fixture();
      if (action === 'round trip')
        f.change({ 'tooltips/42.json': tooltip(42, 'var NeverUsed = 42\n#NeverUsed') });
      await f.globals.drain();
      const proofId = '3283270b-d921-468b-8d09-6b4a90659d30';
      const proofPath = `globals/retries/${proofId}.json`;
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
      await f.request([42]);
      const pinned = f.git.head(D);
      const pinnedTree = f.current();
      const sibling = '01K95H00000000000000000002';
      const completed = '01K95H00000000000000000003';
      const kick = `publish/kicks/${sibling}-12345.json`;
      const record = f.pub.record.bind(f.pub);
      f.pub.record = async (...args) => {
        if (args[0] === A && args[6]) {
          if (action === 'round trip') {
            f.change({ [proofPath]: proofRequest });
            await f.globals.drain();
            expect(f.git.head(D)).not.toBe(pinned);
            expect(f.current()).toEqual(pinnedTree);
          } else {
            await f.request([42], sibling);
            f.change({
              [kick]: { opId: sibling },
              [`publish/kicks/batch-${sibling}-12345.json`]: {},
              [`publish/kicks/current-save-${sibling}.json`]: {},
              'publish/kicks/due-202611231625-12345.json': {},
              [paths(completed).log]: { result: {} },
            });
            if (action === 'drain') await f.globals.drain();
            else f.change({ [proofPath]: proofRequest });
          }
        }
        return record(...args);
      };
      await f.pub.operation(A);
      expect(f.read(paths(A).log).result.status).toMatch(/done|unchanged/);
      expect(f.current()[proofPath]).toBeUndefined();
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
    ['a change to the upload markers', { 'live/pushed.json': { '40': 'tampered' } }],
    ['a non-proof retry', { 'globals/retries/3283270b-d921-468b-8d09-6b4a90659d30.json': {} }],
    ['an unrelated addition', { toString: { other: true } }],
  ] as const)(
    'fails closed when a kick races with %s, with no partial live write',
    async (_label, changes) => {
      const f = await fixture();
      await f.globals.drain();
      f.approve(40);
      await f.globals.drain();
      await f.request([40]);
      const before = f.git.head(L);
      f.git.beforeAtomic = () =>
        f.change({ [`publish/kicks/${A}-12345.json`]: { opId: A }, ...changes });
      await f.pub.operation(A);
      expect(f.git.head(L)).toBe(before);
      expect(f.read(paths(A).log).result.status).toBe('rejected');
      expect(f.read('globals/live/converter-v2-test.json').store).toEqual(f.published);
    },
  );
  it.each([
    ['marks', { 'config/marks.json': { types: [], entries: {} } }, false],
    [
      'a Compendium decision',
      {
        'config/marks.json': {
          types: [],
          entries: {},
          compendium: { 42: { kind: 'no-match', by: 1, at: new Date(now).toISOString() } },
        },
      },
      false,
    ],
    ['a glossary edit', { 'glossary/de.json': { v: 1, lang: 'de', terms: {} } }, false],
    ['a localized snippet edit', { 'snippets/de.json': {} }, false],
    ['an export project save', { 'exports/projects/partner.json': { version: 1 } }, false],
    [
      'a staged save',
      {
        [`current-saves/${A}/0.json`]: 'e30=',
        'current-saves/requesters/1.json': { active: { requestId: A, parts: 1 }, starts: [now] },
      },
      false,
    ],
    ['a team snippet edit', { 'config/snippets.json': { snippets: [] } }, true],
    ['another tooltip edit', { 'tooltips/41.json': tooltip(41, 'Saved concurrently') }, true],
  ] as const)(
    'records the signed part during %s (rebuild=%s)',
    async (_label, changes, rebuild) => {
      const f = await fixture();
      const pin = f.read('.publisher/PIN');
      f.change({
        '.publisher/PIN': {
          ...pin,
          capabilities: [...pin.capabilities, globalsConfigWithoutMarks],
        },
      });
      await f.globals.drain();
      await f.request([42]);
      const source = f.git.head(D);
      f.git.beforeAtomic = () => f.change(changes);
      await f.pub.operation(A);
      expect(f.read(paths(A).log).result.status).toMatch(/done|unchanged/);
      for (const [path, value] of Object.entries(changes)) expect(f.read(path)).toEqual(value);
      const receipt = f.pub.read<{ sourceCommit: string }>(
        f.git.tree(f.git.head(L)!),
        paths(A).receipt,
      );
      expect(receipt?.sourceCommit === source).toBe(!rebuild);
      expect(f.current()[paths(A).request]).toBeUndefined();
    },
  );
  it.each([tooltip(40, '#Alpha raced'), undefined])(
    'names the selected row changed during an atomic multirow part',
    async (changed) => {
      const f = await fixture();
      f.options.facts[40].name = 'Changed entry';
      f.options.facts[42].name = 'Still ready';
      await f.globals.drain();
      f.approve(40);
      await f.globals.drain();
      await f.request([40, 42]);
      const before = f.git.head(L);
      f.git.beforeAtomic = () => f.change({ 'tooltips/40.json': changed });
      await f.pub.operation(A);
      const result = f.read(paths(A).log).result;
      expect(result.status).toBe('rejected');
      expect(result.code).toBe('selected-rows-changed');
      expect(result.error).toContain('Changed entry');
      expect(result.error).not.toContain('Still ready');
      expect(result.error).toContain('You can publish them again.');
      expect(result.outcomes).toContainEqual({ hash: 42, status: 'accepted' });
      expect(f.git.head(L)).toBe(before);
      expect(f.pub.read(f.current(), 'tooltips/40.json')).toEqual(changed);
    },
  );
  it.each([false, true])(
    'recovers an exhausted signed request (another save after startup sync=%s)',
    async (anotherSave) => {
      const f = await fixture();
      await f.globals.drain();
      await f.request([42]);
      const live = f.git.head(L);
      const record = f.pub.record.bind(f.pub);
      let changes = 0;
      f.pub.record = async (...args) => {
        if (args[6]) f.change({ 'tooltips/41.json': tooltip(41, `Racing save ${++changes}`) });
        return record(...args);
      };
      await expect(f.pub.operation(A)).rejects.toThrow('request is still queued');
      expect(changes).toBe(3);
      expect(f.current()[paths(A).request]).toBeDefined();
      expect(f.current()[paths(A).log]).toBeUndefined();
      expect(f.git.head(L)).toBe(live);
      f.pub.record = record;
      const restarted = new Publisher(f.git, f.options);
      if (anotherSave) {
        await f.globals.drain();
        f.change({ 'tooltips/41.json': tooltip(41, 'Saved after startup sync') });
        await restarted.operation(A);
      } else {
        await restarted.run();
      }
      expect(f.read(paths(A).log).result.status).toMatch(/done|unchanged/);
    },
  );
  it('rebuilds after another unrelated save immediately after retry sync', async () => {
    const f = await fixture();
    await f.globals.drain();
    await f.request([42]);
    f.git.beforeAtomic = () => f.change({ 'tooltips/41.json': tooltip(41, 'First save') });
    const drain = GlobalsPublisher.prototype.drain;
    const spy = vi
      .spyOn(GlobalsPublisher.prototype, 'drain')
      .mockImplementationOnce(async function (this: GlobalsPublisher, head) {
        const checked = await drain.call(this, head);
        f.change({ 'tooltips/41.json': tooltip(41, 'Second save') });
        return checked;
      });
    try {
      await f.pub.operation(A);
    } finally {
      spy.mockRestore();
    }
    expect(f.read(paths(A).log).result.status).toMatch(/done|unchanged/);
    expect(f.read('tooltips/41.json')).toEqual(tooltip(41, 'Second save'));
  });
  it('rebuilds when the Worker saves a global entry and its projection during RECORD', async () => {
    const f = await fixture();
    const port = await mutationPort(f);
    await f.globals.drain();
    await f.request([42]);
    const alpha = f.saved.entries.find((entry) => entry.name === 'Alpha')!;
    const record = f.pub.record.bind(f.pub);
    let saved = false;
    f.pub.record = async (...args) => {
      if (args[6] && !saved) {
        saved = true;
        expect((await port.edit(alpha.id, 'var Alpha = 777')).status).toBe(200);
        expect(f.current()[`globals/projections/${alpha.id}.json`]).toBeDefined();
      }
      return record(...args);
    };
    await f.pub.operation(A);
    expect(f.read(paths(A).log).result.status).toMatch(/done|unchanged/);
    expect(f.read(`globals/entries/${alpha.id}.json`).definitions.en.body).toContain('777');
  });
  it.each(['before', 'after'] as const)(
    'fences a second DATA move %s rebuild sync',
    async (when) => {
      const f = await fixture();
      await f.globals.drain();
      await f.request([42]);
      const live = f.git.head(L);
      f.git.beforeAtomic = () =>
        f.change({ 'tooltips/41.json': tooltip(41, 'Saved concurrently') });
      const drain = GlobalsPublisher.prototype.drain;
      const move = () => f.change({ 'live/pushed.json': { 42: 'a'.repeat(64) } });
      const spy = vi
        .spyOn(GlobalsPublisher.prototype, 'drain')
        .mockImplementationOnce(async function (this: GlobalsPublisher, head) {
          if (when === 'before') move();
          const checked = await drain.call(this, head);
          if (when === 'after') move();
          return checked;
        });
      try {
        await expect(f.pub.operation(A)).rejects.toBeInstanceOf(RefRace);
      } finally {
        spy.mockRestore();
      }
      expect(f.git.head(L)).toBe(live);
      expect(f.git.head(paths(A).candidate)).toBeDefined();
      expect(f.current()[paths(A).request]).toBeDefined();
      expect(f.current()[paths(A).log]).toBeUndefined();
    },
  );

  it('keeps the signed candidate recoverable after an interruption following sync', async () => {
    const f = await fixture();
    f.options.facts[42].name = 'Selected perk';
    await f.globals.drain();
    await f.request([42]);
    const live = f.git.head(L);
    f.git.beforeAtomic = () => f.change({ 'tooltips/42.json': tooltip(42, 'Saved concurrently') });
    const drain = GlobalsPublisher.prototype.drain;
    const spy = vi
      .spyOn(GlobalsPublisher.prototype, 'drain')
      .mockImplementationOnce(async function (this: GlobalsPublisher, head) {
        await drain.call(this, head);
        throw new Error('Interrupted after sync');
      });
    try {
      await expect(f.pub.operation(A)).rejects.toThrow('Interrupted after sync');
    } finally {
      spy.mockRestore();
    }
    expect(f.git.head(paths(A).candidate)).toBeDefined();
    await new Publisher(f.git, f.options).operation(A);
    expect(f.read(paths(A).log).result).toMatchObject({
      status: 'rejected',
      code: 'selected-rows-changed',
      error: expect.stringContaining('Selected perk'),
    });
    expect(f.git.head(L)).toBe(live);
  });

  it('names a refusal for forged proof bytes claiming the current sources', async () => {
    const f = await fixture();
    f.options.facts[42].name = 'Selected perk';
    await f.globals.drain();
    await f.request([42]);
    const live = f.git.head(L);
    const sources = publicationSourcesPath(f.options.liveBranch);
    const currentSources = f.current()[sources];
    f.git.beforeAtomic = () =>
      f.change({ 'globals/proofs/publication/converter-v2-test/42-en.json': { wrong: true } });
    await f.pub.operation(A);
    expect(f.read(paths(A).log).result).toMatchObject({
      status: 'rejected',
      code: 'selected-rows-changed',
      error: expect.stringContaining('global proofs for Selected perk'),
    });
    expect(f.git.head(L)).toBe(live);
    expect(f.current()[sources]).toBe(currentSources);
  });

  it('keeps the candidate that won an exact replacement lease', async () => {
    const f = await fixture();
    await f.globals.drain();
    await f.request([42]);
    f.git.beforeAtomic = () => f.change({ 'tooltips/41.json': tooltip(41, 'Saved concurrently') });
    const create = f.pub.createCandidate.bind(f.pub);
    let winner: string | undefined;
    f.pub.createCandidate = (...args) => {
      const [opId, , live, receipt, previous] = args;
      if (previous) {
        winner = f.pub.buildCandidate(live, receipt);
        f.git.beforeCas = () => f.git.cas(paths(opId).candidate, previous, winner);
      }
      return create(...args);
    };
    await f.pub.operation(A);
    expect(winner).toBeDefined();
    expect(f.read(paths(A).log).candidateCommit).toBe(winner);
    expect(f.git.head(L)).toBe(winner);
  });

  it('reconciles when another recovery finishes the same request during sync', async () => {
    const f = await fixture();
    await f.globals.drain();
    await f.request([42]);
    f.git.beforeAtomic = () => f.change({ 'tooltips/41.json': tooltip(41, 'Saved concurrently') });
    const drain = GlobalsPublisher.prototype.drain;
    const spy = vi
      .spyOn(GlobalsPublisher.prototype, 'drain')
      .mockImplementationOnce(async function (this: GlobalsPublisher, head) {
        const checked = await drain.call(this, head);
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
      const f = await fixture();
      await f.globals.drain();
      await f.request([42]);
      f.pub.record = async () => {
        throw new RefRace('Runner interrupted');
      };
      await expect(f.pub.operation(A)).rejects.toThrow('Runner interrupted');
      expect(f.git.head(paths(A).candidate)).toBeDefined();
      f.change({ 'tooltips/41.json': tooltip(41, 'Saved before recovery') });
      const pending = new Map(f.git.refs);

      await new Publisher(f.git, f.options).operation(A);
      const completed = new Map(f.git.refs);
      expect(f.read(paths(A).log).candidateCommit).toBe(completed.get(L));
      f.git.refs = pending;

      const runner = new Publisher(f.git, f.options);
      const readCandidate = runner.candidate.bind(runner);
      vi.spyOn(runner, 'candidate').mockImplementationOnce((...args) => {
        const observed = readCandidate(...args);
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

  it.each(['100755', undefined])(
    'rejects a retry kick with mode %s from a mode-aware adapter',
    async (mode) => {
      const f = await fixture();
      const git: Repository = f.git;
      const kick = `publish/kicks/${A}-12345.json`;
      git.treeModes = (head) => {
        const modes = Object.fromEntries(
          Object.keys(git.tree(head)).map((path) => [path, '100644']),
        );
        if (mode) modes[kick] = mode;
        else delete modes[kick];
        return modes;
      };
      await f.globals.drain();
      await f.request([42]);
      const live = git.head(L);
      f.git.beforeAtomic = () => f.change({ [kick]: { opId: A } });
      await f.pub.operation(A);
      expect(f.read(paths(A).log).result.status).toBe('rejected');
      expect(git.head(L)).toBe(live);
    },
  );
  it('rejects a sibling kick alongside an explicit empty config subtree in Git', async () => {
    const f = await fixture();
    mkdirSync('.agents', { recursive: true });
    const repo = mkdtempSync(resolve('.agents/globals-s4-empty-tree-'));
    execFileSync('git', ['init', '--bare', repo], { stdio: 'pipe' });
    execFileSync('git', ['--git-dir', repo, 'config', 'publisher.simulator', 'true']);
    const git = new LocalRepository(repo);
    const pub = new Publisher(git, f.options);
    const source = git.commit(
      undefined,
      { 'config/permissions.json': git.writeBlob('{}') },
      'Pinned data',
    );
    const sibling = '01K95H00000000000000000002';
    const kicked = git.commit(
      source,
      { ...git.tree(source), [`publish/kicks/${sibling}-12345.json`]: git.writeBlob('{}') },
      'Kick sibling publish',
    );
    expect(pub['sourceAdvance'](source, kicked, git.tree(kicked), A)).toBe('bookkeeping');

    const empty = git.git(['mktree'], '').trim();
    const config = git.git(['rev-parse', `${kicked}:config`]).trim();
    const changedConfig = git
      .git(['mktree'], `${git.git(['ls-tree', config])}040000 tree ${empty}\tempty\n`)
      .trim();
    const changedRoot = git
      .git(['mktree'], git.git(['ls-tree', kicked]).replace(config, changedConfig))
      .trim();
    const changed = git
      .git(['commit-tree', changedRoot, '-p', source], 'Kick and change config identity')
      .trim();
    expect(git.tree(changed)).toEqual(git.tree(kicked));
    expect(pub['sourceAdvance'](source, changed, git.tree(changed), A)).toBe('blocked');
  });
  it('refreshes independent approved components in RECORD and drains the next request without another workflow', async () => {
    const f = await fixture();
    await f.globals.drain();
    f.approve(40);
    f.approve(41);
    await f.globals.drain();
    await f.request([40]);
    await f.pub.operation(A);
    const B = '01K95H00000000000000000002';
    await f.request([41], B);
    await f.pub.operation(B);
    expect(f.read(paths(B).log).result.status).toMatch(/done|unchanged/);
    expect(
      f
        .read('globals/live/converter-v2-test.json')
        .store.entries.map(
          (entry: { definitions: { en: { body: string } } }) => entry.definitions.en.body,
        ),
    ).toEqual(['100', '200']);
  });
  it('revalidates frozen exported bytes during candidate recovery', async () => {
    const f = await fixture();
    await f.globals.drain();
    f.approve(40);
    await f.globals.drain();
    await f.request([40]);
    const create = f.pub.createCandidate.bind(f.pub);
    f.pub.createCandidate = (opId, blob, live, receipt) => {
      const library = receipt.exported[2];
      if ('editor' in library)
        library.editor.en!.main = library.editor.en!.main.replace(
          'var Beta = 20',
          'var Beta = 200',
        );
      return create(opId, blob, live, receipt);
    };
    const before = f.git.head(L);
    await f.pub.operation(A);
    expect(f.git.head(L)).toBe(before);
    expect(f.read(paths(A).log).result.status).toBe('rejected');
  });
  it('keeps pending on partial output failure and refuses malformed bootstrap metadata', async () => {
    const f = await fixture();
    f.change({
      'globals/sync.json': {
        version: 1,
        status: 'sync-pending',
        causeIds: ['missing'],
        causeEntries: { missing: f.saved.entries[0].id },
        lastFailure: null,
      },
    });
    await expect(f.globals.drain()).rejects.toThrow();
    expect(f.read('globals/sync.json')).toMatchObject({
      status: 'sync-failed',
      causeIds: ['missing'],
      lastFailure: 'Sync failed. Retry sync.',
    });
    expect(Object.keys(f.current()).some((path) => path.startsWith('globals/reviews/'))).toBe(
      false,
    );
    f.change({
      'globals/sync.json': {
        version: 1,
        status: 'current',
        causeIds: [],
        causeEntries: {},
        lastFailure: 'x'.repeat(513),
      },
    });
    await expect(f.globals.drain()).rejects.toThrow();
  });
  it('repairs a cycle through unchanged S2 admission after a failed impact drain', async () => {
    const f = await fixture('title Info (\nBefore\n)');
    for (const entry of f.saved.entries)
      f.change({
        [(await namePaths(entry.kind, entry.name)).claim]: {
          id: entry.id,
          kind: entry.kind,
          name: entry.name,
        },
      });
    await f.globals.drain();
    const id = f.saved.entries.find((entry) => entry.kind === 'titles')!.id;
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
      access: { role: 'maintainer', login: 'alice' },
      user: { id: 1, login: 'alice' },
      repository: f.options.repo,
      destinations: [f.options.liveBranch],
    });
    const edit = (body: string) =>
      globalsHandler(
        new Request(`https://api.invalid/globals/${id}/body`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expectedHead: f.git.head(D),
            mutation: {
              operation: 'edit',
              id,
              revision: f.read(`globals/entries/${id}.json`).revision,
              lang: 'en',
              body,
            },
          }),
        }),
        load,
      );
    expect((await edit('import main from 3')).status).toBe(200);
    const before = f.current(),
      pending = f.read('globals/sync.json');
    const rows = Object.fromEntries(
      Object.entries(before).filter(([path]) => path.startsWith('globals/reviews/')),
    );
    await expect(f.globals.drain()).rejects.toThrow('incomplete');
    expect(f.read('globals/sync.json')).toMatchObject({
      status: 'sync-failed',
      causeIds: pending.causeIds,
      causeEntries: pending.causeEntries,
    });
    expect(
      Object.fromEntries(
        Object.entries(f.current()).filter(([path]) => path.startsWith('globals/reviews/')),
      ),
    ).toEqual(rows);
    const changed = Object.keys(f.current()).filter((path) => f.current()[path] !== before[path]);
    expect(
      changed.every(
        (path) => path === 'globals/sync.json' || path.startsWith('globals/proofs/clashes/'),
      ),
    ).toBe(true);
    const failedHead = f.git.head(D);
    await expect(f.globals.drain()).rejects.toThrow('incomplete');
    expect(f.git.head(D)).toBe(failedHead);
    expect((await edit('Repaired title')).status).toBe(200);
    expect(f.read('globals/sync.json').causeIds).toHaveLength(2);
    await f.globals.drain();
    expect(f.read('globals/sync.json')).toMatchObject({
      status: 'current',
      causeIds: [],
      lastFailure: null,
    });
    expect(f.read(`globals/entries/${id}.json`).definitions.en.body).toBe('Repaired title');
    for (const cause of pending.causeIds)
      expect(f.current()[`globals/causes/${cause}.json`]).toBeDefined();
  });
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
    const f = await fixture();
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
    await f.globals.drain();
    expect(f.read('globals/sync.json').causeIds).toEqual([]);
    expect(f.read('globals/causes/cause0.json')).toBeDefined();
    const rows = Object.keys(f.current())
      .filter((path) => path.startsWith('globals/reviews/'))
      .map((path) => f.read(path));
    expect(
      rows
        .find((row) => row.review.consumer.hash === 40)
        .review.causes.map((cause: { afterRevision: string }) => cause.afterRevision),
    ).toEqual(['edit0', 'edit1']);
  });
  it('applies one rename intent per revision and releases every superseded name claim', async () => {
    const f = await fixture(),
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
    await f.globals.drain();
    expect(f.read(`globals/entries/${entry.id}.json`)).toMatchObject({
      name: 'First',
      revision: 'intent1',
      nameHistory: [{ name: 'Alpha', revision: 'Alpha2', by: 'alice' }],
    });
    expect(f.read('tooltips/40.json').text.en.text).toBe('#First');
    expect(Object.keys(f.current()).filter((path) => path.startsWith('globals/intents/'))).toEqual(
      [],
    );
    expect(f.current()[(await namePaths(entry.kind, 'Second')).claim]).toBeUndefined();
    expect(f.read((await namePaths(entry.kind, 'First')).claim)).not.toHaveProperty('intentId');
  });
  it('refuses missing live snapshots and drift in actual destination inputs', async () => {
    const f = await fixture();
    f.change({ 'live/tooltips/40.json': undefined });
    await expect(f.globals.drain()).rejects.toThrow('last-published consumer snapshot');
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
    await f.globals.drain();
    expect(f.read('tooltips/140.json').text.en.text).toBe('#Beta');
  });
  it('does not silently apply an unrelated staged inactive move in a globals release', async () => {
    const f = await fixture();
    await f.globals.drain();
    f.approve(40);
    f.change({ 'config/inactive.json': { 40: { by: 1, at: new Date(now).toISOString() } } });
    await f.globals.drain();
    f.approve(40);
    await f.globals.drain();
    await expect(
      f.globals.release(f.current(), f.git.head(D)!, [2], f.git.head(L)!),
    ).rejects.toThrow('inactive move decisions');
    await f.request([40]);
    await f.pub.operation(A);
    expect(f.read(paths(A).log).result.status).toMatch(/done|unchanged/);
    const live = JSON.parse(f.git.blob(f.git.tree(f.git.head(L)!)['liveDescriptions.json']));
    expect(live.perks[40]).toBeUndefined();
    expect(f.read('globals/live/converter-v2-test.json').store).toEqual(f.published);
  });
  it('refreshes proofs and drains a mixed publish with a removal that has no saved or live tooltip', async () => {
    const f = await fixture();
    const hash = 3176795734;
    const moved = { by: 1, at: new Date(now).toISOString() };
    f.options.aliases[140] = { to: 42, kind: 'sandbox' };
    f.change({
      '.publisher/PIN': {
        ...f.read('.publisher/PIN'),
        capabilities: ['globalsRelease', globalsConfigWithoutMarks],
      },
      'config/inactive.json': { [hash]: moved, 140: moved, 141: { ...moved, inactive: false } },
    });
    await f.globals.drain();
    const proofPrefix = 'globals/proofs/publication/converter-v2-test';
    expect(f.current()[`tooltips/${hash}.json`]).toBeUndefined();
    expect(f.current()[`live/tooltips/${hash}.json`]).toBeUndefined();
    expect(f.current()[`${proofPrefix}/140-en.json`]).toBeUndefined();
    expect(f.current()[`${proofPrefix}/141-en.json`]).toBeUndefined();
    expect(f.read(`${proofPrefix}/${hash}-en.json`)).toMatchObject({
      complete: true,
      approved: true,
      independent: true,
      sources: f.read(publicationSourcesPath('converter-v2-test')),
      consumer: { hash, lang: 'en', destination: 'converter-v2-test' },
    });
    const before = await f.globals.sources(f.current(), f.git.head(L)!, f.git.head(D)!);
    f.change({
      'config/marks.json': {
        types: [],
        entries: {},
        compendium: { 42: { kind: 'not-needed', by: 1, at: new Date(now).toISOString() } },
      },
    });
    expect(await f.globals.sources(f.current(), f.git.head(L)!, f.git.head(D)!)).toEqual(before);
    // A marks edit alone leaves the old certificates current, even without another sync.
    await f.request([42, hash]);
    await f.pub.operation(A);
    expect(f.read(paths(A).log).result.status).toMatch(/done|unchanged/);
    expect(f.read('live/pushed.json')[hash]).toBe(
      await inactivePublishableHash(
        { hash, text: {}, associated: [] },
        {},
        f.pub.movesAt(f.current()),
      ),
    );
    const live = JSON.parse(f.git.blob(f.git.tree(f.git.head(L)!)['liveDescriptions.json']));
    expect(live.perks[42]).toBeDefined();
    expect(live.perks[hash]).toBeUndefined();
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

it.each(['current', 'historical'])(
  'keeps %s non-global missing imports blocking during forward repair',
  async (input) => {
    const f = await fixture('title Info (\nBefore\n)');
    const port = await mutationPort(f);
    await f.globals.drain();
    const id = f.saved.entries.find((entry) => entry.kind === 'titles')!.id;
    expect((await port.edit(id, 'import main from 3')).status).toBe(200);
    await expect(f.globals.drain()).rejects.toThrow();
    if (input === 'historical') {
      f.change({ 'tooltips/40.json': tooltip(40, 'import main from 999') });
      await expect(f.globals.drain()).rejects.toThrow('incomplete');
    }
    expect((await port.edit(id, 'Repaired')).status).toBe(200);
    f.change({
      'tooltips/40.json': tooltip(40, input === 'current' ? 'import main from 999' : '#Alpha'),
    });
    await expect(f.globals.drain()).rejects.toThrow('incomplete');
  },
);

it('keeps sync available for an upcoming consumer affected by aggregate fallback', async () => {
  const f = await fixture();
  const old = projectGlobals(f.published);
  old[2].text.de = {
    ...cell('var Alpha = 1\n\nvar Beta = 2\n'),
    sourceUpdatedAt: '2026-01-01T00:00:00Z',
  };
  let n = 0;
  const published = inventoryGlobals(
    [old[2], old[3]],
    {
      repository: 'owner/data',
      revision: 'initial',
      locate: (hash, lang) => ({ path: `tooltips/${hash}.json`, selector: ['text', lang, 'text'] }),
    },
    () => `g_fixture${++n}000`,
  );
  const saved = structuredClone(published);
  const alpha = saved.entries.find((entry) => entry.name === 'Alpha')!;
  alpha.revision = 'later';
  alpha.definitions.en!.revision = 'later';
  alpha.definitions.en!.body = '100';
  alpha.definitions.en!.updatedAt = '2026-11-01T00:00:00Z';
  const docs = Object.fromEntries(
    Object.keys(f.current())
      .filter((path) => /^live\/tooltips\/\d+.json$/.test(path))
      .map((path) => {
        const doc = f.read(path) as Tooltip;
        return [doc.hash, doc];
      }),
  );
  Object.assign(docs, projectGlobals(published));
  f.git.refs.set(
    L,
    f.git.commit(f.git.head(L), {
      'liveDescriptions.json': f.git.writeBlob(
        encode({
          perks: exportLegacy(Object.values(docs), 0, f.options.facts),
          databaseSettings: {},
        }),
      ),
    }),
  );
  f.change({
    'globals/layout.json': { version: 1, aggregates: published.aggregates },
    'globals/live/converter-v2-test.json': {
      version: 1,
      destination: 'converter-v2-test',
      store: published,
    },
    'tooltips/2.json': projectGlobals(saved)[2],
    'live/tooltips/2.json': projectGlobals(published)[2],
    ...Object.fromEntries(
      saved.entries.map((entry) => [`globals/entries/${entry.id}.json`, entry]),
    ),
    'schedule/batches/frozen/tooltips/42.json': {
      hash: 42,
      base: tooltip(42, 'unrelated'),
      baseCommit: f.git.head(D),
      proposed: { ...tooltip(42, 'unrelated'), text: { en: cell('unrelated'), de: cell('#Beta') } },
      updatedAt: '2026-01-01T00:00:00Z',
      updatedBy: 'alice',
    },
  });
  const capture = f.globals.capture(f.current(), f.git.head(D)!, f.git.head(L)!);
  const proposed = f.read('schedule/batches/frozen/tooltips/42.json').proposed;
  const before = {
    ...capture.live,
    tooltips: { ...capture.authored.tooltips, 42: proposed, ...projectGlobals(published) },
  };
  const after = {
    ...before,
    tooltips: {
      ...before.tooltips,
      ...projectGlobals(composeGlobalRelease(published, saved, [alpha.id])),
    },
  };
  const census = calculateGlobalImpact(
    before,
    after,
    [
      {
        kind: 'titles',
        beforeName: 'Probe',
        afterName: 'Probe',
        cause: { globalId: alpha.id, beforeRevision: 'initial', afterRevision: 'later' },
      },
    ],
    f.options.liveBranch,
  );
  expect(census.complete).toBe(true);
  const row = census.rows.find((row) => row.consumer.hash === 42 && row.consumer.lang === 'de')!;
  expect(row.before?.rendered).not.toBe(row.after?.rendered);
  // Upcoming pins are invalidated by the preparer; their presence must not wedge
  // the sync that produces the current global review ledger.
  await expect(f.globals.plan(f.current(), f.git.head(D)!, f.git.head(L)!)).resolves.toBeDefined();
});

it('withholds a title-local name proof and keeps real S2 from creating a conflicting entry', async () => {
  const f = await fixture('title Info (\nvar Local = 1\n#Local\nText\n)');
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
  await f.globals.drain();
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

  it('proves mutually importing batch proposals together without releasing them from Current', async () => {
    const f = await fixture('', true);
    const one = tooltip(41, 'export First (\nFirst effect\n)\nimport Second from 42');
    const two = tooltip(42, 'export Second (\nSecond effect\n)\nimport First from 41');
    const layout = structuredClone(f.published.aggregates);
    layout[0].languages.en!.segments[0] = { literal: '// reviewed exports layout\n' };
    f.change({
      ...Object.fromEntries(
        f.published.entries.map((entry) => [`globals/entries/${entry.id}.json`, entry]),
      ),
      'globals/layout.json': { version: 1, aggregates: layout },
      [batchPath]: batch('draft'),
      [memberPath(41)]: member(one, f.read('tooltips/41.json')),
      [memberPath(42)]: member(two, f.read('tooltips/42.json')),
    });
    await f.globals.drain();
    expect(f.read('globals/proofs/publication/converter-v2-test/1-en.json').approved).toBe(true);
    const original = [41, 42].map((hash) => f.read(`live/tooltips/${hash}.json`));
    await f.request([1]);
    await f.pub.operation(A);
    expect(f.read(paths(A).log).result.status).toBe('done');
    expect(f.pub.receipt(f.git.head(L)!, A)?.entries.map(({ hash }) => hash)).toEqual([1]);
    expect([41, 42].map((hash) => f.read(`live/tooltips/${hash}.json`))).toEqual(original);

    const source = f.git.head(D)!;
    const release = await f.globals.release(f.current(), source, [41, 42], f.git.head(L)!, {
      source,
      documents: [one, two],
    });
    expect(release?.documents.filter(({ hash }) => hash > 3)).toEqual([one, two]);
    await expect(
      f.globals.release(f.current(), source, [41], f.git.head(L)!, { source, documents: [one] }),
    ).rejects.toThrow('dependency closure is incomplete');
  });

  it('keeps removal and name proofs away until a batch is final, and stales them if it changes', async () => {
    const f = await fixture();
    const plain = tooltip(41, 'unrelated'),
      proposed = tooltip(41, '#Beta\nvar Local = 1\n#Local');
    const docs = Object.keys(f.current())
      .filter((path) => path.startsWith('live/tooltips/'))
      .map((path) => f.read(path) as Tooltip);
    f.git.refs.set(
      L,
      f.git.commit(f.git.head(L), {
        'liveDescriptions.json': f.git.writeBlob(
          encode({
            perks: exportLegacy(
              docs.map((document) => (document.hash === 41 ? plain : document)),
              0,
              f.options.facts,
            ),
            databaseSettings: {},
          }),
        ),
      }),
    );
    f.change({ 'tooltips/41.json': plain, 'live/tooltips/41.json': plain });
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
      await f.globals.drain();
      return [removal, name].map((path) => f.current()[path] !== undefined);
    };
    f.change({ [memberPath(41)]: member(proposed, plain) });
    for (const status of ['draft', 'scheduled', 'publishing', 'needs_attention'] as const) {
      f.change({ [batchPath]: batch(status) });
      expect(await drain()).toEqual([false, false]);
    }
    // Published with an activation conflict: the resolve route can still write the proposal.
    f.change({ [batchPath]: batch('published'), [conflictPath(41)]: { hash: 41 } });
    expect(await drain()).toEqual([false, false]);
    f.change({ [conflictPath(41)]: undefined });
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
