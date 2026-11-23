import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inventoryGlobals, projectGlobals } from '../../packages/core/src/globals/projection.js';
import {
  composeGlobalRelease,
  globalsConfigWithoutMarks,
  observeGlobalSources,
} from '../../packages/core/src/globalsRelease/index.js';
import { exportLegacy } from '../../packages/core/src/exportLegacy.js';
import { publicationSourcesPath } from '../../packages/core/src/globalsRelease/admission.js';
import { calculateGlobalImpact } from '../../packages/core/src/globals/impact.js';
import { inactivePublishableHash } from '../../packages/core/src/inactiveMoves.js';
import type { Tooltip } from '../../packages/core/src/schemas.js';
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
    const expected = Object.fromEntries(
      await Promise.all(
        hashes.map(async (hash) => [
          hash,
          await inactivePublishableHash(tooltipSchemaRead(hash), {}, pub.movesAt(current())),
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
  const edit = (id: string, body: string, lang = 'en') =>
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
            lang,
            body,
          },
        }),
      }),
      load,
    );
  return { load, edit };
}

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
  it('rejects a layout change that alters a live consumer through language fallback', async () => {
    const f = await fixture('', false, true);
    const layout = structuredClone(f.published.aggregates);
    layout[0].languages.en!.metadata.updatedAt = '2026-09-01T00:00:00Z';
    f.change({
      ...Object.fromEntries(
        f.published.entries.map((entry) => [`globals/entries/${entry.id}.json`, entry]),
      ),
      'globals/layout.json': { version: 1, aggregates: layout },
    });
    await f.globals.drain();
    const live = f.git.head(L);
    await f.request([2]);
    await f.pub.operation(A);
    expect(f.git.head(L)).toBe(live);
    expect(f.read(paths(A).log).result).toMatchObject({
      status: 'rejected',
      error: expect.stringContaining('saved global layout changes'),
    });
  });
  it.each([false, true])(
    'publishes a reviewed translation fallback (repairing an old marker=%s)',
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
        // Emulate a pre-fix entry-only release where the German projection
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
        await expect(
          f.globals.release(f.current(), f.git.head(D)!, [2], f.git.head(L)!),
        ).rejects.toThrow('review required');
      }
      const reviews = Object.keys(f.current())
        .filter((path) => path.startsWith('globals/reviews/'))
        .map((path) => rowSchema.parse(f.read(path)))
        .filter((row) => row.review.causes.some((cause) => cause.globalId === beta.id));
      expect(reviews.some((row) => row.review.consumer.lang === 'de')).toBe(true);
      for (const row of reviews) {
        const response = await globalsHandler(
          new Request(`https://api.invalid/globals/${beta.id}/acknowledge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              expectedHead: f.git.head(D),
              mutation: {
                operation: 'acknowledge',
                id: beta.id,
                consumerId: row.id,
                contentDigest: row.review.contentDigest,
                dependencyDigest: row.review.dependencyDigest,
                impactDigest: row.impactDigest,
                decision: 'no-text-change',
              },
            }),
          }),
          port.load,
        );
        expect(response.status, await response.text()).toBe(200);
      }
      await f.globals.drain();
      await f.request([2]);
      await f.pub.operation(A);
      expect(f.read(paths(A).log).result.status).toBe('done');
      expect(f.read('live/tooltips/2.json')).toEqual(f.read('tooltips/2.json'));
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
  it('rejects a signed full aggregate when only one entry can release', async () => {
    const f = await fixture();
    await f.globals.drain();
    f.approve(40);
    await f.globals.drain();
    const base = f.git.head(L)!;
    await f.request([2]);
    await f.pub.operation(A);
    expect(f.git.head(L)).toBe(base);
    expect(f.read(paths(A).log).result).toMatchObject({
      status: 'rejected',
      error: expect.stringContaining('Tooltip 2 would publish a different revision'),
    });
    expect(f.read('live/pushed.json')).toEqual({});

    const B = '01K95H00000000000000000002';
    await f.request([40], B);
    await f.pub.operation(B);
    const live = JSON.parse(f.git.blob(f.git.tree(f.git.head(L)!)['liveDescriptions.json']));
    expect(live.perks[2].editor.en.main).toContain('var Alpha = 100');
    expect(live.perks[2].editor.en.main).toContain('var Beta = 20\n');
    expect(live.perks[2].editor.en.main).not.toContain('var Beta = 200');
    expect(f.read(paths(B).log).result.status).toMatch(/done|unchanged/);
    expect(
      f
        .read('globals/live/converter-v2-test.json')
        .store.entries.find((entry: { name: string }) => entry.name === 'Beta').definitions.en.body,
    ).toBe('20');
  });
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
    ['a tooltip edit', { 'tooltips/40.json': tooltip(40, '#Alpha raced') }],
    ['a tooltip removal', { 'tooltips/40.json': undefined }],
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
    expect(pub['onlyPublishBookkeeping'](source, kicked, git.tree(kicked), A)).toBe(true);

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
    expect(pub['onlyPublishBookkeeping'](source, changed, git.tree(changed), A)).toBe(false);
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
    f.change({ 'config/marks.json': { editorialOnly: true } });
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
