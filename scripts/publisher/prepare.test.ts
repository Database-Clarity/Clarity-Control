import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  currentSavePartBytes,
  currentSaveStagePaths as currentPaths,
  currentSaveStageLifetime,
  currentSaveStagingCapability,
  exportLegacy,
  publishableHash,
  stableStringify,
  type Tooltip,
} from '@clarity/core';
import {
  batchSchema,
  schedulePaths,
  scheduleIntentPaths,
  scheduleRequestSchema,
  type Batch,
  type ScheduleIntent,
  type ScheduleRequest,
} from '@clarity/core/schedule';
import {
  buildLegacy,
  deployedLegacyPresets,
  type LegacyInput,
} from '../../packages/export/src/legacy.js';
import { SchedulePreparer } from '../schedule-prepare/prepare.js';
import { publication, schedulePayload } from '../schedule-prepare/intents.js';
import { GlobalsPublisher, globalTreeOid } from './globals.js';
import { inventoryGlobals } from '../../packages/core/src/globals/projection.js';
import { LocalRepository, RefRace, type Tree, type Repository } from './git.js';
import { Publisher, paths, type Options } from './publisher.js';
import { json } from './batch.js';
import { stampUploads } from '../../apps/worker/src/stamp.js';
import { runPipeline } from './pipeline.js';
import { newUlid, withIndexEntry } from '../../apps/worker/src/schedule/store.js';
import { createRequest } from './request.js';
import { drainCurrentSaves } from './currentSave.js';

const D = 'refs/heads/editor-data',
  L = 'refs/heads/converter-v2-test';
const B = '01K95H000000000000000000B1',
  R = '01K95H000000000000000000S1',
  S = '01K95H000000000000000000S2';
const NOW = Date.parse('2030-03-17T18:00:00.000Z');
const AT = new Date(NOW).toISOString(),
  DUE = '2030-03-17T17:55:00.000Z';
const user = { id: 1, login: 'alice' };
const tip = (text = 'reviewed'): Tooltip => ({
  hash: 123,
  associated: [],
  text: { en: { text, updatedAt: '2030-01-01T00:00:00.000Z', updatedBy: 'alice' } },
});
const sha = (s: string) => createHash('sha1').update(s).digest('hex');

/** In-memory refs with immutable commit snapshots; real exporter/validators still execute. */
class Memory implements Repository {
  beforeAtomic?: () => void;
  refs = new Map<string, string>();
  blobs = new Map<string, string>();
  commits = new Map<string, { parent?: string; tree: Tree }>();
  head(ref: string) {
    return this.refs.get(ref);
  }
  tree(commit: string) {
    const c = this.commits.get(commit);
    if (!c) throw new Error('Missing commit');
    return { ...c.tree };
  }
  blob(oid: string) {
    const b = this.blobs.get(oid);
    if (b === undefined) throw new Error('Missing blob');
    return b;
  }
  writeBlob(s: string) {
    const oid = sha(`blob ${Buffer.byteLength(s)}\0${s}`);
    this.blobs.set(oid, s);
    return oid;
  }
  commit(parent: string | undefined, tree: Tree, message: string) {
    const oid = sha(stableStringify({ parent: parent ?? null, tree, message }));
    this.commits.set(oid, { parent, tree: { ...tree } });
    return oid;
  }
  cas(ref: string, old: string | undefined, next: string | undefined) {
    if (this.head(ref) !== old) throw new RefRace('raced');
    if (next) this.refs.set(ref, next);
    else this.refs.delete(ref);
  }
  casMany(updates: { ref: string; old: string; next: string }[]) {
    const callback = this.beforeAtomic;
    this.beforeAtomic = undefined;
    callback?.();
    if (updates.some(({ ref, old }) => this.head(ref) !== old)) throw new RefRace('atomic race');
    for (const { ref, next } of updates) this.refs.set(ref, next);
  }
  history(ref: string) {
    const result: string[] = [];
    let h = this.head(ref);
    while (h) {
      result.unshift(h);
      h = this.commits.get(h)?.parent;
    }
    return result;
  }
  ancestor(a: string, b: string) {
    let h: string | undefined = b;
    while (h) {
      if (h === a) return true;
      h = this.commits.get(h)?.parent;
    }
    return false;
  }
  additions(head: string, prefix: string) {
    const commits: string[] = [];
    let h: string | undefined = head;
    while (h) {
      commits.unshift(h);
      h = this.commits.get(h)?.parent;
    }
    return commits.flatMap((commit) => {
      const c = this.commits.get(commit)!,
        before = c.parent ? this.tree(c.parent) : {};
      return Object.keys(c.tree)
        .filter((p) => p.startsWith(prefix) && !before[p])
        .map((path) => ({ commit, path }));
    });
  }
}

async function fixture(git: Repository = new Memory(), repository = 'test/local') {
  const keys = generateKeyPairSync('ed25519');
  const clock = { now: NOW };
  const options: Options = {
    repo: repository,
    dataBranch: 'editor-data',
    liveBranch: 'converter-v2-test',
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    keyFingerprint: createHash('sha256')
      .update(keys.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex'),
    publisherSha: 'a'.repeat(40),
    publisherDigest: 'c'.repeat(64),
    generatorSha: 'b'.repeat(40),
    aliases: {},
    facts: { 123: { name: 'Thing', type: 'perk' }, 124: { name: 'Other', type: 'perk' } },
    now: () => clock.now,
    runUrl: 'https://github.com/test/local/actions/runs/1',
    backoff: async () => {},
  };
  const pub = new Publisher(git, options),
    prep = new SchedulePreparer(pub);
  function change(files: Record<string, unknown>, remove: string[] = []) {
    const h = git.head(D),
      tree = h ? git.tree(h) : {};
    for (const [p, v] of Object.entries(files)) tree[p] = git.writeBlob(json(v));
    for (const p of remove) delete tree[p];
    const c = git.commit(h, tree, 'fixture write');
    git.cas(D, h, c);
    return c;
  }
  const read = <T = unknown>(p: string): T =>
    pub.read<T>(git.tree(pub.head(options.dataBranch)), p)!;
  const batch = () => batchSchema.parse(read(schedulePaths.batch(B)));
  const request = (id = R) => scheduleRequestSchema.parse(read(scheduleIntentPaths.request(id)));
  const base = tip(),
    proposed = tip('approved correction');
  proposed.text.en!.updatedAt = '2030-03-17T17:00:00.000Z';
  change({
    'config/permissions.json': {
      users: {
        1: { login: 'alice', role: 'editor' },
        2: { login: 'bob', role: 'translator', languages: ['fr'] },
      },
    },
    '.publisher/PIN': {
      sourceSha: options.publisherSha,
      sha256: options.publisherDigest,
      capabilities: [
        'scheduledBatches',
        'schedulePreparationV1',
        'elementTags',
        'markupBraces',
        'numberTokens',
      ],
    },
    'tooltips/123.json': base,
    'live/tooltips/123.json': base,
    'live/pushed.json': { 123: await publishableHash(base) },
    'schedule/due.json': { entries: [] },
    'schedule/index.json': { batches: [] },
    [schedulePaths.batch(B)]: {
      id: B,
      name: 'Reviewed',
      createdBy: user,
      createdAt: AT,
      revision: 1,
      contentRevision: 1,
      status: 'draft',
      notBefore: null,
      zone: null,
      opId: null,
      scheduledContentRevision: null,
      claim: null,
      result: null,
      events: [],
    },
    [schedulePaths.member(B, 123)]: {
      hash: 123,
      base,
      proposed,
      baseCommit: 'd'.repeat(40),
      updatedAt: AT,
      updatedBy: user.login,
    },
  });
  git.cas(
    L,
    undefined,
    git.commit(
      undefined,
      {
        'liveDescriptions.json': git.writeBlob(
          json({
            perks: Object.fromEntries(
              [1, 2, 3].map((hash) => [
                hash,
                { hash, editor: { en: { main: '', secondary: '' } } },
              ]),
            ),
            databaseSettings: {},
          }),
        ),
      },
      'live',
    ),
  );
  function admit(
    kind: 'schedule' | 'save',
    changes?: unknown[],
    actor = user,
    notBefore = DUE,
    id = kind === 'schedule' ? R : S,
    draftStaging?: { id: string; finish: boolean },
  ) {
    const sourceCommit = pub.head(options.dataBranch),
      sourceTree = git.tree(sourceCommit),
      before = batch();
    const input =
      kind === 'schedule'
        ? { requestId: id, revision: before.revision, notBefore, zone: 'UTC' }
        : {
            requestId: id,
            revision: before.revision,
            changes,
            message: 'Save reviewed translation',
            ...(draftStaging ? { draftStaging } : {}),
          };
    const body = JSON.stringify(input);
    const common = {
      version: 1 as const,
      requestId: id,
      batchId: B,
      repo: options.repo,
      dataBranch: options.dataBranch,
      liveBranch: options.liveBranch,
      requester: actor,
      expectedRevision: before.revision,
      contentRevision: before.contentRevision,
      sourceCommit,
      memberTreeOid: globalTreeOid(sourceTree, `schedule/batches/${B}/tooltips`),
      createdAt: AT,
      bodyDigest: createHash('sha256').update(body).digest('hex'),
    };
    const intent: ScheduleIntent =
      kind === 'schedule'
        ? { ...common, kind, notBefore, zone: 'UTC' }
        : {
            ...common,
            kind,
            returnStatus: before.status as 'draft' | 'scheduled',
            ...(draftStaging ? { draftStaging } : {}),
            onValidationFailure:
              actor.id === 2 && before.status === 'scheduled'
                ? 'keep_scheduled'
                : 'needs_attention',
          };
    const payload = stableStringify(intent),
      envelope = {
        payload,
        sig: sign(null, Buffer.from(payload), keys.privateKey).toString('base64'),
      };
    const scheduled = kind === 'schedule' || before.status === 'scheduled';
    const next: Batch = {
      ...before,
      revision: before.revision + 1,
      status: 'preparing',
      preparedRequestId: null,
      preparation: {
        requestId: id,
        kind,
        returnStatus: scheduled ? 'scheduled' : 'draft',
        requestedAt: AT,
        attempt: 1,
      },
      ...(draftStaging
        ? { draftStaging: { id: draftStaging.id, ownerId: actor.id, updatedAt: AT } }
        : {}),
      ...(kind === 'schedule'
        ? { opId: id, notBefore, zone: 'UTC', scheduledContentRevision: null }
        : {}),
    };
    const req: ScheduleRequest = {
      envelope,
      requestId: id,
      batchId: B,
      requesterId: actor.id,
      bodyDigest: intent.bodyDigest,
      admissionRevision: next.revision,
      status: 'pending',
      attempt: 1,
      updatedAt: AT,
    };
    change(
      {
        [schedulePaths.batch(B)]: next,
        [scheduleIntentPaths.request(id)]: req,
        ...(scheduled
          ? {
              'schedule/due.json': {
                entries: [
                  { batchId: B, opId: next.opId, notBefore: next.notBefore, claimed: false },
                ],
              },
            }
          : {}),
        ...(before.opId
          ? { [scheduleIntentPaths.publication(B)]: read(paths(before.opId).request) }
          : {}),
      },
      before.opId ? [paths(before.opId).request] : [],
    );
    // Bodies are exact bytes, not a JSON string or a pretty-printed object.
    const h = pub.head(options.dataBranch),
      tree = git.tree(h);
    tree[scheduleIntentPaths.body(id)] = git.writeBlob(body);
    git.cas(D, h, git.commit(h, tree, 'fixture raw body'));
    return req;
  }
  return {
    git,
    pub,
    prep,
    options,
    read,
    change,
    batch,
    request,
    admit,
    base,
    proposed,
    clock,
    keys,
  };
}

async function stagedCurrentFixture(count = 2, correctDigest = true) {
  const f = await fixture();
  const text = ' Existing text.'.repeat(127);
  const edits = Array.from({ length: count }, (_, index) => {
    const hash = 123 + index;
    const template = index ? 'import TOKEN from 123\n' : 'export TOKEN (\nValue\n)\n';
    const base = { ...tip(template.replace('TOKEN', 'Old') + text), hash };
    const next = { ...tip(template.replace('TOKEN', 'New') + text), hash };
    next.text.en!.updatedAt = AT;
    return { hash, base, next };
  });
  const bytes = Buffer.from(JSON.stringify({ changes: edits, message: 'Rename shared export' }));
  const files: Record<string, unknown> = Object.fromEntries(
    edits.map(({ hash, base }) => [`tooltips/${hash}.json`, base]),
  );
  let parts = 0;
  for (let start = 0; start < bytes.length; start += currentSavePartBytes)
    files[currentPaths.part(S, parts++)] = bytes
      .subarray(start, start + currentSavePartBytes)
      .toString('base64');
  const staged = { requester: user, updatedAt: AT, parts, status: 'uploading' };
  f.change({
    ...files,
    [currentPaths.record(S)]: staged,
    '.publisher/PIN': {
      sourceSha: f.options.publisherSha,
      sha256: f.options.publisherDigest,
      capabilities: [currentSaveStagingCapability],
    },
  });
  const payload = stableStringify({
    version: 1,
    requestId: S,
    requester: user,
    repo: f.options.repo,
    branch: f.options.dataBranch,
    sourceCommit: f.pub.head(f.options.dataBranch),
    parts,
    digest: correctDigest ? createHash('sha256').update(bytes).digest('hex') : 'a'.repeat(64),
  });
  const envelope = {
    payload,
    sig: sign(null, Buffer.from(payload), f.keys.privateKey).toString('base64'),
  };
  f.change({ [currentPaths.record(S)]: { ...staged, status: 'queued', envelope } });
  return { ...f, edits };
}

describe('offline staged Current saves', () => {
  it('expires an abandoned Current upload and releases its account slot', async () => {
    const f = await fixture();
    const expired = NOW - currentSaveStageLifetime - 1;
    f.change({
      [currentPaths.record(S)]: {
        requester: user,
        status: 'uploading',
        parts: 1,
        updatedAt: new Date(expired).toISOString(),
      },
      [currentPaths.part(S, 0)]: 'YQ==',
      [currentPaths.usage(user.id)]: { active: { requestId: S, parts: 1 }, starts: [expired] },
    });
    await drainCurrentSaves(f.pub);
    expect(f.read(currentPaths.record(S))).toBeUndefined();
    expect(f.read(currentPaths.part(S, 0))).toBeUndefined();
    expect(f.read(currentPaths.usage(user.id))).toMatchObject({ active: null, starts: [expired] });
  });

  it('applies a 36-tooltip export rename and acknowledges its immutable commit through one CAS', async () => {
    const f = await stagedCurrentFixture(36);
    const update = vi.spyOn(f.git, 'cas');
    await drainCurrentSaves(f.pub);
    expect(update).toHaveBeenCalledTimes(1);
    const result = f.read(currentPaths.record(S)) as { status: string; commit: string };
    expect(result.status).toBe('saved');
    const commit = f.git.tree(result.commit);
    for (const { hash, next } of f.edits) {
      expect(f.read(`tooltips/${hash}.json`)).toEqual(next);
      expect(f.pub.read(commit, `tooltips/${hash}.json`)).toEqual(next);
    }
    expect(f.read(currentPaths.part(S, 0))).toBeUndefined();
    update.mockClear();
    await drainCurrentSaves(f.pub);
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps the whole closure unchanged on bad content or revoked permission', async () => {
    for (const revoked of [false, true]) {
      const f = await stagedCurrentFixture(2, revoked);
      if (revoked) f.change({ 'config/permissions.json': { users: {} } });
      await drainCurrentSaves(f.pub);
      expect(f.read(currentPaths.record(S))).toMatchObject({ status: 'failed' });
      for (const { hash, base } of f.edits) expect(f.read(`tooltips/${hash}.json`)).toEqual(base);
      expect(f.read(currentPaths.part(S, 0))).toBeUndefined();
    }
  });

  it('rechecks a concurrent owner save at CAS and records conflicts without applying any part', async () => {
    const f = await stagedCurrentFixture();
    const cas = f.git.cas.bind(f.git);
    let raced = false;
    const external = { ...tip('Concurrent edit'), hash: 124 };
    vi.spyOn(f.git, 'cas').mockImplementation((ref, head, next) => {
      if (!raced && ref === D) {
        raced = true;
        f.change({ 'tooltips/124.json': external });
        throw new RefRace('A concurrent save won');
      }
      cas(ref, head, next);
    });
    await drainCurrentSaves(f.pub);
    expect(raced).toBe(true);
    expect(f.read('tooltips/123.json')).toEqual(f.edits[0]!.base);
    expect(f.read('tooltips/124.json')).toEqual(external);
    expect(f.read(currentPaths.record(S))).toMatchObject({ status: 'conflicts' });
    expect(f.read(currentPaths.conflicts(S))).toMatchObject({ conflicts: [{ hash: 124 }] });
  });
});

async function withGlobals(
  f: Awaited<ReturnType<typeof fixture>>,
  body = '#Alpha',
  titles = '',
  exports = '',
) {
  const library = (hash: number, text: string) => ({ ...tip(text), hash });
  const docs = [
    library(1, exports),
    library(2, 'var Alpha = 10\nvar Beta = 20'),
    library(3, titles),
  ];
  for (const doc of docs) f.options.facts[doc.hash] = { name: String(doc.hash), type: 'perk' };
  let sequence = 0;
  const store = inventoryGlobals(
    exports ? docs : docs.slice(1),
    {
      repository: f.options.repo,
      revision: 'bootstrap',
      locate: (hash, lang) => ({ path: `tooltips/${hash}.json`, selector: ['text', lang, 'text'] }),
    },
    () => `g_schedule${++sequence}000`,
  );
  const proposed = {
    ...structuredClone(f.proposed),
    text: { ...f.proposed.text, en: { ...f.proposed.text.en!, text: body } },
  };
  const member = f.read<Record<string, unknown>>(schedulePaths.member(B, 123));
  f.change({
    '.publisher/config.json': {
      generatorSha: f.options.generatorSha,
      aliases: f.options.aliases,
      facts: f.options.facts,
    },
    '.publisher/PIN': {
      sourceSha: f.options.publisherSha,
      sha256: f.options.publisherDigest,
      capabilities: [
        'scheduledBatches',
        'schedulePreparationV1',
        'globalsRelease',
        'globalsExportsV1',
        'scheduledGlobalsV1',
      ],
    },
    'globals/layout.json': { version: 1, aggregates: store.aggregates },
    'globals/live/converter-v2-test.json': { version: 1, destination: f.options.liveBranch, store },
    'globals/sync.json': {
      version: 1,
      status: 'current',
      causeIds: [],
      causeEntries: {},
      lastFailure: null,
    },
    ...Object.fromEntries(
      store.entries.map((entry) => [`globals/entries/${entry.id}.json`, entry]),
    ),
    ...Object.fromEntries(
      docs.flatMap((doc) => [
        [`tooltips/${doc.hash}.json`, doc],
        [`live/tooltips/${doc.hash}.json`, doc],
      ]),
    ),
    [schedulePaths.member(B, 123)]: { ...member, proposed },
  });
  const old = f.git.head(L);
  f.git.cas(
    L,
    old,
    f.git.commit(
      old,
      {
        'liveDescriptions.json': f.git.writeBlob(
          json({
            perks: exportLegacy([...docs, f.base], 0, f.options.facts, {}),
            databaseSettings: {},
          }),
        ),
      },
      'globals bootstrap',
    ),
  );
  return { store, proposed };
}

describe('scheduled global closure', () => {
  it('publishes scheduled consumers with the pinned export projection in the same receipt', async () => {
    const f = await fixture();
    const { store } = await withGlobals(
      f,
      'import Barrier from global',
      '',
      'export Barrier (\nStuns Champions.\n)',
    );
    f.admit('schedule');
    await f.prep.drain();
    expect(f.request().reasons).toEqual([]);
    expect(f.batch().status).toBe('scheduled');
    await f.pub.operation(R);
    expect(f.batch().status).toBe('published');
    const receipt = f.pub.receipt(f.pub.head('converter-v2-test'), R)!;
    expect(receipt.entries.map((entry) => entry.hash)).toEqual([1, 2, 3, 123]);
    expect(receipt.globals?.published.store).toEqual(store);
  });
  it('invalidates an export revision before the due minute without a partial publication', async () => {
    const f = await fixture();
    const { store } = await withGlobals(
      f,
      'import Barrier from global',
      '',
      'export Barrier (\nStuns Champions.\n)',
    );
    f.admit('schedule', undefined, user, '2030-03-17T18:30:00.000Z');
    await f.prep.drain();
    expect(f.batch().status).toBe('scheduled');
    const live = f.pub.head('converter-v2-test');
    const entry = structuredClone(store.entries.find((entry) => entry.kind === 'exports')!);
    entry.revision = 'changed';
    entry.definitions.en!.revision = 'changed';
    f.change({ [`globals/entries/${entry.id}.json`]: entry });
    await f.prep.drain(true);
    expect(f.batch().status).toBe('needs_attention');
    expect(f.pub.head('converter-v2-test')).toBe(live);
    expect(f.batch().claim).toBeNull();
  });
  it.each([
    'missing body',
    'mismatched body',
    'key rotation',
    'missing record',
    'malformed record',
  ])('isolates %s in one ready batch and still publishes unrelated work', async (fault) => {
    const f = await fixture();
    await withGlobals(f);
    f.admit('schedule', undefined, user, '2030-03-17T18:30:00.000Z');
    await f.prep.drain();
    let keys = f.keys;
    if (fault === 'key rotation') {
      keys = generateKeyPairSync('ed25519');
      f.options.publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      f.options.keyFingerprint = createHash('sha256')
        .update(keys.publicKey.export({ type: 'spki', format: 'der' }))
        .digest('hex');
    } else if (fault === 'missing body') f.change({}, [scheduleIntentPaths.body(R)]);
    else if (fault === 'mismatched body')
      f.change({ [scheduleIntentPaths.body(R)]: { tampered: true } });
    else if (fault === 'missing record') f.change({}, [scheduleIntentPaths.request(R)]);
    else f.change({ [scheduleIntentPaths.request(R)]: { malformed: true } });
    const manual = { ...tip('unrelated manual publication'), hash: 124 };
    f.change({ 'tooltips/124.json': manual });
    const opId = newUlid(NOW);
    await createRequest(
      f.git,
      {
        kind: 'push',
        opId,
        repo: f.options.repo,
        dataBranch: f.options.dataBranch,
        liveBranch: f.options.liveBranch,
        requester: user,
        hashes: [124],
        expected: { 124: await publishableHash(manual) },
      },
      () => NOW,
      (payload) => sign(null, Buffer.from(payload), keys.privateKey).toString('base64'),
    );
    await expect(f.pub.run()).resolves.toBeUndefined();
    expect(f.read(paths(opId).log)).toMatchObject({
      result: { status: expect.stringMatching(/done|unchanged/) },
    });
    expect(f.read('live/tooltips/124.json')).toEqual(manual);
    expect(f.batch().claim).toBeNull();
    if (fault === 'missing record' || fault === 'malformed record') {
      expect(f.batch().status).toBe('scheduled');
      expect(f.read(scheduleIntentPaths.request(R))).toEqual(
        fault === 'missing record' ? undefined : { malformed: true },
      );
    } else {
      expect(f.batch().status).toBe('needs_attention');
      expect(f.batch().preparedRequestId).toBeNull();
      expect(f.request().reasons?.[0].reason).toMatch(/signature|bytes/);
    }
  });
  it.each([null, {}, { generatorSha: 'not-a-commit' }])(
    'refuses missing or malformed immutable generator provenance: %j',
    async (config) => {
      const f = await fixture();
      await withGlobals(f);
      f.change(
        config === null ? {} : { '.publisher/config.json': config },
        config === null ? ['.publisher/config.json'] : [],
      );
      f.admit('schedule');
      const live = f.pub.head('converter-v2-test');
      await f.prep.drain();
      expect(f.batch().status).toBe('needs_attention');
      expect(f.request().reasons?.[0].reason).toContain('generator provenance is missing');
      expect(f.batch().claim).toBeNull();
      expect(f.pub.head('converter-v2-test')).toBe(live);
    },
  );
  it('refuses missing signed generator provenance at claim of an older ready batch', async () => {
    const f = await fixture();
    await withGlobals(f);
    f.change({}, ['.publisher/config.json']);
    f.admit('schedule');
    // Emulate an older preparer's ready output, retaining the real signature and source.
    const request = f.request(),
      batch = f.batch();
    const payload = await schedulePayload(f.pub, request.envelope);
    f.change({
      [paths(R).request]: publication(payload, request.envelope, R),
      [schedulePaths.batch(B)]: {
        ...batch,
        status: 'scheduled',
        preparation: null,
        preparedRequestId: R,
        scheduledContentRevision: batch.contentRevision,
      },
      [scheduleIntentPaths.request(R)]: {
        ...request,
        status: 'completed',
        retryable: false,
        reasons: [],
        result: {
          revision: batch.revision,
          contentRevision: batch.contentRevision,
          status: 'scheduled',
        },
      },
    });
    f.options.generatorSha = 'd'.repeat(40);
    const live = f.pub.head('converter-v2-test');
    await f.pub.operation(R);
    expect(f.batch().status).toBe('needs_attention');
    expect(f.request().reasons?.[0].reason).toContain('generator provenance is missing');
    expect(f.batch().claim).toBeNull();
    expect(f.pub.head('converter-v2-test')).toBe(live);
  });
  it('keeps legacy no-globals ready-only runs byte-inert on data and live', async () => {
    const f = await fixture();
    f.admit('schedule', undefined, user, '2030-03-17T18:30:00.000Z');
    await f.prep.drain();
    f.change({
      'schedule/index.json': { legacyAdvisory: 'preserve these exact bytes' },
      [scheduleIntentPaths.body(R)]: { malformedLegacyEvidence: true },
    });
    const data = f.pub.head('editor-data'),
      live = f.pub.head('converter-v2-test');
    await f.pub.run(false);
    expect(f.pub.head('editor-data')).toBe(data);
    expect(f.pub.head('converter-v2-test')).toBe(live);
    expect(f.batch().status).toBe('scheduled');
    expect(f.batch().preparedRequestId).toBe(R);
  });
  it('invalidates the pinned resolver generator before the due minute', async () => {
    const f = await fixture();
    await withGlobals(f);
    f.admit('schedule');
    await f.prep.drain();
    f.options.generatorSha = 'd'.repeat(40);
    await f.prep.drain(true);
    expect(f.batch().status).toBe('needs_attention');
    expect(f.request().reasons?.[0].reason).toContain('generator changed');
  });
  it.each(['prepare', 'run', 'pipeline', 'claim'])(
    'withdraws an existing pin after namespace removal through %s',
    async (path) => {
      const f = await fixture();
      await withGlobals(f);
      f.admit('schedule', undefined, user, path === 'claim' ? DUE : '2030-03-17T18:30:00.000Z');
      await f.prep.drain();
      const live = f.pub.head('converter-v2-test');
      const tree = f.git.tree(f.pub.head('editor-data'));
      f.change(
        {},
        Object.keys(tree).filter((path) => path.startsWith('globals/')),
      );
      if (path === 'prepare') await f.prep.drain();
      else if (path === 'run') await f.pub.run();
      else if (path === 'pipeline') await f.pub.run(false);
      else await f.pub.operation(R);
      expect(f.pub.head('converter-v2-test')).toBe(live);
      expect(f.batch().claim).toBeNull();
      expect(f.batch().status).toBe('needs_attention');
      expect(f.batch().preparedRequestId).toBeNull();
      expect(f.request().reasons?.[0].reason).toContain('metadata was removed');
    },
  );
  it('blocks a batch that already owes global review when scheduled', async () => {
    const f = await fixture();
    const { store } = await withGlobals(f);
    const alpha = structuredClone(store.entries.find((entry) => entry.name === 'Alpha')!);
    alpha.revision = 'saved';
    alpha.definitions.en!.revision = 'saved';
    alpha.definitions.en!.body = '11';
    f.change({ [`globals/entries/${alpha.id}.json`]: alpha });
    await new GlobalsPublisher(f.pub).drain();
    f.admit('schedule');
    await f.prep.drain();
    expect(f.batch().status).toBe('needs_attention');
    expect(f.request().reasons?.[0].reason).toMatch(/global dependency review required/);
    expect(f.batch().claim).toBeNull();
  });
  it('does not invalidate an unrelated variable edit', async () => {
    const f = await fixture();
    const { store } = await withGlobals(f);
    f.admit('schedule');
    await f.prep.drain();
    const beta = structuredClone(store.entries.find((entry) => entry.name === 'Beta')!);
    beta.revision = 'saved';
    beta.definitions.en!.revision = 'saved';
    beta.definitions.en!.body = '21';
    f.change({ [`globals/entries/${beta.id}.json`]: beta });
    await new GlobalsPublisher(f.pub).drain();
    await f.prep.drain(true);
    expect(f.request().reasons).toEqual([]);
    expect(f.batch().status).toBe('scheduled');
  });
  it('leaves no partial LIVE or markers when data races the atomic transaction', async () => {
    const f = await fixture();
    const { store } = await withGlobals(f);
    f.admit('schedule');
    await f.prep.drain();
    const live = f.pub.head('converter-v2-test'),
      markers = f.read('live/pushed.json'),
      snapshot = f.read('live/tooltips/123.json');
    const alpha = structuredClone(store.entries.find((entry) => entry.name === 'Alpha')!);
    alpha.revision = 'raced';
    alpha.definitions.en!.revision = 'raced';
    alpha.definitions.en!.body = '12';
    (f.git as Memory).beforeAtomic = () =>
      f.change({ [`globals/entries/${alpha.id}.json`]: alpha });
    await f.pub.operation(R);
    expect(f.pub.head('converter-v2-test')).toBe(live);
    expect(f.read('live/pushed.json')).toEqual(markers);
    expect(f.read('live/tooltips/123.json')).toEqual(snapshot);
    expect(f.read(paths(R).log)).toMatchObject({ result: { status: 'rejected' } });
  });
  it.each(['import main from 999', 'import main from 123'])(
    'refuses incomplete resolver closure: %s',
    async (body) => {
      const f = await fixture();
      await withGlobals(f, body);
      f.admit('schedule');
      const live = f.pub.head('converter-v2-test');
      await f.prep.drain();
      expect(f.batch().status).toBe('needs_attention');
      expect(f.request().reasons?.[0].reason).toMatch(/closure.*incomplete/);
      expect(f.pub.head('converter-v2-test')).toBe(live);
    },
  );
  it('observes a variable read in unused title preparation, including revision-only drift', async () => {
    const f = await fixture();
    const { store } = await withGlobals(f, 'unchanged root', 'title Info (\n#Alpha\n)');
    f.admit('schedule', undefined, user, '2030-03-17T18:30:00.000Z');
    await f.prep.drain();
    expect(f.request().reasons).toEqual([]);
    const entry = structuredClone(store.entries.find((entry) => entry.name === 'Alpha')!);
    entry.revision = 'new-revision';
    entry.definitions.en!.revision = 'new-revision';
    f.change({ [`globals/entries/${entry.id}.json`]: entry });
    await f.prep.drain(true);
    expect(f.batch().status).toBe('needs_attention');
  });
  it('pins imported globals, publishes the composed roots, and records LIVE atomically', async () => {
    const f = await fixture();
    const { store, proposed } = await withGlobals(f, 'import main from 124');
    const imported = { ...tip('#Alpha'), hash: 124 };
    f.change({ 'tooltips/124.json': imported, 'live/tooltips/124.json': imported });
    const old = f.git.head(L);
    const live = f.pub.read<{ perks: Record<string, unknown>; databaseSettings: unknown }>(
      f.git.tree(old!),
      'liveDescriptions.json',
    )!;
    f.git.cas(
      L,
      old,
      f.git.commit(
        old,
        {
          'liveDescriptions.json': f.git.writeBlob(
            json({
              ...live,
              perks: { ...live.perks, ...exportLegacy([imported], 0, f.options.facts, {}) },
            }),
          ),
        },
        'import library',
      ),
    );
    f.admit('schedule');
    await f.prep.drain();
    expect(f.request().reasons).toEqual([]);
    expect(f.batch().status).toBe('scheduled');
    const before = f.pub.head('converter-v2-test');
    let atomic = 0;
    const git = f.git as Memory;
    git.beforeAtomic = () => {
      atomic++;
      expect(f.pub.head('converter-v2-test')).toBe(before);
      expect(f.batch().status).toBe('publishing');
    };
    await f.pub.operation(R);
    expect(f.read<{ result: { error?: string } }>(paths(R).log).result.error).toBeUndefined();
    expect(f.read(paths(R).log)).toMatchObject({ result: { status: 'done' } });
    expect(f.batch().status).toBe('published');
    expect(atomic).toBe(1);
    const receipt = f.pub.receipt(f.pub.head('converter-v2-test'), R)!;
    expect(receipt.globals?.roots).toEqual([123]);
    expect(receipt.globals?.published.store).toEqual(store);
    expect(receipt.entries.map((entry) => entry.hash)).toEqual([2, 3, 123]);
    expect(f.read('live/tooltips/123.json')).toEqual(proposed);
    expect(f.read('globals/live/converter-v2-test.json')).toEqual(receipt.globals?.published);
  });
  it.each(['edited', 'review'])('invalidates %s globals before the due minute', async (kind) => {
    const f = await fixture();
    const { store } = await withGlobals(f);
    f.admit('schedule', undefined, user, '2030-03-17T18:30:00.000Z');
    await f.prep.drain();
    expect(f.batch().status).toBe('scheduled');
    const before = f.pub.head('converter-v2-test');
    const entry = structuredClone(store.entries.find((entry) => entry.name === 'Alpha')!);
    entry.revision = 'edited';
    entry.definitions.en!.revision = 'edited';
    if (kind === 'review') entry.definitions.en!.body = '11';
    f.change({ [`globals/entries/${entry.id}.json`]: entry });
    await f.prep.drain(true);
    expect(f.batch().status).toBe('needs_attention');
    expect(f.batch().preparedRequestId).toBeNull();
    expect(f.request().reasons?.[0].reason).toMatch(/global.*(review|changed)|Global.*changed/);
    expect(f.pub.head('converter-v2-test')).toBe(before);
    expect(f.batch().claim).toBeNull();
  });
  it('refuses claim-time drift without a claim or live write', async () => {
    const f = await fixture();
    const { store } = await withGlobals(f);
    f.admit('schedule');
    await f.prep.drain();
    const before = f.pub.head('converter-v2-test');
    const entry = structuredClone(store.entries[0]);
    entry.definitions.en!.body = '12';
    entry.revision = 'changed';
    f.change({ [`globals/entries/${entry.id}.json`]: entry });
    await f.pub.operation(R);
    expect(f.pub.head('converter-v2-test')).toBe(before);
    expect(f.batch().claim).toBeNull();
    expect(f.batch().status).toBe('needs_attention');
    expect(f.request().reasons?.[0].reason).toMatch(/global.*(review|changed)|Global.*changed/);
  });
});

describe('offline schedule preparation', () => {
  it('finishes a retried draft stage whose new member already landed', async () => {
    const f = await fixture();
    const next: Tooltip = {
      ...f.proposed,
      hash: 124,
      text: {
        ...f.proposed.text,
        de: {
          text: 'Langer Text. '.repeat(8400),
          updatedAt: AT,
          updatedBy: user.login,
          sourceUpdatedAt: f.proposed.text.en!.updatedAt,
        },
      },
    };
    const changes = [{ hash: next.hash, base: null, next }];
    f.admit('save', changes, user, DUE, S, { id: S, finish: false });
    await f.prep.drain();
    expect(f.request(S).status).toBe('completed');
    const memberPath = schedulePaths.member(B, next.hash);
    const landed = f.read(memberPath);
    expect(Buffer.byteLength(JSON.stringify(landed))).toBeGreaterThan(96 * 1024);
    expect(f.batch().draftStaging?.id).toBe(S);
    const previousRevision = f.batch().contentRevision;
    f.admit('save', changes, user, DUE, R, { id: S, finish: true });
    await f.prep.drain();
    expect(f.request(R).status).toBe('completed');
    expect(f.batch().draftStaging).toBeUndefined();
    expect(f.batch().contentRevision).toBe(previousRevision);
    expect(f.read(memberPath)).toEqual(landed);
  });

  async function stagedSchedule() {
    const f = await fixture();
    f.change({
      'tooltips/124.json': { ...f.base, hash: 124 },
      'live/tooltips/124.json': { ...f.base, hash: 124 },
      'live/pushed.json': {
        123: await publishableHash(f.base),
        124: await publishableHash({ ...f.base, hash: 124 }),
      },
      [schedulePaths.member(B, 124)]: {
        hash: 124,
        base: { ...f.base, hash: 124 },
        baseCommit: 'd'.repeat(40),
        proposed: { ...f.proposed, hash: 124 },
        updatedAt: AT,
        updatedBy: user.login,
      },
    });
    const due = '2030-03-17T19:00:00.000Z';
    f.admit('schedule', undefined, user, due);
    await f.prep.drain();
    const accepted = f.batch();
    expect(accepted.status).toBe('scheduled');
    const stage = {
      id: S,
      ownerId: user.id,
      revision: accepted.revision,
      parts: 2,
      ready: false,
      updatedAt: AT,
    };
    f.change({
      [scheduleIntentPaths.stagedSave(B)]: stage,
      ...Object.fromEntries(
        [123, 124].map((hash, part) => {
          const base = { ...f.proposed, hash };
          const next = {
            ...base,
            text: {
              ...base.text,
              fr: {
                text: 'Traduit',
                updatedAt: AT,
                updatedBy: user.login,
                sourceUpdatedAt: base.text.en!.updatedAt,
              },
            },
          };
          return [
            scheduleIntentPaths.stagedPart(B, S, part),
            {
              requestId: S,
              revision: accepted.revision,
              part,
              message: 'Stage translations',
              changes: [{ hash, base, next }],
            },
          ];
        }),
      ),
    });
    const sourceCommit = f.pub.head(f.options.dataBranch);
    const body = JSON.stringify({ requestId: S, revision: accepted.revision, finish: true });
    const intent: ScheduleIntent = {
      version: 1,
      kind: 'save',
      requestId: S,
      batchId: B,
      repo: f.options.repo,
      dataBranch: f.options.dataBranch,
      liveBranch: f.options.liveBranch,
      requester: user,
      expectedRevision: accepted.revision,
      contentRevision: accepted.contentRevision,
      sourceCommit,
      memberTreeOid: globalTreeOid(f.git.tree(sourceCommit), `schedule/batches/${B}/tooltips`),
      createdAt: AT,
      bodyDigest: createHash('sha256').update(body).digest('hex'),
      returnStatus: 'scheduled',
      onValidationFailure: 'keep_scheduled',
      scheduledParts: 2,
    };
    const payload = stableStringify(intent);
    const request: ScheduleRequest = {
      envelope: {
        payload,
        sig: sign(null, Buffer.from(payload), f.keys.privateKey).toString('base64'),
      },
      requestId: S,
      batchId: B,
      requesterId: user.id,
      admissionRevision: accepted.revision + 1,
      bodyDigest: intent.bodyDigest,
      status: 'pending',
      attempt: 1,
      updatedAt: AT,
    };
    f.change({
      [scheduleIntentPaths.stagedSave(B)]: { ...stage, ready: true },
      [scheduleIntentPaths.request(S)]: request,
    });
    const head = f.pub.head(f.options.dataBranch);
    const tree = f.git.tree(head);
    tree[scheduleIntentPaths.body(S)] = f.git.writeBlob(body);
    f.git.cas(D, head, f.git.commit(head, tree, 'Confirm staged save'));
    expect(f.batch()).toEqual(accepted);
    return { ...f, accepted, due };
  }

  it('applies every staged edit together before the old version is claimed', async () => {
    const f = await stagedSchedule();
    await f.prep.drain();
    expect(f.request(S)).toMatchObject({ status: 'completed' });
    expect(f.batch()).toMatchObject({ status: 'scheduled', opId: R, preparedRequestId: S });
    for (const hash of [123, 124])
      expect(
        f.read<{ proposed: Tooltip }>(schedulePaths.member(B, hash)).proposed.text.fr?.text,
      ).toBe('Traduit');
    expect(f.read(scheduleIntentPaths.stagedSave(B))).toBeUndefined();
    expect(f.read(scheduleIntentPaths.stagedPart(B, S, 0))).toBeUndefined();
    // The publisher still verifies the immutable source after the hot staging files are gone.
    f.clock.now = Date.parse(f.due);
    await f.pub.run();
    expect(f.batch().status).toBe('published');
    expect(f.read<Tooltip>('live/tooltips/124.json').text.fr?.text).toBe('Traduit');
  });

  it('lets a concurrent claim win the CAS without applying any staged edit', async () => {
    const f = await stagedSchedule();
    const cas = f.git.cas.bind(f.git);
    let raced = false;
    const spy = vi.spyOn(f.git, 'cas').mockImplementation((ref, head, next) => {
      if (
        !raced &&
        ref === D &&
        next &&
        f.pub.read<ScheduleRequest>(f.git.tree(next), scheduleIntentPaths.request(S))?.status ===
          'completed'
      ) {
        raced = true;
        f.change({
          [schedulePaths.batch(B)]: {
            ...f.accepted,
            revision: f.accepted.revision + 1,
            status: 'publishing',
            claim: { opId: R, claimedAt: AT },
          },
        });
        throw new RefRace('Claim won the race');
      }
      cas(ref, head, next);
    });
    try {
      await f.prep.drain();
    } finally {
      spy.mockRestore();
    }
    expect(raced).toBe(true);
    expect(f.batch().status).toBe('publishing');
    expect(f.request(S)).toMatchObject({
      status: 'failed',
      reasons: [{ reason: 'Batch published before these edits landed' }],
    });
    expect(
      f.read<{ proposed: Tooltip }>(schedulePaths.member(B, 123)).proposed.text.fr,
    ).toBeUndefined();
    expect(f.read(scheduleIntentPaths.stagedSave(B))).toBeUndefined();
  });

  it('publishes the old accepted batch when it comes due before staging can apply', async () => {
    const f = await stagedSchedule();
    f.clock.now = Date.parse(f.due);
    await f.pub.run();
    expect(f.batch().status).toBe('published');
    expect(f.request(S)).toMatchObject({
      status: 'failed',
      reasons: [{ reason: 'Batch published before these edits landed' }],
    });
    expect(f.read<Tooltip>('live/tooltips/123.json').text.fr).toBeUndefined();
    expect(f.read(scheduleIntentPaths.stagedPart(B, S, 1))).toBeUndefined();
  });

  it('retires staged edits after the accepted version has already published', async () => {
    const f = await stagedSchedule();
    f.clock.now = Date.parse(f.due);
    await f.pub.operation(R);
    expect(f.batch().status).toBe('published');
    expect(f.request(S).status).toBe('pending');
    await f.prep.drain();
    expect(f.request(S)).toMatchObject({
      status: 'failed',
      reasons: [{ reason: 'Batch published before these edits landed' }],
    });
    expect(f.read<Tooltip>('live/tooltips/124.json').text.fr).toBeUndefined();
    expect(f.read(scheduleIntentPaths.stagedSave(B))).toBeUndefined();
  });

  it('prepares before publishing, and produces one receipt and real seven-file exporter parity', async () => {
    const f = await fixture();
    f.admit('schedule');
    expect(f.read(paths(R).request)).toBeUndefined();
    await f.prep.drain();
    expect(f.request().reasons).toEqual([]);
    expect(f.batch().preparedRequestId).toBe(R);
    expect(f.request().status).toBe('completed');
    const prepared = f.pub.head('editor-data');
    await f.prep.drain();
    expect(f.pub.head('editor-data')).toBe(prepared);
    await f.pub.run();
    await f.pub.run();
    expect(f.batch().status).toBe('published');
    expect(f.git.additions(f.pub.head('converter-v2-test'), paths(R).receipt)).toHaveLength(1);
    const receipt = f.pub.receipt(f.pub.head('converter-v2-test'), R)!;
    const expected = exportLegacy([f.proposed], receipt.now, f.options.facts, {});
    expect(receipt.exported).toEqual(expected);
    stampUploads(expected, new Set([123]), {}, receipt.now, 'alice');
    const live = f.pub.read<{ perks: Record<string, unknown>; databaseSettings: object }>(
      f.git.tree(f.pub.head('converter-v2-test')),
      'liveDescriptions.json',
    )!;
    for (const preset of deployedLegacyPresets) {
      const expectedLive = { ...live, perks: { ...live.perks, ...expected } };
      expect(buildLegacy(live as LegacyInput, preset)).toEqual(
        buildLegacy(expectedLive as LegacyInput, preset),
      );
    }
    expect(f.read<{ entries: unknown[] }>('schedule/due.json').entries).toEqual([]);
  });
  it('never publishes before notBefore, even when fully prepared', async () => {
    const f = await fixture();
    f.admit('schedule', undefined, user, '2030-03-17T19:00:00.000Z');
    await f.pub.run();
    expect(f.batch().status).toBe('scheduled');
    expect(f.pub.receipt(f.pub.head('converter-v2-test'), R)).toBeUndefined();
    await f.pub.operation(R);
    expect(f.batch().status).toBe('scheduled');
  });
  it.each(['body', 'signature', 'outer', 'source', 'target'])(
    'refuses %s tampering without publishing',
    async (what) => {
      const f = await fixture();
      const request = f.admit('schedule');
      if (what === 'body') f.change({ [scheduleIntentPaths.body(R)]: { changed: true } });
      if (what === 'signature')
        f.change({
          [scheduleIntentPaths.request(R)]: {
            ...request,
            envelope: { ...request.envelope, sig: 'A'.repeat(86) + '==' },
          },
        });
      if (what === 'outer')
        f.change({ [scheduleIntentPaths.request(R)]: { ...request, requesterId: 2 } });
      if (what === 'source' || what === 'target') {
        // Validly formatted but unsigned alteration.
        const intent = JSON.parse(request.envelope.payload);
        if (what === 'source') intent.memberTreeOid = 'f'.repeat(40);
        else intent.liveBranch = 'main';
        f.change({
          [scheduleIntentPaths.request(R)]: {
            ...request,
            envelope: { ...request.envelope, payload: stableStringify(intent) },
          },
        });
      }
      await f.prep.drain();
      expect(f.batch().status).toBe('needs_attention');
      expect(f.read(paths(R).request)).toBeUndefined();
      expect(f.read<{ entries: unknown[] }>('schedule/due.json').entries).toEqual([]);
    },
  );
  it('rechecks scheduling role and permission loss at claim', async () => {
    const f = await fixture();
    f.admit('schedule');
    await f.prep.drain();
    f.change({ 'config/permissions.json': { users: {} } });
    await f.pub.run();
    expect(f.pub.receipt(f.pub.head('converter-v2-test'), R)).toBeUndefined();
  });
  it('rejects publication-ID collisions at the materialization head', async () => {
    const f = await fixture();
    f.admit('schedule');
    f.change({ [paths(R).log]: { terminal: true } });
    await f.prep.drain();
    expect(f.batch().status).toBe('needs_attention');
    expect(f.read(paths(R).log)).toEqual({ terminal: true });
  });
  it('keeps accepted members intact on invalid editor saves, removes due, and retains submitted bytes', async () => {
    const f = await fixture();
    f.admit('schedule');
    await f.prep.drain();
    const stored = f.read(schedulePaths.member(B, 123));
    f.admit('save', [{ hash: 123, base: f.proposed, next: tip('forbidden English edit') }]);
    await f.prep.drain();
    expect(f.batch().status).toBe('needs_attention');
    expect(f.request(S).status).toBe('needs_attention');
    expect(f.read(schedulePaths.member(B, 123))).toEqual(stored);
    expect(f.read(paths(R).request)).toBeUndefined();
    expect(f.read<{ entries: unknown[] }>('schedule/due.json').entries).toEqual([]);
  });
  it('restores the exact accepted schedule after a rejected translator proposal and drains it in the same run', async () => {
    const f = await fixture();
    f.admit('schedule');
    await f.prep.drain();
    const original = f.read(paths(R).request),
      stored = f.read(schedulePaths.member(B, 123));
    f.admit('save', [{ hash: 123, base: f.proposed, next: tip('translator changed English') }], {
      id: 2,
      login: 'bob',
    });
    await f.prep.drain();
    expect(f.batch().status).toBe('scheduled');
    expect(f.batch().preparedRequestId).toBe(R);
    expect(f.request(S).status).toBe('failed');
    expect(f.request(S).result).toBeUndefined();
    expect(f.read(paths(R).request)).toEqual(original);
    expect(f.read(schedulePaths.member(B, 123))).toEqual(stored);
    await f.pub.run();
    expect(f.batch().status).toBe('published');
  });
  it('materializes a valid scheduled translation save and rechecks language loss at claim', async () => {
    const f = await fixture();
    f.admit('schedule');
    await f.prep.drain();
    const next = structuredClone(f.proposed);
    next.text.fr = {
      text: 'traduit',
      updatedAt: AT,
      updatedBy: 'bob',
      sourceUpdatedAt: next.text.en!.updatedAt,
    };
    f.admit('save', [{ hash: 123, base: f.proposed, next }], { id: 2, login: 'bob' });
    await f.prep.drain();
    expect(f.request(S).status).toBe('completed');
    expect(f.batch().preparedRequestId).toBe(S);
    f.change({
      'config/permissions.json': {
        users: {
          1: { login: 'alice', role: 'editor' },
          2: { login: 'bob', role: 'translator', languages: ['de'] },
        },
      },
    });
    await f.pub.run();
    expect(f.pub.receipt(f.pub.head('converter-v2-test'), R)).toBeUndefined();
  });
  it('keeps a real converter rejection of a translator proposal FAILED and restores accepted publication', async () => {
    const f = await fixture();
    f.admit('schedule');
    await f.prep.drain();
    const original = f.read(paths(R).request),
      stored = f.read(schedulePaths.member(B, 123));
    const next = structuredClone(f.proposed);
    next.text.fr = {
      text: 'import main from 124',
      updatedAt: AT,
      updatedBy: 'bob',
      sourceUpdatedAt: next.text.en!.updatedAt,
    };
    f.admit('save', [{ hash: 123, base: f.proposed, next }], { id: 2, login: 'bob' });
    await f.prep.drain();
    expect(f.request(S).status).toBe('failed');
    expect(f.request(S).retryable).toBe(false);
    expect(f.request(S).result).toBeUndefined();
    expect(f.batch().status).toBe('scheduled');
    expect(f.read(paths(R).request)).toEqual(original);
    expect(f.read(schedulePaths.member(B, 123))).toEqual(stored);
    await f.pub.run();
    expect(f.batch().status).toBe('published');
  });
  it('records converter content rejection of a schedule as non-retryable', async () => {
    const f = await fixture();
    const member = f.read<{ proposed: Tooltip }>(schedulePaths.member(B, 123));
    member.proposed.text.fr = {
      text: 'import main from 124',
      updatedAt: AT,
      updatedBy: 'alice',
      sourceUpdatedAt: member.proposed.text.en!.updatedAt,
    };
    f.change({ [schedulePaths.member(B, 123)]: member });
    f.admit('schedule');
    await f.prep.drain();
    expect(f.request().status).toBe('needs_attention');
    expect(f.request().retryable).toBe(false);
  });
  it('restores the accepted schedule when a translator proposal has native enhanced markup', async () => {
    const f = await fixture();
    f.admit('schedule');
    await f.prep.drain();
    const original = f.read(paths(R).request),
      stored = f.read(schedulePaths.member(B, 123));
    const next = structuredClone(f.proposed);
    next.text.fr = {
      text: '{{invalid native enhanced}}',
      updatedAt: AT,
      updatedBy: 'bob',
      sourceUpdatedAt: next.text.en!.updatedAt,
    };
    f.admit('save', [{ hash: 123, base: f.proposed, next }], { id: 2, login: 'bob' });
    await f.prep.drain();
    expect(f.request(S).status).toBe('failed');
    expect(f.request(S).retryable).toBe(false);
    expect(f.request(S).reasons?.[0].reason).toContain('Base/enhanced markup');
    expect(f.read(paths(R).request)).toEqual(original);
    expect(f.read(schedulePaths.member(B, 123))).toEqual(stored);
    expect(f.batch().preparedRequestId).toBe(R);
    expect(f.read<{ entries: { opId: string }[] }>('schedule/due.json').entries[0].opId).toBe(R);
    await f.pub.run();
    expect(f.batch().status).toBe('published');
  });
  it('keeps missing generator facts separate from a rejected translator proposal', async () => {
    const f = await fixture();
    f.admit('schedule');
    await f.prep.drain();
    f.admit('save', [{ hash: 123, base: f.proposed, next: f.proposed }], { id: 2, login: 'bob' });
    f.options.facts = {};
    await f.prep.drain();
    expect(f.request(S).status).toBe('needs_attention');
    expect(f.request(S).retryable).toBe(true);
    expect(f.request(S).result).toBeUndefined();
    expect(f.request(S).reasons?.[0].reason).toBe('Missing generator facts');
    expect(f.read(paths(R).request)).toBeUndefined();
  });
  it('matrix 3: a valid translation with corrupt inactive configuration stays retryable', async () => {
    const f = await fixture();
    f.admit('schedule');
    await f.prep.drain();
    const stored = f.read(schedulePaths.member(B, 123));
    const next = structuredClone(f.proposed);
    next.text.fr = {
      text: 'traduction valide',
      updatedAt: AT,
      updatedBy: 'bob',
      sourceUpdatedAt: next.text.en!.updatedAt,
    };
    f.admit('save', [{ hash: 123, base: f.proposed, next }], { id: 2, login: 'bob' });
    f.change({ 'config/inactive.json': [] });
    await f.prep.drain();
    expect(f.request(S).status).toBe('needs_attention');
    expect(f.request(S).retryable).toBe(true);
    expect(f.request(S).result).toBeUndefined();
    expect(f.read(schedulePaths.member(B, 123))).toEqual(stored);
    expect(f.read(paths(R).request)).toBeUndefined();
    expect(f.read<{ entries: unknown[] }>('schedule/due.json').entries).toHaveLength(0);
  });
  it.each(['merge', 'aliases', 'git', 'before'] as const)(
    'matrix 4: %s faults are infrastructure, not a FAILED translator proposal',
    async (fault) => {
      const f = await fixture();
      f.admit('schedule');
      await f.prep.drain();
      const next = structuredClone(f.proposed);
      next.text.fr = {
        text: 'traduction valide',
        updatedAt: AT,
        updatedBy: 'bob',
        sourceUpdatedAt: next.text.en!.updatedAt,
      };
      f.admit('save', [{ hash: 123, base: f.proposed, next }], { id: 2, login: 'bob' });
      if (fault === 'aliases') f.change({ 'config/sandbox-pointers.json': { invalid: true } });
      if (fault === 'merge')
        vi.spyOn(f.pub, 'pickRecomputeAt').mockImplementation(() => {
          throw new Error('Merge input unavailable');
        });
      if (fault === 'git') {
        const liveOid = f.git.tree(f.pub.head('converter-v2-test'))['liveDescriptions.json'];
        const blob = f.git.blob.bind(f.git);
        vi.spyOn(f.git, 'blob').mockImplementation((oid) => {
          if (oid === liveOid) throw new Error('Live blob unavailable');
          return blob(oid);
        });
      }
      if (fault === 'before') {
        const head = f.pub.head('converter-v2-test'),
          tree = f.git.tree(head);
        tree['liveDescriptions.json'] = f.git.writeBlob(json({ perks: {}, databaseSettings: {} }));
        f.git.cas(
          L,
          head,
          f.git.commit(head, tree, 'Missing canonical reserved globals in existing live'),
        );
      }
      await f.prep.drain();
      expect(f.request(S).status).toBe('needs_attention');
      expect(f.request(S).retryable).toBe(true);
      expect(f.request(S).result).toBeUndefined();
      expect(f.read(paths(R).request)).toBeUndefined();
      expect(f.read<{ entries: unknown[] }>('schedule/due.json').entries).toHaveLength(0);
    },
  );
  it.each(['member', 'digest', 'conflict', 'pushed', 'stale'] as const)(
    'matrix 7: %s validation keeps the existing default',
    async (fault) => {
      const f = await fixture();
      f.admit('schedule');
      if (fault === 'member') f.change({ [schedulePaths.member(B, 123)]: { invalid: true } });
      if (fault === 'digest') {
        const m = f.read<{ proposed: Tooltip }>(schedulePaths.member(B, 123));
        f.change({
          [schedulePaths.member(B, 123)]: { ...m, proposed: tip('changed after signed source') },
        });
      }
      if (fault === 'conflict') f.change({ [schedulePaths.conflict(123)]: {} });
      if (fault === 'pushed') f.change({ 'live/pushed.json': { 123: 'invalid digest' } });
      if (fault === 'stale') f.change({ 'tooltips/123.json': tip('concurrent saved English') });
      await f.prep.drain();
      expect(f.request().status).toBe('needs_attention');
      expect(f.request().retryable).toBe(false);
      expect(f.request().result).toBeUndefined();
      expect(f.read(paths(R).request)).toBeUndefined();
    },
  );
  it.each(['editor', 'maintainer'] as const)(
    'matrix: %s content refusals keep needs_attention with reasons',
    async (role) => {
      const f = await fixture();
      f.admit('schedule');
      await f.prep.drain();
      f.change({ 'config/permissions.json': { users: { 1: { login: 'alice', role } } } });
      const next = structuredClone(f.proposed);
      next.text.fr = {
        text: '{{invalid native enhanced}}',
        updatedAt: AT,
        updatedBy: 'alice',
        sourceUpdatedAt: next.text.en!.updatedAt,
      };
      f.admit('save', [{ hash: 123, base: f.proposed, next }]);
      await f.prep.drain();
      expect(f.request(S).status).toBe('needs_attention');
      expect(f.request(S).reasons?.[0].reason).toContain('Base/enhanced');
      expect(f.read(paths(R).request)).toBeUndefined();
      expect(f.read<{ entries: unknown[] }>('schedule/due.json').entries).toHaveLength(0);
    },
  );
  it.each(['revoked', 'collision', 'withdrawn'])(
    'isolates a failed translator restoration (%s) and commits its reasons',
    async (fault) => {
      const f = await fixture();
      f.admit('schedule');
      await f.prep.drain();
      f.admit('save', [{ hash: 123, base: f.proposed, next: tip('invalid translator English') }], {
        id: 2,
        login: 'bob',
      });
      if (fault === 'revoked')
        f.change({
          'config/permissions.json': {
            users: { 2: { login: 'bob', role: 'translator', languages: ['fr'] } },
          },
        });
      else if (fault === 'collision') f.change({ [paths(R).log]: { terminal: true } });
      else f.change({ [scheduleIntentPaths.publication(B)]: { invalid: true } });
      await expect(f.prep.drain()).resolves.toBeUndefined();
      expect(f.request(S).status).toBe('needs_attention');
      expect(f.request(S).reasons?.some((r) => r.reason.includes('could not be restored'))).toBe(
        true,
      );
      expect(f.batch().claim).toBeNull();
      expect(f.read<{ entries: unknown[] }>('schedule/due.json').entries).toHaveLength(0);
      await expect(f.pub.run()).resolves.toBeUndefined();
    },
  );
  it('commits failure and refreshes index after rejecting a malformed accepted member', async () => {
    const f = await fixture();
    f.admit('schedule');
    f.change({ [schedulePaths.member(B, 123)]: { invalid: true } });
    await f.prep.drain();
    expect(f.request().status).toBe('needs_attention');
    expect(f.batch().status).toBe('needs_attention');
    expect(f.read<{ entries: unknown[] }>('schedule/due.json').entries).toHaveLength(0);
    expect(
      f.read<{ batches: { hashes: number[] }[] }>('schedule/index.json').batches[0].hashes,
    ).toEqual([123]);
  });
  it('repairs malformed due metadata from accepted and preparing batch states in the output CAS', async () => {
    const f = await fixture();
    f.admit('schedule');
    const head = f.pub.head('editor-data'),
      tree = f.git.tree(head);
    tree['schedule/due.json'] = f.git.writeBlob('{');
    f.git.cas(D, head, f.git.commit(head, tree, 'malformed due trigger'));
    await f.prep.drain();
    expect(f.request().status).toBe('completed');
    expect(f.read<{ entries: { opId: string }[] }>('schedule/due.json').entries[0].opId).toBe(R);
  });
  it('does not report a corrupt PIN or repository snapshot as a rejected translator proposal', async () => {
    const f = await fixture();
    f.admit('schedule');
    await f.prep.drain();
    f.admit('save', [{ hash: 123, base: f.proposed, next: f.proposed }], { id: 2, login: 'bob' });
    f.change({ '.publisher/PIN': { invalid: true } });
    await f.prep.drain();
    expect(f.request(S).status).toBe('needs_attention');
    expect(f.request(S).result).toBeUndefined();
  });
  it('reconciles an acknowledged-late CAS without applying twice', async () => {
    const f = await fixture();
    f.admit('schedule');
    const cas = f.git.cas.bind(f.git);
    let once = true;
    vi.spyOn(f.git, 'cas').mockImplementation((ref, old, next) => {
      cas(ref, old, next);
      if (ref === D && once) {
        once = false;
        throw new Error('connection lost');
      }
    });
    await f.prep.drain();
    await f.prep.drain();
    expect(f.batch().events.filter((e) => e.action === 'prepared')).toHaveLength(1);
  });
  it('a cancellation winning the CAS prevents late materialization or restoration', async () => {
    const f = await fixture();
    f.admit('schedule');
    const cas = f.git.cas.bind(f.git);
    let once = true;
    vi.spyOn(f.git, 'cas').mockImplementation((ref, old, next) => {
      if (ref === D && once) {
        once = false;
        f.change({
          [schedulePaths.batch(B)]: {
            ...f.batch(),
            revision: f.batch().revision + 1,
            status: 'cancelled',
            preparation: null,
            opId: null,
            notBefore: null,
            zone: null,
            scheduledContentRevision: null,
          },
          [scheduleIntentPaths.request(R)]: { ...f.request(), status: 'cancelled' },
          'schedule/due.json': { entries: [] },
        });
        throw new RefRace('cancel won');
      }
      cas(ref, old, next);
    });
    await f.prep.drain();
    expect(f.batch().status).toBe('cancelled');
    expect(f.read(paths(R).request)).toBeUndefined();
  });
  it('does not tombstone or remove due for a stray old publication while preparing', async () => {
    const f = await fixture();
    f.admit('schedule');
    await f.prep.drain();
    const old = f.read(paths(R).request);
    f.admit('save', [{ hash: 123, base: f.proposed, next: f.proposed }]);
    f.change({ [paths(R).request]: old });
    await f.pub.operation(R);
    expect(f.read(paths(R).log)).toBeUndefined();
    expect(f.read<{ entries: unknown[] }>('schedule/due.json').entries).toHaveLength(1);
  });
  it('refreshes the advisory index after Worker-only cancellation, including an initially missing index', async () => {
    const f = await fixture();
    f.change({ [schedulePaths.batch(B)]: { ...f.batch(), status: 'cancelled', revision: 2 } }, [
      schedulePaths.index,
    ]);
    await f.prep.drain();
    expect(f.read<{ batches: Batch[] }>(schedulePaths.index).batches[0].status).toBe('cancelled');
  });
  it('materializes a draft save with matching content revisions and archived events', async () => {
    const f = await fixture();
    const next = structuredClone(f.proposed);
    next.text.en = { text: 'newer correction', updatedAt: AT, updatedBy: 'alice' };
    const events = Array.from({ length: 20 }, () => ({
      at: AT,
      by: user,
      action: 'save',
      revision: 1,
      contentRevision: 1,
    }));
    f.change({ [schedulePaths.batch(B)]: { ...f.batch(), events } });
    f.admit('save', [{ hash: 123, base: f.proposed, next }]);
    const cas = vi.spyOn(f.git, 'cas');
    await f.prep.drain();
    expect(cas).toHaveBeenCalledTimes(1);
    expect(f.batch().status).toBe('draft');
    expect(f.batch().contentRevision).toBe(2);
    expect(f.batch().events.at(-1)?.contentRevision).toBe(2);
    expect(f.batch().events).toHaveLength(20);
    expect(f.read(`schedule/batches/${B}/events/00000000.json`)).toBeDefined();
    expect(f.request(S).result?.status).toBe('draft');
    expect(f.read(paths(S).request)).toBeUndefined();
  });
  it('rejects duplicate save hashes without applying the first edit', async () => {
    const f = await fixture();
    const change = { hash: 123, base: f.proposed, next: f.proposed };
    f.admit('save', [change, change]);
    await f.prep.drain();
    expect(f.request(S).status).toBe('needs_attention');
    expect(f.batch().contentRevision).toBe(1);
  });
  it('rejects duplicate membership even if the advisory index is stale', async () => {
    const f = await fixture();
    const other = '01K95H000000000000000000B2';
    f.change({
      [schedulePaths.batch(other)]: { ...f.batch(), id: other },
      [schedulePaths.member(other, 123)]: f.read(schedulePaths.member(B, 123)),
    });
    f.admit('schedule');
    await f.prep.drain();
    expect(f.request().reasons?.[0].reason).toContain('already belongs');
  });
  it('keeps an infrastructure failure retryable and never restores or confirms a translator proposal', async () => {
    const f = await fixture();
    f.admit('schedule');
    await f.prep.drain();
    f.admit('save', [{ hash: 123, base: f.proposed, next: f.proposed }], { id: 2, login: 'bob' });
    vi.spyOn(f.prep, 'validateSave').mockImplementation(() => {
      throw new Error('runner validation unavailable');
    });
    await f.prep.drain();
    expect(f.request(S).status).toBe('needs_attention');
    expect(f.request(S).retryable).toBe(true);
    expect(f.request(S).result).toBeUndefined();
    expect(f.read(paths(R).request)).toBeUndefined();
    expect(f.read<{ entries: unknown[] }>('schedule/due.json').entries).toHaveLength(0);
  });
  it('a newer Retry attempt fences off an old preparation and still prepares once', async () => {
    const f = await fixture();
    f.admit('schedule');
    const cas = f.git.cas.bind(f.git);
    let once = true;
    vi.spyOn(f.git, 'cas').mockImplementation((ref, old, next) => {
      if (ref === D && once) {
        once = false;
        const batch = f.batch(),
          request = f.request();
        f.change({
          [schedulePaths.batch(B)]: {
            ...batch,
            revision: batch.revision + 1,
            preparation: { ...batch.preparation, attempt: 2 },
          },
          [scheduleIntentPaths.request(R)]: {
            ...request,
            attempt: 2,
            admissionRevision: batch.revision + 1,
          },
        });
        throw new RefRace('retry won');
      }
      cas(ref, old, next);
    });
    await f.prep.drain();
    expect(f.request().attempt).toBe(2);
    expect(f.request().status).toBe('completed');
    expect(f.batch().events.filter((e) => e.action === 'prepared')).toHaveLength(1);
  });
  it('leaves requests pending after three real ref races, and recovers on a later kick', async () => {
    const f = await fixture();
    f.admit('schedule');
    const cas = f.git.cas.bind(f.git);
    let races = 0;
    // The fixture writes must bypass the injected race, which models a separate writer.
    const spy = vi.spyOn(f.git, 'cas').mockImplementation((ref, old, next) => {
      if (ref === D && races < 3) {
        races++;
        const tree = f.git.tree(old!);
        tree[`unrelated/${races}.json`] = f.git.writeBlob(json(races));
        cas(D, old, f.git.commit(old, tree, 'concurrent save'));
        throw new RefRace('concurrent save');
      }
      cas(ref, old, next);
    });
    await expect(f.prep.drain()).rejects.toThrow('CAS exhausted');
    expect(f.request().status).toBe('pending');
    expect(f.read(paths(R).request)).toBeUndefined();
    spy.mockRestore();
    await f.prep.drain();
    expect(f.request().status).toBe('completed');
  });
  it.each(['manifest', 'ready', 'members'])('rejects a tampered %s at claim', async (what) => {
    const f = await fixture();
    f.admit('schedule');
    await f.prep.drain();
    if (what === 'manifest') {
      const e = f.read<{ payload: string }>(paths(R).request),
        p = JSON.parse(e.payload);
      p.notBefore = '2030-03-17T17:00:00.000Z';
      f.change({ [paths(R).request]: { ...e, payload: stableStringify(p) } });
    } else if (what === 'ready')
      f.change({ [schedulePaths.batch(B)]: { ...f.batch(), preparedRequestId: S } });
    else {
      const m = f.read<{ proposed: Tooltip }>(schedulePaths.member(B, 123));
      f.change({ [schedulePaths.member(B, 123)]: { ...m, proposed: tip('tampered approval') } });
    }
    await f.pub.run();
    expect(f.pub.receipt(f.pub.head('converter-v2-test'), R)).toBeUndefined();
  });
  it('rejects an installed runtime without preparation capability', async () => {
    const f = await fixture();
    f.admit('schedule');
    f.change({
      '.publisher/PIN': {
        sourceSha: f.options.publisherSha,
        sha256: f.options.publisherDigest,
        capabilities: ['scheduledBatches'],
      },
    });
    await f.prep.drain();
    expect(f.request().retryable).toBe(false);
    expect(f.request().reasons?.[0].reason).toContain('PIN');
  });
  it('fails closed for unsupported PIN and globals publication', async () => {
    const f = await fixture();
    f.admit('schedule');
    f.change({ 'globals/layout.json': {} });
    await f.prep.drain();
    expect(f.batch().status).toBe('needs_attention');
    expect(f.request().reasons?.[0].reason).toBe(
      'The installed publisher does not support scheduled globals yet',
    );
    expect(f.batch().claim).toBeNull();
    expect(f.read(paths(R).request)).toBeUndefined();
  });
  it('uses real Git tree identities and resumes a crash after preparation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'schedule-preparation-'));
    try {
      execFileSync('git', ['init', '--bare', root], { stdio: 'pipe' });
      execFileSync('git', ['--git-dir', root, 'config', 'publisher.simulator', 'true']);
      const git = new LocalRepository(root),
        f = await fixture(git);
      f.admit('schedule');
      const source = JSON.parse(f.request().envelope.payload) as ScheduleIntent;
      expect(source.memberTreeOid).toBe(
        git.git(['rev-parse', `${source.sourceCommit}:schedule/batches/${B}/tooltips`]).trim(),
      );
      await f.prep.drain();
      await f.pub.run();
      expect(f.batch().status).toBe('published');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
  it.each(['before', 'after'])(
    'leaves the deployed %s index byte-identical with no intents in real Git',
    async (version) => {
      const root = mkdtempSync(join(tmpdir(), 'schedule-idle-'));
      try {
        execFileSync('git', ['init', '--bare', root], { stdio: 'pipe' });
        execFileSync('git', ['--git-dir', root, 'config', 'publisher.simulator', 'true']);
        const git = new LocalRepository(root),
          f = await fixture(git);
        const draft = f.batch(),
          member = f.read(schedulePaths.member(B, 123));
        const index = JSON.parse(
          readFileSync(`scripts/schedule-prepare/fixtures/index-${version}.json`, 'utf8'),
        );
        const files: Record<string, unknown> = { [schedulePaths.index]: index };
        for (const entry of index.batches) {
          files[schedulePaths.batch(entry.id)] = JSON.parse(
            readFileSync(`scripts/schedule-prepare/fixtures/${entry.id}.json`, 'utf8'),
          );
          for (const hash of entry.hashes) files[schedulePaths.member(entry.id, hash)] = {};
        }
        f.change(files, [schedulePaths.batch(B), schedulePaths.member(B, 123)]);
        const head = git.head(D),
          blob = git.tree(head!)[schedulePaths.index];
        const commit = vi.spyOn(git, 'commit');
        await f.prep.drain();
        await f.prep.drain();
        expect(commit).not.toHaveBeenCalled();
        expect(git.head(D)).toBe(head);
        expect(git.tree(head!)[schedulePaths.index]).toBe(blob);
        const canonical = withIndexEntry(index, index.batches[0]);
        expect(canonical.batches.map((entry) => entry.id)).toEqual(
          index.batches.map((entry: { id: string }) => entry.id).sort(),
        );
        f.change({ [schedulePaths.index]: canonical });
        commit.mockClear();
        await f.prep.drain();
        expect(commit).not.toHaveBeenCalled();
        // A real new intent still materializes and refreshes the advisory index.
        f.change({ [schedulePaths.batch(B)]: draft, [schedulePaths.member(B, 123)]: member });
        f.admit('schedule');
        await f.prep.drain();
        expect(f.request().status).toBe('completed');
        expect(
          f.read<{ batches: { id: string; status: string }[] }>(schedulePaths.index).batches,
        ).toContainEqual(expect.objectContaining({ id: B, status: 'scheduled' }));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    300_000,
  );
  it('dry-run pipeline bundles only real source heads, while preparing and publishing in its artifact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'schedule-pipeline-'));
    try {
      const remote = join(root, 'origin.git'),
        checkout = join(root, 'checkout'),
        out = join(root, 'out');
      execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
      execFileSync('git', ['--git-dir', remote, 'config', 'publisher.simulator', 'true']);
      const git = new LocalRepository(remote),
        f = await fixture(git, 'Database-Clarity/Live-Clarity-Database');
      f.admit('schedule');
      const before = f.pub.head('editor-data'),
        live = f.pub.head('converter-v2-test');
      execFileSync('git', ['clone', '--no-checkout', remote, checkout], { stdio: 'pipe' });
      vi.spyOn(Date, 'now').mockReturnValue(NOW);
      vi.stubGlobal('fetch', async () =>
        Response.json({
          algorithm: 'Ed25519',
          publicKey: f.options.publicKey,
          fingerprint: f.options.keyFingerprint,
        }),
      );
      await runPipeline(
        checkout,
        { ...f.options, keyEndpoint: 'https://worker.test/publish/key' },
        out,
      );
      expect(f.pub.head('editor-data')).toBe(before);
      expect(f.pub.head('converter-v2-test')).toBe(live);
      const bundle = f.pub.read<{ sourceCommit: string }>(
        git.tree(git.head('refs/heads/editor-data-bundle')!),
        'bundle.json',
      )!;
      expect(bundle.sourceCommit).toBe(before);
      expect(JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')).error).toBeNull();
      expect(
        JSON.parse(readFileSync(join(out, 'would-be-commits.json'), 'utf8')).commits,
      ).toBeGreaterThan(0);
      execFileSync(
        'git',
        [
          '-C',
          checkout,
          'fetch',
          join(out, 'would-be-commits.bundle'),
          'refs/heads/editor-data:refs/simulation/data',
        ],
        { stdio: 'pipe' },
      );
      const simulated = JSON.parse(
        execFileSync(
          'git',
          ['-C', checkout, 'show', `refs/simulation/data:${schedulePaths.batch(B)}`],
          { encoding: 'utf8' },
        ),
      );
      expect(simulated.status).toBe('published');
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
});
