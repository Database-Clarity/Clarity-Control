import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  exportLegacy,
  globalsInPlaceCapability,
  publishableHash,
  type Tooltip,
} from '@clarity/core';
import {
  buildLegacy,
  deployedLegacyPresets,
  type LegacyInput,
} from '../../../packages/export/src/legacy.js';
import {
  batchSchema,
  canClaimPreparedBatch,
  scheduleIntentPaths,
  schedulePaths,
  scheduleRequestSchema,
  type Batch,
  type ScheduleRequest,
  type BatchMember,
} from '@clarity/core/schedule';
import publisherConfig from '../../../config/publisher.json';
import scheduledConfig from '../../../config/scheduled.json';
import { Publisher, paths, type Options } from '../../../scripts/publisher/publisher.js';
import { activateGlobalsFixture } from '../../../scripts/publisher/testGlobals.js';
import { SchedulePreparer } from '../../../scripts/schedule-prepare/prepare.js';
import { globalTreeOid } from '../../../scripts/publisher/globals.js';
import { RefRace, type Repository, type Tree } from '../../../scripts/publisher/git.js';
import { json } from '../../../scripts/publisher/batch.js';
import { GitHub } from '../src/github.js';
import { switches } from '../src/schedule/store.js';
import { Fixture, config, makePrivateKey, sha, tooltip } from './fixture.js';
import { stampUploads } from '../src/stamp.js';

const B = '01K95H000000000000000000B1';
const D = 'refs/heads/editor-data';
const L = 'refs/heads/converter-v2-test';
const keys = generateKeyPairSync('ed25519');
const batchPath = schedulePaths.batch(B);
const memberPath = schedulePaths.member(B, 123);

/** Bridge the Worker's HTTP fixture to the Action repository interface. Only transport is
 * simulated: admission, signature/source verification, validation, export, and claim run real code.
 * Capture exact tree-write bytes, since the older HTTP fixture stores parsed JSON snapshots.
 */
class ActionRepository implements Repository {
  blobs = new Map<string, string>();
  refs = new Map<string, string>();
  bytes = new Map<string, string>();
  constructor(readonly f: Fixture) {}
  head(ref: string) {
    return ref === D ? this.f.dataHead : this.refs.get(ref);
  }
  commitParents(commit: string) {
    return this.f.commitParents.get(commit) ?? [];
  }
  writeBlob(bytes: string) {
    const oid = createHash('sha1')
      .update(`blob ${Buffer.byteLength(bytes)}\0${bytes}`)
      .digest('hex');
    this.blobs.set(oid, bytes);
    return oid;
  }
  blob(oid: string) {
    const bytes = this.blobs.get(oid);
    if (bytes === undefined) throw new Error(`Missing fixture blob ${oid}`);
    return bytes;
  }
  tree(commit: string): Tree {
    const snapshot = this.f.snapshots.get(commit);
    if (!snapshot) throw new Error(`Missing fixture commit ${commit}`);
    return Object.fromEntries(
      Object.entries(snapshot).map(([path, value]) => [
        path,
        this.writeBlob(this.bytes.get(path + JSON.stringify(value)) ?? json(value)),
      ]),
    );
  }
  commit(parent: string | undefined, tree: Tree) {
    const id = sha(this.f.sequence++);
    const snapshot = Object.fromEntries(
      Object.entries(tree).map(([path, oid]) => {
        const bytes = this.blob(oid),
          value: unknown = JSON.parse(bytes);
        this.bytes.set(path + JSON.stringify(value), bytes);
        return [path, value];
      }),
    );
    this.f.snapshots.set(id, snapshot);
    this.f.commitParents.set(id, parent ? [parent] : []);
    return id;
  }
  cas(ref: string, old: string | undefined, next: string | undefined) {
    if (this.head(ref) !== old) throw new RefRace('Fixture ref moved');
    if (ref === D) this.f.dataHead = next!;
    else if (next) this.refs.set(ref, next);
    else this.refs.delete(ref);
  }
  casMany(updates: { ref: string; old: string; next: string }[]) {
    if (updates.some(({ ref, old }) => this.head(ref) !== old))
      throw new RefRace('Fixture refs moved');
    for (const { ref, old, next } of updates) this.cas(ref, old, next);
  }
  history(ref: string) {
    const result: string[] = [];
    let h = this.f.snapshots.has(ref) ? ref : this.head(ref);
    while (h) {
      result.unshift(h);
      h = this.f.commitParents.get(h)?.[0];
    }
    return result;
  }
  ancestor(a: string, b: string) {
    let h: string | undefined = b;
    while (h) {
      if (h === a) return true;
      h = this.f.commitParents.get(h)?.[0];
    }
    return false;
  }
  additions(head: string, prefix: string) {
    const result: { commit: string; path: string }[] = [];
    let h: string | undefined = head;
    while (h) {
      const parent: string | undefined = this.f.commitParents.get(h)?.[0];
      const before = parent ? this.tree(parent) : {};
      for (const path of Object.keys(this.tree(h)))
        if (path.startsWith(prefix) && !before[path]) result.unshift({ commit: h, path });
      h = parent;
    }
    return result;
  }
}

let appKey: string;
let f: Fixture, git: ActionRepository, pub: Publisher, prep: SchedulePreparer;
// Resolve web modules at runtime: the Worker typecheck has no JSX/DOM build configuration.
const webApiPath = '../../web/src/services/scheduled/api';
const webAuthPath = '../../web/src/stores/auth';
const webModelPath = '../../web/src/features/review/batches/model';
interface Admission {
  requestId: string;
  message?: string;
  batch: Batch;
  request: ScheduleRequest;
}
interface WebApi {
  scheduleBatch(
    id: string,
    revision: number,
    at: string,
    zone: string,
  ): Promise<{ batch: Batch; queued?: Admission }>;
  queueBatchSave(
    id: string,
    revision: number,
    changes: { hash: number; base: Tooltip; next: Tooltip }[],
    message: string,
  ): Promise<Admission>;
  readBatchStatus(
    id: string,
    signal?: AbortSignal,
    requestId?: string,
  ): Promise<{ batch: Batch; request: ScheduleRequest | null }>;
  retryBatchRequest(id: string, revision: number, requestId: string): Promise<Admission>;
  endBatchSchedule(id: string, revision: number, action: 'cancel' | 'unschedule'): Promise<unknown>;
  setRawFetch(value: undefined): void;
}
let api: WebApi;
let actor: number, clock: number;
let responses: { path: string; status: number }[];
const batch = () => batchSchema.parse(f.current()[batchPath]);
const request = (id: string) =>
  scheduleRequestSchema.parse(f.current()[scheduleIntentPaths.request(id)]);
const member = () => structuredClone(f.current()[memberPath]) as BatchMember;
const receipt = (id: string) => pub.receipt(pub.head('converter-v2-test'), id);
const target = () => new Date(Math.ceil((clock + 15 * 60_000) / 60_000) * 60_000).toISOString();
async function schedule() {
  const result = await api.scheduleBatch(B, batch().revision, target(), 'UTC');
  expect(result.queued?.message).toBe('Schedule requested');
  return result.queued!.requestId;
}
async function preparedSchedule() {
  const id = await schedule();
  await prep.drain();
  expect(batch().status).toBe('scheduled');
  return id;
}
function translation(text: string): Tooltip {
  const next = structuredClone(member().proposed);
  next.text.de = {
    text,
    updatedAt: new Date(clock).toISOString(),
    updatedBy: 'dan',
    sourceUpdatedAt: next.text.en!.updatedAt,
  };
  return next;
}

beforeAll(async () => {
  appKey = await makePrivateKey();
});
beforeEach(async () => {
  clock = Date.now();
  actor = 1;
  responses = [];
  scheduledConfig.enabled = true;
  publisherConfig.enabled = true;
  vi.spyOn(switches, 'preparation').mockReturnValue(true);
  f = new Fixture(appKey);
  git = new ActionRepository(f);
  const moveData = f.moveData.bind(f);
  vi.spyOn(f, 'moveData').mockImplementation((changes) => {
    const parent = f.dataHead;
    moveData(changes);
    f.commitParents.set(f.dataHead, [parent]);
  });
  f.env.PUBLISH_SIGNING_KEY = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const options: Options = {
    repo: 'test-org/scratch',
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
    now: () => clock,
    runUrl: 'https://github.com/test-org/scratch/actions/runs/1',
  };
  pub = new Publisher(git, options);
  prep = new SchedulePreparer(pub);
  f.moveData({
    '.publisher/PIN': {
      sourceSha: options.publisherSha,
      sha256: options.publisherDigest,
      capabilities: [
        'scheduledBatches',
        'scheduledGlobalsV1',
        'schedulePreparationV1',
        'elementTags',
        'markupBraces',
        'numberTokens',
      ],
    },
    'live/tooltips/123.json': tooltip(),
    'live/pushed.json': { 123: await publishableHash(tooltip()) },
    'schedule/due.json': { entries: [] },
    'schedule/index.json': { batches: [] },
    [batchPath]: batchSchema.parse({
      id: B,
      name: 'Integration',
      createdBy: { id: 1, login: 'alice' },
      createdAt: new Date(clock).toISOString(),
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
    }),
    [memberPath]: {
      hash: 123,
      base: tooltip(),
      proposed: tooltip('accepted correction'),
      baseCommit: f.dataHead,
      updatedAt: new Date(clock).toISOString(),
      updatedBy: 'alice',
    },
  });
  git.cas(
    L,
    undefined,
    git.commit(undefined, {
      'liveDescriptions.json': git.writeBlob(
        json({
          perks: Object.fromEntries(
            [1, 2, 3].map((hash) => [hash, { hash, editor: { en: { main: '', secondary: '' } } }]),
          ),
          databaseSettings: {},
        }),
      ),
    }),
  );
  activateGlobalsFixture(pub);
  const upstream = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === 'integration.example') {
      const response = await f.request(
        url.pathname + url.search,
        init?.method ?? 'GET',
        init?.body ? JSON.parse(String(init.body)) : undefined,
        actor,
      );
      responses.push({ path: url.pathname, status: response.status });
      return response;
    }
    if (url.pathname.endsWith('/git/trees') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { tree: { path: string; content?: string }[] };
      for (const entry of body.tree)
        if (entry.content !== undefined)
          git.bytes.set(entry.path + JSON.stringify(JSON.parse(entry.content)), entry.content);
    }
    return upstream(input, init);
  });
  const original = GitHub.prototype.result;
  vi.spyOn(GitHub.prototype, 'result').mockImplementation(function (
    this: GitHub,
    url,
    method,
    value,
  ) {
    if (url.startsWith(`/contents/schedule/batches/${B}?ref=`)) {
      const source = decodeURIComponent(url.split('?ref=')[1]);
      return Promise.resolve([
        {
          name: 'tooltips',
          type: 'dir',
          sha: globalTreeOid(git.tree(source), `schedule/batches/${B}/tooltips`),
        },
      ]);
    }
    return original.call(this, url, method, value);
  });
  vi.stubEnv('VITE_API_URL', 'https://integration.example');
  vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
  for (const name of ['localStorage', 'sessionStorage'])
    vi.stubGlobal(name, { getItem: () => null, setItem() {}, removeItem() {} });
  api = await import(webApiPath);
  const { useAuthStore } = await import(webAuthPath);
  await useAuthStore.getState().load();
  expect(useAuthStore.getState().user?.schedulePreparation).toBe(true);
  api.setRawFetch(undefined);
});
afterEach(() => {
  scheduledConfig.enabled = false;
  publisherConfig.enabled = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Worker → signed intent → Action → publisher → web', () => {
  it('leaves an inactive installation with zero intents byte-identical', async () => {
    vi.mocked(switches.preparation).mockReturnValue(false);
    // Assumes an already consistent index; Sched inert covers the 1116j reorder.
    const tree = git.tree(f.dataHead);
    prep.refreshIndex(tree);
    git.cas(D, f.dataHead, git.commit(f.dataHead, tree));
    const head = f.dataHead,
      live = git.head(L),
      snapshot = structuredClone(f.current());
    expect(Object.keys(snapshot).filter((p) => p.startsWith('schedule/requests/'))).toEqual([]);
    await prep.drain();
    expect(f.dataHead).toBe(head);
    expect(git.head(L)).toBe(live);
    expect(f.current()).toEqual(snapshot);
  });

  it('still drains an admitted intent after the Worker activation gate rolls back OFF', async () => {
    const id = await schedule();
    vi.mocked(switches.preparation).mockReturnValue(false);
    await prep.drain();
    expect(request(id).status).toBe('completed');
    expect(batch().status).toBe('scheduled');
    clock = Date.parse(batch().notBefore!) + 1;
    await pub.run();
    expect(receipt(id)).toBeDefined();
  });
  it('cancels a preparing batch through the legacy route after rollback', async () => {
    const id = await schedule();
    vi.mocked(switches.preparation).mockReturnValue(false);
    const response = await f.request(
      `/batches/${B}/cancel`,
      'POST',
      { revision: batch().revision },
      1,
    );
    expect(response.status).toBe(200);
    expect(batch().status).toBe('cancelled');
    expect(request(id).status).toBe('cancelled');
    await prep.drain();
    clock = Date.parse(target()) + 60 * 60_000;
    await pub.run();
    expect(receipt(id)).toBeUndefined();
  });
  it('unschedules a prepared batch through the legacy route after rollback', async () => {
    const id = await preparedSchedule();
    vi.mocked(switches.preparation).mockReturnValue(false);
    const response = await f.request(
      `/batches/${B}/unschedule`,
      'POST',
      { revision: batch().revision },
      1,
    );
    expect(response.status).toBe(200);
    expect(batch().status).toBe('draft');
    expect(f.current()['schedule/due.json']).toEqual({ entries: [] });
    clock = Date.parse(target()) + 60 * 60_000;
    await pub.run();
    expect(receipt(id)).toBeUndefined();
  });
  it('refuses Retry of a pending intent while the Worker gate is rolled back', async () => {
    const id = await schedule();
    vi.mocked(switches.preparation).mockReturnValue(false);
    const response = await f.request(
      `/batches/${B}/retry`,
      'POST',
      { revision: batch().revision, requestId: id },
      1,
    );
    expect(response.status).toBe(503);
  });
  it('confirms durable admission before preparation, publishes only the ready version once due', async () => {
    const liveParent = git.head(L)!;
    const before = pub.read<LegacyInput>(git.tree(liveParent), 'liveDescriptions.json')!;
    const sentinel = exportLegacy(
      [{ ...tooltip('Preserve unrelated live content'), hash: 999 }],
      clock,
      { 999: { name: 'Unrelated live tooltip', type: 'perk' } },
      {},
    );
    const baseline = {
      ...before,
      perks: {
        ...before.perks,
        ...sentinel,
      },
      databaseSettings: { folders: { saved: ['preserve-settings'] } },
    };
    git.cas(
      L,
      liveParent,
      git.commit(liveParent, { 'liveDescriptions.json': git.writeBlob(json(baseline)) }),
    );
    const seededLive = git.head(L)!;
    const savedOnly = { ...tooltip('Never publish this saved-only edit'), hash: 124 };
    f.moveData({ 'tooltips/124.json': savedOnly });
    const accepted = member(),
      id = await schedule();
    const approvedContentRevision = batch().contentRevision;
    expect(responses.at(-1)).toEqual({ path: `/batches/${B}/schedule`, status: 202 });
    expect(batch().status).toBe('preparing');
    expect(request(id).status).toBe('pending');
    expect(f.current()[paths(id).request]).toBeUndefined();
    expect(canClaimPreparedBatch(batch(), id)).toBe(false);
    expect(member()).toEqual(accepted);
    expect((await api.readBatchStatus(B)).batch.status).toBe('preparing');
    await prep.drain();
    expect(request(id).status, JSON.stringify(request(id).reasons)).toBe('completed');
    expect(canClaimPreparedBatch(batch(), id)).toBe(true);
    await pub.run();
    expect(receipt(id)).toBeUndefined();
    clock = Date.parse(batch().notBefore!) + 1;
    await pub.run();
    expect(batch().status).toBe('published');
    const published = receipt(id)!;
    expect(published).toMatchObject({
      opId: id,
      batchId: B,
      contentRevision: approvedContentRevision,
      requester: { id: 1, login: 'alice' },
      outcome: 'published',
      liveParent: seededLive,
      publisherSha: pub.options.publisherSha,
      generatorSha: pub.options.generatorSha,
      changed: [123],
    });
    expect(published.entries.map((entry) => entry.hash)).toEqual([123]);
    const claimTree = git.tree(published.sourceCommit);
    expect(batchSchema.parse(pub.read(claimTree, batchPath))).toMatchObject({
      id: B,
      status: 'publishing',
      opId: id,
      preparedRequestId: id,
      contentRevision: approvedContentRevision,
      claim: { opId: id },
    });
    expect(pub.read(claimTree, memberPath)).toEqual(accepted);
    expect(published.requestBlob).toBe(claimTree[paths(id).request]);
    const expectedEntries = exportLegacy([accepted.proposed], published.now, pub.options.facts, {});
    expect(published.exported).toEqual(expectedEntries);
    stampUploads(expectedEntries, new Set([123]), baseline.perks, published.now, 'alice');
    const expectedLive = { ...baseline, perks: { ...baseline.perks, ...expectedEntries } };
    const actualLive = pub.read<LegacyInput>(git.tree(git.head(L)!), 'liveDescriptions.json')!;
    expect(actualLive).toEqual(expectedLive);
    expect(actualLive.perks[999]).toEqual(baseline.perks[999]);
    expect(actualLive.perks[124]).toBeUndefined();
    expect(f.current()['tooltips/124.json']).toEqual(savedOnly);
    expect(deployedLegacyPresets).toHaveLength(7);
    for (const preset of deployedLegacyPresets) {
      const actual = buildLegacy(actualLive, preset);
      expect(actual, preset).toEqual(buildLegacy(expectedLive as LegacyInput, preset));
      expect(actual, preset).not.toEqual(buildLegacy(baseline as LegacyInput, preset));
    }
    expect((await api.readBatchStatus(B, undefined, id)).request?.status).toBe('completed');
    const head = git.head(L);
    await pub.run();
    expect(git.head(L)).toBe(head);
    expect(f.current()['schedule/due.json']).toEqual({ entries: [] });
  });

  it.each([false, true])(
    'gates Exotic during actual scheduled-save preparation (capable=%s)',
    async (capable) => {
      const accepted = member();
      if (capable) {
        const pin = f.current()['.publisher/PIN'] as { capabilities: string[] };
        f.moveData({
          '.publisher/PIN': { ...pin, capabilities: [...pin.capabilities, 'exoticTags'] },
        });
      }
      const next = tooltip('<exo/* keep */tic Gjallarhorn />');
      next.text.en!.updatedAt = new Date(clock).toISOString();
      const queued = await api.queueBatchSave(
        B,
        batch().revision,
        [{ hash: 123, base: accepted.proposed, next }],
        'Save Exotic draft',
      );
      expect(queued.request.status).toBe('pending');
      expect(member()).toEqual(accepted);
      await prep.drain();
      const status = await api.readBatchStatus(B, undefined, queued.requestId);
      expect(status.request?.status).toBe(capable ? 'completed' : 'needs_attention');
      if (capable) expect(member().proposed.text.en?.text).toBe(next.text.en?.text);
      else {
        expect(JSON.stringify(status.request?.reasons)).toContain('exoticTags');
        expect(member()).toEqual(accepted);
      }
    },
  );

  it('keeps draft saves pending until real materialization confirms the accepted version', async () => {
    const accepted = member(),
      next = tooltip('new accepted draft');
    next.text.en!.updatedAt = new Date(clock).toISOString();
    const queued = await api.queueBatchSave(
      B,
      batch().revision,
      [{ hash: 123, base: accepted.proposed, next }],
      'Save draft',
    );
    expect(responses.at(-1)).toEqual({ path: `/batches/${B}/save`, status: 202 });
    expect(member()).toEqual(accepted);
    expect(queued.request.status).toBe('pending');
    await prep.drain();
    const status = await api.readBatchStatus(B, undefined, queued.requestId);
    expect(status.batch.status).toBe('draft');
    expect(status.request?.status).toBe('completed');
    expect(status.request?.result?.contentRevision).toBeGreaterThan(1);
    expect(member().proposed.text.en?.text).toBe(next.text.en?.text);
    expect(f.current()[paths(queued.requestId).request]).toBeUndefined();
  });

  it('reschedules with a new signed intent and terminally fences the old publication', async () => {
    const old = await preparedSchedule(),
      id = await schedule();
    expect(id).not.toBe(old);
    expect(f.current()[paths(old).request]).toBeUndefined();
    await prep.drain();
    clock = Date.parse(batch().notBefore!) + 1;
    await pub.run();
    expect(receipt(old)).toBeUndefined();
    expect(receipt(id)).toBeDefined();
  });

  it.each([
    ['unschedule', 'schedule'],
    ['cancel', 'schedule'],
    ['unschedule', 'save'],
    ['cancel', 'save'],
  ] as const)('%s wins a race with a computed %s result', async (action, kind) => {
    let prior: string | undefined;
    if (kind === 'save') prior = await preparedSchedule();
    const id =
      kind === 'schedule'
        ? await schedule()
        : (
            await api.queueBatchSave(
              B,
              batch().revision,
              [{ hash: 123, base: member().proposed, next: translation('gültig') }],
              'Translate',
            )
          ).requestId;
    const prepare = prep.prepare.bind(prep);
    vi.spyOn(prep, 'prepare').mockImplementationOnce(async (...args) => {
      const result = await prepare(...args);
      await api.endBatchSchedule(B, batch().revision, action);
      return result;
    });
    await prep.drain();
    expect(batch().status).toBe(action === 'cancel' ? 'cancelled' : 'draft');
    expect(request(id).status).toBe('cancelled');
    expect(f.current()[paths(id).request]).toBeUndefined();
    expect(receipt(id)).toBeUndefined();
    if (prior) {
      expect(f.current()[paths(prior).request]).toBeUndefined();
      clock += 60 * 60_000;
      await pub.run();
      expect(receipt(prior)).toBeUndefined();
    }
  });

  it('keeps a rejected translator draft FAILED while publishing the last accepted version', async () => {
    const id = await preparedSchedule(),
      accepted = member();
    actor = 4;
    const next = translation('import main from 124');
    const queued = await api.queueBatchSave(
      B,
      batch().revision,
      [{ hash: 123, base: accepted.proposed, next }],
      'Translate',
    );
    await prep.drain();
    const status = await api.readBatchStatus(B, undefined, queued.requestId);
    expect(status.request?.status).toBe('failed');
    expect(status.request?.result).toBeUndefined();
    expect(status.request?.reasons?.length).toBeGreaterThan(0);
    expect(status.batch.status).toBe('scheduled');
    expect(member()).toEqual(accepted);
    expect(f.current()[scheduleIntentPaths.body(queued.requestId)]).toMatchObject({
      changes: [{ next }],
    });
    clock = Date.parse(batch().notBefore!) + 1;
    await pub.run();
    expect(receipt(id)).toBeDefined();
    expect(batch().status).toBe('published');
    expect(member().proposed.text.de).toBeUndefined();
  });

  it('returns editor content rejection with reasons, no due entry, and no semantic Retry', async () => {
    const proposed = member();
    proposed.proposed.text.de = translation('import main from 124').text.de;
    f.moveData({ [memberPath]: proposed });
    const id = await schedule();
    await prep.drain();
    const status = await api.readBatchStatus(B, undefined, id);
    expect(status.batch.status).toBe('needs_attention');
    expect(status.request?.retryable).toBe(false);
    expect(status.request?.reasons?.length).toBeGreaterThan(0);
    expect(f.current()['schedule/due.json']).toEqual({ entries: [] });
    await expect(api.retryBatchRequest(B, batch().revision, id)).rejects.toThrow();
  });

  it('uses the existing kick for pending Retry and stays unclaimable after its target', async () => {
    const id = await schedule();
    clock = Date.parse(batch().notBefore!) + 6 * 60_000;
    const { statusChip } = await import(webModelPath);
    expect(statusChip(batch(), clock).label).toBe('Preparing · overdue');
    expect(canClaimPreparedBatch(batch(), id)).toBe(false);
    await pub.operation(id);
    expect(receipt(id)).toBeUndefined();
    await api.retryBatchRequest(B, batch().revision, id);
    await api.retryBatchRequest(B, batch().revision, id);
    expect(f.kicks.size).toBe(1);
    expect(request(id).status).toBe('pending');
    await pub.run();
    expect(receipt(id)).toBeDefined();
  });

  it('rechecks role loss between signed admission and preparation', async () => {
    const id = await schedule();
    f.moveData({
      'config/permissions.json': {
        users: { ...config.users, 1: { login: 'alice', role: 'trial' } },
      },
    });
    await prep.drain();
    expect(batch().status).toBe('needs_attention');
    expect(request(id).reasons?.[0].reason).toContain('revoked');
    expect(receipt(id)).toBeUndefined();
    expect(f.current()[paths(id).request]).toBeUndefined();
  });

  it('fails closed if the installed runtime loses in-place support after admission', async () => {
    const id = await schedule();
    const pin = f.current()['.publisher/PIN'] as { capabilities: string[] };
    f.moveData({
      '.publisher/PIN': {
        ...pin,
        capabilities: pin.capabilities.filter(
          (capability) => capability !== globalsInPlaceCapability,
        ),
      },
    });
    await prep.drain();
    expect(batch().status).toBe('needs_attention');
    expect(request(id).reasons?.[0].reason).toContain('Update the installed publisher');
    expect(receipt(id)).toBeUndefined();
    expect(f.current()[paths(id).request]).toBeUndefined();
  });
});
