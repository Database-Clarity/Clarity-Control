// Scheduled changes P4 (spec .agents/reports/scheduled-changes/spec.md "Tests and gates",
// publisher fixtures): the publisher's claim, publication, RECORD activation, and failure paths
// for `batch` requests, in the local simulator (and the local bare remote for the core path).
// The Worker's batch writes (schedule, saves, unschedule, resolve) are simulated here exactly as
// P2 commits them: one CAS commit on editor-data each.
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approvedDigest,
  batchIntentDigest,
  batchSchema,
  missingSnapshotReason,
  resolveActivation,
  type ActivationConflict,
  type Batch,
  type BatchPublishIntent,
  type Due,
  type ScheduleIndex,
} from '@clarity/core/schedule';
import {
  parsePublishRequestPayload,
  publishIntentDigest,
  publishRequestIntentDigest,
  publishableHash,
  stableStringify,
  type PublishPayload,
  type Tooltip,
} from '../../packages/core/src/index.js';
import { LocalRepository, RefRace, type Tree } from './git.js';
import { RemoteRepository } from './remote.js';
import { Publisher, paths, type Options } from './publisher.js';
import { eventsArchive, resolveActivationMessage, supersededMessage } from './batch.js';

vi.setConfig({ testTimeout: 300_000 });

const D = 'refs/heads/editor-data',
  L = 'refs/heads/converter-v2-test';
const BATCH = '01K95H000000000000000000B1',
  OP = '01K95H000000000000000000S1',
  OP2 = '01K95H000000000000000000S2',
  PUSH1 = '01K95H000000000000000000P1',
  PUSH2 = '01K95H000000000000000000P2';
const encode = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
const START = Date.parse('2030-03-17T18:00:00.000Z');
const DUE = '2030-03-17T17:55:00.000Z',
  LATER = '2030-03-17T19:00:00.000Z';
const alice = { id: 1, login: 'alice' };
const entry = (text: string, updatedAt = '2030-01-01T00:00:00.000Z') => ({
  text,
  updatedAt,
  updatedBy: 'alice',
});
const tip = (over: Partial<Tooltip> = {}, hash = 123): Tooltip => ({
  hash,
  text: { en: entry('reviewed') },
  associated: [],
  ...over,
});
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

interface MemberSpec {
  hash: number;
  base: Tooltip | null;
  proposed: Tooltip;
}

async function setup(transport: 'simulator' | 'remote' = 'simulator') {
  const root = mkdtempSync(join(tmpdir(), 'batch-fixture-'));
  roots.push(root);
  execFileSync('git', ['init', '--bare', root], { stdio: 'pipe' });
  execFileSync('git', ['--git-dir', root, 'config', 'publisher.simulator', 'true']);
  const cache = mkdtempSync(join(tmpdir(), 'batch-cache-'));
  roots.push(cache);
  execFileSync('git', ['init', '--bare', cache], { stdio: 'pipe' });
  execFileSync('git', ['--git-dir', cache, 'config', 'publisher.simulator', 'true']);
  const git =
    transport === 'simulator'
      ? new LocalRepository(root)
      : new RemoteRepository(cache, { fileUrl: pathToFileURL(root).href });
  const keys = generateKeyPairSync('ed25519');
  const clock = { now: START };
  const options: Options = {
    repo: 'test/local',
    dataBranch: 'editor-data',
    liveBranch: 'converter-v2-test',
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    keyFingerprint: createHash('sha256')
      .update(keys.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex'),
    publisherSha: 'a'.repeat(40),
    generatorSha: 'b'.repeat(40),
    aliases: {},
    facts: {
      123: { name: 'Thing', type: 'perk' },
      124: { name: 'Other', type: 'perk' },
      125: { name: 'New', type: 'perk' },
    },
    now: () => clock.now,
    runUrl: 'local://fixture',
    backoff: async () => {},
  };
  const pub = new Publisher(git, options);
  const published = tip();
  const initial: Tree = {};
  for (const [p, v] of Object.entries({
    'config/permissions.json': { users: { '1': { login: 'alice', role: 'editor' } } },
    'tooltips/123.json': published,
    'live/tooltips/123.json': published,
    'live/pushed.json': { 123: await publishableHash(published) },
    'schedule/due.json': { entries: [] },
    'schedule/index.json': { batches: [] },
  }))
    initial[p] = git.writeBlob(encode(v));
  git.cas(D, undefined, git.commit(undefined, initial, 'Seed data'));
  git.cas(
    L,
    undefined,
    git.commit(
      undefined,
      { 'liveDescriptions.json': git.writeBlob(encode({ perks: {}, databaseSettings: {} })) },
      'Seed live',
    ),
  );
  const signEnvelope = (payload: object) => {
    const bytes = stableStringify(payload);
    return {
      payload: bytes,
      sig: sign(null, Buffer.from(bytes), keys.privateKey).toString('base64'),
    };
  };
  const head = () => git.head(D)!;
  const tree = () => git.tree(head());
  const read = <T>(path: string, t = tree()) => pub.read<T>(t, path);
  function change(ref: string, files: Record<string, unknown>, remove: string[] = []) {
    const h = git.head(ref)!,
      t = git.tree(h);
    for (const [p, v] of Object.entries(files)) t[p] = git.writeBlob(encode(v));
    for (const p of remove) delete t[p];
    const c = git.commit(h, t, 'Fixture write');
    git.cas(ref, h, c);
    return c;
  }
  /** A signed manual push request as the Worker's /publish writes it. */
  async function push(id: string, hashes = [123], createdAt = '2030-03-17T17:00:00.000Z') {
    const t = tree();
    const expected: Record<string, string> = {};
    for (const h of hashes)
      expected[h] = await publishableHash(pub.read<Tooltip>(t, `tooltips/${h}.json`)!);
    const payload: PublishPayload = {
      opId: id,
      kind: 'push',
      repo: options.repo,
      dataBranch: options.dataBranch,
      liveBranch: options.liveBranch,
      requester: alice,
      createdAt,
      hashes,
      expected,
      intentDigest: '0'.repeat(64),
    };
    payload.intentDigest = await publishIntentDigest(payload);
    change(D, { [paths(id).request]: signEnvelope(payload) });
  }
  const batchFile = (): Batch => batchSchema.parse(read(`schedule/batches/${BATCH}/batch.json`));
  const batchAt = (commit: string) =>
    batchSchema.safeParse(pub.read(git.tree(commit), `schedule/batches/${BATCH}/batch.json`)).data;
  const memberFiles = (members: MemberSpec[]) =>
    Object.fromEntries(
      members.map((m) => [
        `schedule/batches/${BATCH}/tooltips/${m.hash}.json`,
        {
          hash: m.hash,
          base: m.base,
          baseCommit: head(),
          proposed: m.proposed,
          updatedAt: '2030-03-17T12:00:00.000Z',
          updatedBy: 'alice',
        },
      ]),
    );
  async function signedBatch(
    opId: string,
    members: MemberSpec[],
    notBefore: string,
    contentRevision: number,
    createdAt: string,
  ) {
    const intent: BatchPublishIntent = {
      kind: 'batch',
      opId,
      repo: options.repo,
      dataBranch: options.dataBranch,
      liveBranch: options.liveBranch,
      requester: alice,
      batchId: BATCH,
      contentRevision,
      notBefore,
      hashes: members.map((m) => m.hash).sort((a, b) => a - b),
      approvedDigest: await approvedDigest(members),
    };
    return signEnvelope({ ...intent, createdAt, intentDigest: await batchIntentDigest(intent) });
  }
  const dueWith = (entries: Due['entries']) => ({ entries });
  const indexWith = (batch: Batch, hashes: number[]): ScheduleIndex => ({
    batches: [
      {
        id: batch.id,
        name: batch.name,
        status: batch.status,
        notBefore: batch.notBefore,
        opId: batch.opId,
        revision: batch.revision,
        hashes,
        updatedAt: '2030-03-17T12:00:00.000Z',
      },
    ],
  });
  /** The Worker's schedule commit (spec step 1): request, batch.json, members, due, and index. */
  async function schedule(
    members: MemberSpec[],
    {
      opId = OP,
      notBefore = DUE,
      createdAt = '2030-03-17T12:00:00.000Z',
      events = 1,
    }: { opId?: string; notBefore?: string; createdAt?: string; events?: number } = {},
  ) {
    const hashes = members.map((m) => m.hash).sort((a, b) => a - b);
    const batch: Batch = batchSchema.parse({
      id: BATCH,
      name: 'Spring update',
      createdBy: alice,
      createdAt: '2030-03-17T11:00:00.000Z',
      revision: events + 1,
      contentRevision: 1,
      status: 'scheduled',
      notBefore,
      zone: 'Europe/Berlin',
      opId,
      scheduledContentRevision: 1,
      claim: null,
      result: null,
      events: Array.from({ length: events }, (_, i) => ({
        at: '2030-03-17T12:00:00.000Z',
        by: alice,
        action: i === events - 1 ? 'schedule' : 'save',
        revision: i + 2,
        contentRevision: 1,
      })),
    });
    const files: Record<string, unknown> = {
      ...memberFiles(members),
      [`schedule/batches/${BATCH}/batch.json`]: batch,
      [paths(opId).request]: await signedBatch(opId, members, notBefore, 1, createdAt),
      'schedule/due.json': dueWith([{ batchId: BATCH, opId, notBefore, claimed: false }]),
      'schedule/index.json': indexWith(batch, hashes),
    };
    change(D, files);
    return batch;
  }
  /** A translation save on a scheduled batch: revision +1, contentRevision unchanged (R1). */
  function translationSave(hash: number, lang: 'de' | 'fr', text: string) {
    const path = `schedule/batches/${BATCH}/tooltips/${hash}.json`;
    const member = read<{ proposed: Tooltip }>(path)!;
    const batch = batchFile();
    change(D, {
      [path]: {
        ...member,
        proposed: {
          ...member.proposed,
          text: { ...member.proposed.text, [lang]: entry(text, '2030-03-17T13:00:00.000Z') },
        },
      },
      [`schedule/batches/${BATCH}/batch.json`]: {
        ...batch,
        revision: batch.revision + 1,
        events: [
          ...batch.events,
          {
            at: '2030-03-17T13:00:00.000Z',
            by: alice,
            action: 'save',
            revision: batch.revision + 1,
            contentRevision: batch.contentRevision,
          },
        ],
      },
    });
  }
  /** The Worker's unschedule commit (unclaimed only): request out, cancelled log, draft batch. */
  function unscheduleCommit(base: string, opId = OP) {
    const t = git.tree(base);
    const batch = batchSchema.parse(pub.read(t, `schedule/batches/${BATCH}/batch.json`));
    if (batch.claim) throw new Error('409 Publishing started');
    const draft = {
      ...batch,
      status: 'draft',
      opId: null,
      scheduledContentRevision: null,
      notBefore: null,
      zone: null,
      revision: batch.revision + 1,
    };
    t[`schedule/batches/${BATCH}/batch.json`] = git.writeBlob(encode(draft));
    t[paths(opId).log] = git.writeBlob(encode({ result: { status: 'cancelled' } }));
    delete t[paths(opId).request];
    t['schedule/due.json'] = git.writeBlob(encode({ entries: [] }));
    return git.commit(base, t, 'Unschedule');
  }
  const receipts = (opId = OP) =>
    git
      .history(git.head(L)!)
      .filter(
        (c, i, all) =>
          git.tree(c)[paths(opId).receipt] && (!i || !git.tree(all[i - 1])[paths(opId).receipt]),
      );
  const live = () =>
    pub.read<{ perks: Record<string, unknown> }>(git.tree(git.head(L)!), 'liveDescriptions.json')!;
  return {
    git,
    pub,
    options,
    clock,
    change,
    push,
    schedule,
    translationSave,
    unscheduleCommit,
    signedBatch,
    memberFiles,
    batchFile,
    batchAt,
    head,
    tree,
    read,
    receipts,
    live,
  };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

const proposedEn = (text = 'batch text') =>
  tip({ text: { en: entry(text, '2030-03-17T12:00:00.000Z') } });

/** Publication succeeded exactly once and the batch's whole terminal state is consistent. */
function assertPublished(f: Fixture, opId = OP) {
  const t = f.tree();
  expect(t[paths(opId).request]).toBeUndefined();
  expect(f.receipts(opId)).toHaveLength(1);
  const log = f.read<{
    result: { status: string };
    liveCommit: string;
    times: Record<string, unknown>;
  }>(paths(opId).log)!;
  expect(log.result.status).toMatch(/done|unchanged/);
  const batch = f.batchFile();
  expect(batch.status).toBe('published');
  expect(batch.opId).toBe(opId);
  expect(batch.claim?.opId).toBe(opId);
  expect(batch.result?.opId).toBe(opId);
  expect(f.read<Due>('schedule/due.json')!.entries.filter((e) => e.opId === opId)).toEqual([]);
  const index = f.read<ScheduleIndex>('schedule/index.json')!;
  expect(index.batches.find((b) => b.id === BATCH)).toMatchObject({
    status: 'published',
    revision: batch.revision,
  });
  const receipt = f.pub.receipt(log.liveCommit, opId)!;
  expect(receipt).toMatchObject({ batchId: BATCH, contentRevision: 1 });
  for (const e of receipt.entries) {
    expect(t[`live/tooltips/${e.hash}.json`]).toBe(e.tooltipBlob);
    expect(f.read<Record<string, string>>('live/pushed.json')![e.hash]).toBe(e.digest);
  }
  return { batch, log, receipt };
}

describe('request union (publishRequest.ts)', () => {
  it('parses both kinds, keeps the push digest byte-identical, and dispatches the batch digest', async () => {
    const push: PublishPayload = {
      opId: PUSH1,
      kind: 'push',
      repo: 'test/local',
      dataBranch: 'editor-data',
      liveBranch: 'converter-v2-test',
      requester: alice,
      createdAt: '2026-11-03T12:00:00.000Z',
      hashes: [123],
      expected: { 123: 'a'.repeat(64) },
      intentDigest: '0'.repeat(64),
    };
    expect(await parsePublishRequestPayload(push)).toEqual(push);
    expect(await publishRequestIntentDigest(push)).toBe(await publishIntentDigest(push));
    const intent: BatchPublishIntent = {
      kind: 'batch',
      opId: OP,
      repo: 'test/local',
      dataBranch: 'editor-data',
      liveBranch: 'converter-v2-test',
      requester: alice,
      batchId: BATCH,
      contentRevision: 1,
      notBefore: DUE,
      hashes: [123],
      approvedDigest: 'c'.repeat(64),
    };
    const batch = { ...intent, createdAt: DUE, intentDigest: '0'.repeat(64) };
    expect(await parsePublishRequestPayload(batch)).toEqual(batch);
    expect(await publishRequestIntentDigest(batch)).toBe(await batchIntentDigest(intent));
    await expect(parsePublishRequestPayload({ ...batch, expected: {} })).rejects.toThrow();
    await expect(parsePublishRequestPayload({ ...push, kind: 'other' })).rejects.toThrow();
  });
});

describe.each(['simulator', 'remote'] as const)('%s: scheduled batch core path', (transport) => {
  it('publishes a due batch through the claim, activates it, and records cas landedAt', async () => {
    const f = await setup(transport);
    await f.schedule([{ hash: 123, base: tip(), proposed: proposedEn() }]);
    const before = f.head();
    await f.pub.run();
    const { batch, log, receipt } = assertPublished(f);
    // The claim commit S' is the receipt's source: the scheduled head plus only schedule files.
    const claim = f.git.tree(receipt.sourceCommit);
    const scheduled = f.git.tree(before);
    const moved = Object.keys({ ...claim, ...scheduled }).filter((p) => claim[p] !== scheduled[p]);
    expect(moved.sort()).toEqual(
      [
        'schedule/batches/' + BATCH + '/batch.json',
        'schedule/due.json',
        'schedule/index.json',
      ].sort(),
    );
    expect(f.read<Due>('schedule/due.json', claim)!.entries).toEqual([
      { batchId: BATCH, opId: OP, notBefore: DUE, claimed: true },
    ]);
    expect(f.read<Tooltip>('tooltips/123.json')!.text.en!.text).toBe('batch text');
    expect(f.read<Tooltip>('live/tooltips/123.json')!.text.en!.text).toBe('batch text');
    expect(JSON.stringify(f.live().perks[123])).toContain('batch text');
    expect(batch.result).toMatchObject({
      status: 'published',
      landedAtSource: 'cas',
      landedAt: new Date(START).toISOString(),
      recordedAt: new Date(START).toISOString(),
      exportNow: new Date(START).toISOString(),
      liveCommit: log.liveCommit,
    });
    expect(batch.events.slice(-2).map((e) => e.action)).toEqual(['claim', 'published']);
    expect(batch.revision).toBe(4);
    expect(batch.contentRevision).toBe(1);
    expect(log.times).toMatchObject({ landedAtSource: 'cas', recordedAt: expect.any(String) });
  });

  it('crash after the live write: the next run alone records it once with observed landedAt', async () => {
    const f = await setup(transport);
    await f.schedule([{ hash: 123, base: tip(), proposed: proposedEn() }]);
    const cas = f.git.cas.bind(f.git);
    f.git.cas = (ref, old, next) => {
      if (ref === L) {
        cas(ref, old, next);
        throw new Error('disconnect');
      }
      cas(ref, old, next);
    };
    f.options.backoff = async () => {
      throw new Error('runner crash');
    };
    await expect(f.pub.run()).rejects.toThrow('runner crash');
    expect(f.read<Due>('schedule/due.json')!.entries[0].claimed).toBe(true);
    f.git.cas = cas;
    f.options.backoff = async () => {};
    f.clock.now = START + 600_000;
    await f.pub.run();
    const { batch } = assertPublished(f);
    expect(batch.result).toMatchObject({
      landedAtSource: 'observed',
      landedAt: new Date(START + 600_000).toISOString(),
    });
  });
});

describe('scheduled batches (simulator)', () => {
  it('a batch not yet due is neither drained nor pending; it publishes once due', async () => {
    const f = await setup();
    await f.schedule([{ hash: 123, base: tip(), proposed: proposedEn() }], { notBefore: LATER });
    expect(f.pub.queue(f.head())).toEqual([]);
    const before = f.head();
    await f.pub.run();
    expect(f.head()).toBe(before);
    expect(f.batchFile().status).toBe('scheduled');
    const bundle = f.pub.read<{ publishQueue: unknown[]; scheduledQueue: unknown[] }>(
      f.git.tree(f.git.head('refs/heads/editor-data-bundle')!),
      'bundle.json',
    )!;
    expect(bundle.publishQueue).toEqual([]);
    expect(bundle.scheduledQueue).toEqual([
      {
        opId: OP,
        kind: 'batch',
        batchId: BATCH,
        requester: alice,
        hashes: [123],
        createdAt: '2030-03-17T12:00:00.000Z',
        notBefore: LATER,
      },
    ]);
    f.clock.now = Date.parse(LATER);
    expect(f.pub.queue(f.head())).toEqual([OP]);
    await f.pub.run();
    assertPublished(f);
  });

  it('drains FIFO with manual pushes: the batch sits at its notBefore', async () => {
    const f = await setup();
    f.change(D, { 'tooltips/124.json': tip({}, 124) });
    await f.push(PUSH1, [124], '2030-03-17T17:00:00.000Z');
    await f.schedule([{ hash: 123, base: tip(), proposed: proposedEn() }]);
    await f.push(PUSH2, [124], '2030-03-17T17:56:00.000Z');
    expect(f.pub.queue(f.head())).toEqual([PUSH1, OP, PUSH2]);
    const bundle = () =>
      f.pub.read<{ publishQueue: { opId: string; kind?: string }[] }>(
        f.git.tree(f.git.head('refs/heads/editor-data-bundle')!),
        'bundle.json',
      )!;
    f.pub.bundle();
    expect(bundle().publishQueue.map((e) => [e.opId, e.kind])).toEqual([
      [PUSH1, undefined],
      [OP, 'batch'],
      [PUSH2, undefined],
    ]);
    await f.pub.run();
    assertPublished(f);
    const history = f.git.history(L);
    const landed = (id: string) => history.findIndex((c) => f.git.tree(c)[paths(id).receipt]);
    expect(landed(PUSH1)).toBeGreaterThan(0);
    expect(landed(OP)).toBeGreaterThan(landed(PUSH1));
    expect(landed(PUSH2)).toBeGreaterThan(landed(OP));
    expect(f.pub.queue(f.head())).toEqual([]);
  });

  it('R1: translation saves after scheduling publish exactly once, with the latest translation', async () => {
    const f = await setup();
    await f.schedule([{ hash: 123, base: tip(), proposed: proposedEn() }]);
    f.translationSave(123, 'de', 'erste');
    f.translationSave(123, 'de', 'zweite');
    f.translationSave(123, 'fr', 'premier');
    await f.pub.run();
    await f.pub.run();
    assertPublished(f);
    const current = f.read<Tooltip>('tooltips/123.json')!;
    expect(current.text.de!.text).toBe('zweite');
    expect(current.text.fr!.text).toBe('premier');
    expect(JSON.stringify(f.live().perks[123])).toContain('zweite');
  });

  it('reschedule: the Worker swaps the request; the new opId publishes', async () => {
    const f = await setup();
    const members = [{ hash: 123, base: tip(), proposed: proposedEn() }];
    await f.schedule(members, { notBefore: LATER });
    const batch = f.batchFile();
    f.change(
      D,
      {
        [`schedule/batches/${BATCH}/batch.json`]: {
          ...batch,
          opId: OP2,
          notBefore: DUE,
          revision: batch.revision + 1,
        },
        [paths(OP2).request]: await f.signedBatch(OP2, members, DUE, 1, '2030-03-17T12:30:00.000Z'),
        [paths(OP).log]: { result: { status: 'cancelled' } },
        'schedule/due.json': {
          entries: [{ batchId: BATCH, opId: OP2, notBefore: DUE, claimed: false }],
        },
      },
      [paths(OP).request],
    );
    await f.pub.run();
    assertPublished(f, OP2);
    expect(f.read(paths(OP).log)).toEqual({ result: { status: 'cancelled' } });
  });

  it('superseded: a stale old request never touches the batch of a newer opId', async () => {
    const f = await setup();
    const members = [{ hash: 123, base: tip(), proposed: proposedEn() }];
    await f.schedule(members, { opId: OP, notBefore: '2030-03-17T17:50:00.000Z' });
    const batch = f.batchFile();
    // A reschedule whose old request lingered (e.g. restored by a buggy write).
    f.change(D, {
      [`schedule/batches/${BATCH}/batch.json`]: {
        ...batch,
        opId: OP2,
        notBefore: DUE,
        revision: batch.revision + 1,
      },
      [paths(OP2).request]: await f.signedBatch(OP2, members, DUE, 1, '2030-03-17T12:30:00.000Z'),
      'schedule/due.json': {
        entries: [{ batchId: BATCH, opId: OP2, notBefore: DUE, claimed: false }],
      },
    });
    expect(f.pub.queue(f.head())).toEqual([OP, OP2]);
    await f.pub.operation(OP);
    expect(f.read<{ result: { status: string; error: string } }>(paths(OP).log)!.result).toEqual({
      status: 'superseded',
      error: supersededMessage,
    });
    expect(f.batchFile()).toMatchObject({ status: 'scheduled', opId: OP2, result: null });
    expect(f.read<Due>('schedule/due.json')!.entries).toHaveLength(1);
    await f.pub.run();
    assertPublished(f, OP2);
    expect(f.receipts(OP)).toHaveLength(0);
  });

  it('R2: an unschedule landing before the claim wins; no candidate is ever built', async () => {
    const f = await setup();
    await f.schedule([{ hash: 123, base: tip(), proposed: proposedEn() }]);
    const live = f.git.head(L);
    const cas = f.git.cas.bind(f.git);
    let raced = false;
    f.git.cas = (ref, old, next) => {
      if (ref === D && !raced) {
        raced = true;
        cas(D, old, f.unscheduleCommit(old!));
      }
      cas(ref, old, next);
    };
    await f.pub.run();
    expect(raced).toBe(true);
    expect(f.git.head(L)).toBe(live);
    expect(f.git.head(paths(OP).candidate)).toBeUndefined();
    expect(f.batchFile()).toMatchObject({ status: 'draft', claim: null, result: null });
    expect(f.read(paths(OP).log)).toEqual({ result: { status: 'cancelled' } });
    expect(f.read<Tooltip>('tooltips/123.json')).toEqual(tip());
  });

  it('R2: an unschedule computed before the claim but landing after it loses its CAS', async () => {
    const f = await setup();
    await f.schedule([{ hash: 123, base: tip(), proposed: proposedEn() }]);
    const preClaim = f.head();
    const late = f.unscheduleCommit(preClaim);
    const cas = f.git.cas.bind(f.git);
    let refused = false;
    f.git.cas = (ref, old, next) => {
      if (ref === L && !refused) {
        expect(() => cas(D, preClaim, late)).toThrow(RefRace);
        // The Worker re-reads the head: the batch is claimed, so it refuses (409).
        expect(() => f.unscheduleCommit(f.head())).toThrow('Publishing started');
        refused = true;
      }
      cas(ref, old, next);
    };
    await f.pub.run();
    expect(refused).toBe(true);
    assertPublished(f);
  });

  it.each(['after the claim', 'after the candidate', 'mid-RECORD'] as const)(
    'R11 crash %s: the cron alone finishes the same opId exactly once',
    async (when) => {
      const f = await setup();
      await f.schedule([{ hash: 123, base: tip(), proposed: proposedEn() }]);
      const cas = f.git.cas.bind(f.git);
      let dataWrites = 0;
      f.git.cas = (ref, old, next) => {
        if (when === 'after the claim' && ref === paths(OP).candidate) throw new Error('crash');
        if (when === 'after the candidate' && ref === L) throw new Error('crash');
        if (when === 'mid-RECORD' && ref === D && ++dataWrites === 2)
          throw new Error('record unavailable');
        cas(ref, old, next);
      };
      f.options.backoff = async () => {
        throw new Error('runner crash');
      };
      await expect(f.pub.run()).rejects.toThrow();
      const batch = f.batchFile();
      expect(batch.status).toBe('publishing');
      expect(f.read<Due>('schedule/due.json')!.entries).toEqual([
        { batchId: BATCH, opId: OP, notBefore: DUE, claimed: true },
      ]);
      expect(f.git.head(paths(OP).candidate) !== undefined).toBe(when !== 'after the claim');
      f.git.cas = cas;
      f.options.backoff = async () => {};
      f.clock.now = START + 600_000;
      await f.pub.run();
      const { batch: done, receipt } = assertPublished(f);
      expect(done.events.filter((e) => e.action === 'claim')).toHaveLength(1);
      expect(done.result!.landedAtSource).toBe(when === 'mid-RECORD' ? 'observed' : 'cas');
      // The resumed run used S' (the original claim commit), never a later head.
      expect(receipt.sourceCommit).toBe(
        f.git.history(D).find((c) => f.batchAt(c)?.status === 'publishing'),
      );
      await f.pub.run();
      expect(f.receipts()).toHaveLength(1);
    },
  );

  it('sec F1: a claimed batch drains before a push that landed after its claim (never overwritten)', async () => {
    const f = await setup();
    await f.schedule([{ hash: 123, base: tip(), proposed: proposedEn() }]);
    const cas = f.git.cas.bind(f.git);
    f.git.cas = (ref, old, next) => {
      if (ref === paths(OP).candidate) throw new Error('crash');
      cas(ref, old, next);
    };
    await expect(f.pub.run()).rejects.toThrow('Candidate create unresolved');
    f.git.cas = cas;
    expect(f.batchFile().status).toBe('publishing');
    // A French save and its manual push, signed before notBefore but committed after the claim
    // (Worker latency or clock skew): by createdAt alone it would sort ahead of the batch.
    f.change(D, {
      'tooltips/123.json': tip({ text: { en: entry('reviewed'), fr: entry('sauvé') } }),
    });
    await f.push(PUSH1, [123], '2030-03-17T17:54:00.000Z');
    expect(f.pub.queue(f.head())).toEqual([OP, PUSH1]);
    await f.pub.run();
    assertPublished(f);
    // The push now names a tooltip the batch activation moved: stale, never published over the
    // batch, and live never held the French text it would have dropped.
    expect(f.read<{ result: { status: string } }>(paths(PUSH1).log)!.result.status).toBe('stale');
    expect(f.receipts(PUSH1)).toHaveLength(0);
    expect(f.read<Tooltip>('tooltips/123.json')!.text).toMatchObject({
      en: { text: 'batch text' },
      fr: { text: 'sauvé' },
    });
  });

  it('sec F2: claimCommit fails closed when its walk ends inside the claimed run', async () => {
    const f = await setup();
    await f.schedule([{ hash: 123, base: tip(), proposed: proposedEn() }]);
    f.git.cas = ((cas) => (ref: string, old: string | undefined, next: string | undefined) => {
      if (ref === paths(OP).candidate) throw new Error('crash');
      cas(ref, old, next);
    })(f.git.cas.bind(f.git));
    await expect(f.pub.run()).rejects.toThrow();
    const history = f.git.history(D);
    const claimedOnly = history.filter((c) => f.batchAt(c)?.status === 'publishing');
    expect(f.pub.claimCommit(BATCH, OP)).toBe(claimedOnly[0]);
    f.git.history = () => claimedOnly;
    expect(() => f.pub.claimCommit(BATCH, OP)).toThrow('operator required');
  });

  it('R14: a new tooltip absent at claim and RECORD is created; first publication is whole (C4)', async () => {
    const f = await setup();
    const created = tip({ text: { en: entry('brand new') } }, 125);
    await f.schedule([{ hash: 125, base: null, proposed: created }]);
    await f.pub.run();
    const { batch } = assertPublished(f);
    expect(f.read<Tooltip>('tooltips/125.json')).toEqual(created);
    expect(f.read<Tooltip>('live/tooltips/125.json')).toEqual(created);
    expect(batch.result!.outcomes).toEqual([{ hash: 125, status: 'created' }]);
  });

  it('R14: a tooltip created before the claim makes the batch stale ($exists), back to draft', async () => {
    const f = await setup();
    const created = tip({ text: { en: entry('brand new') } }, 125);
    await f.schedule([{ hash: 125, base: null, proposed: created }]);
    f.change(D, { 'tooltips/125.json': tip({ text: { en: entry('someone else') } }, 125) });
    await f.pub.run();
    expect(f.receipts()).toHaveLength(0);
    const batch = f.batchFile();
    expect(batch).toMatchObject({
      status: 'draft',
      opId: null,
      claim: null,
      scheduledContentRevision: null,
      result: {
        opId: OP,
        status: 'stale',
        outcomes: [{ hash: 125, status: 'stale', fields: ['$exists'] }],
      },
    });
    expect(batch.events.at(-1)!.action).toBe('stale');
    expect(f.read<Due>('schedule/due.json')!.entries).toEqual([]);
    expect(f.read<ScheduleIndex>('schedule/index.json')!.batches[0]).toMatchObject({
      status: 'draft',
      opId: null,
    });
  });

  it('R14: a tooltip created after the claim publishes and records an $exists conflict file', async () => {
    const f = await setup();
    const created = tip({ text: { en: entry('brand new') } }, 125);
    const theirs = tip({ text: { en: entry('someone else') } }, 125);
    await f.schedule([{ hash: 125, base: null, proposed: created }]);
    const cas = f.git.cas.bind(f.git);
    let saved = false;
    f.git.cas = (ref, old, next) => {
      if (ref === L && !saved) {
        saved = true;
        f.change(D, { 'tooltips/125.json': theirs });
      }
      cas(ref, old, next);
    };
    await f.pub.run();
    assertPublished(f);
    expect(f.read<Tooltip>('tooltips/125.json')).toEqual(theirs);
    expect(f.read<Tooltip>('live/tooltips/125.json')).toEqual(created);
    expect(f.read<ActivationConflict>('schedule/activation-conflicts/125.json')).toMatchObject({
      fields: ['$exists'],
      base: null,
      currentAtRecord: theirs,
    });
  });

  it('R15: failure returns to draft; a rebase and a reschedule with a new opId publish', async () => {
    const f = await setup();
    await f.schedule([{ hash: 123, base: tip(), proposed: proposedEn() }]);
    const moved = tip({ text: { en: entry('moved on', '2030-03-17T12:10:00.000Z') } });
    f.change(D, {
      'tooltips/123.json': moved,
      'live/tooltips/123.json': moved,
      'live/pushed.json': { 123: await publishableHash(moved) },
    });
    await f.pub.run();
    expect(f.batchFile()).toMatchObject({
      status: 'draft',
      result: { status: 'stale', outcomes: [{ hash: 123, status: 'stale', fields: ['text.en'] }] },
    });
    // Rebase (base = current) and schedule again with a new opId.
    const members = [{ hash: 123, base: moved, proposed: proposedEn() }];
    const draft = f.batchFile();
    f.change(D, {
      ...f.memberFiles(members),
      [`schedule/batches/${BATCH}/batch.json`]: {
        ...draft,
        status: 'scheduled',
        opId: OP2,
        notBefore: DUE,
        scheduledContentRevision: 1,
        revision: draft.revision + 1,
      },
      [paths(OP2).request]: await f.signedBatch(OP2, members, DUE, 1, '2030-03-17T17:58:00.000Z'),
      'schedule/due.json': {
        entries: [{ batchId: BATCH, opId: OP2, notBefore: DUE, claimed: false }],
      },
    });
    await f.pub.run();
    assertPublished(f, OP2);
    expect(f.read<{ result: { status: string } }>(paths(OP).log)!.result.status).toBe('stale');
  });

  it('R3 + R12: a RECORD conflict blocks a manual request queued behind the batch until resolved', async () => {
    const f = await setup();
    const base = tip({ text: { en: entry('reviewed'), de: entry('alt') } });
    f.change(D, {
      'tooltips/123.json': base,
      'live/tooltips/123.json': base,
      'live/pushed.json': { 123: await publishableHash(base) },
    });
    const at = '2030-03-17T12:00:00.000Z';
    const proposed = tip({
      text: { en: entry('batch en', at), de: entry('batch de', at) },
      custom: { name: 'Batch name', categoryId: 'perks' },
    });
    await f.schedule([{ hash: 123, base, proposed }]);
    // A manual request created after notBefore, still queued behind the batch.
    await f.push(PUSH1, [123], '2030-03-17T17:58:00.000Z');
    const theirs = tip({
      text: { en: entry('their en', '2030-03-17T17:59:00.000Z'), de: base.text.de },
    });
    const cas = f.git.cas.bind(f.git);
    let saved = false;
    f.git.cas = (ref, old, next) => {
      if (ref === L && !saved) {
        saved = true;
        f.change(D, { 'tooltips/123.json': theirs });
      }
      cas(ref, old, next);
    };
    await f.pub.run();
    f.git.cas = cas;
    assertPublished(f);
    expect(f.read<Tooltip>('tooltips/123.json')).toEqual(theirs);
    const conflict = f.read<ActivationConflict>('schedule/activation-conflicts/123.json')!;
    expect(conflict).toMatchObject({
      batchId: BATCH,
      opId: OP,
      fields: ['text.en'],
      changed: ['text.en', 'text.de', 'custom'],
      base,
      proposed,
      currentAtRecord: theirs,
    });
    expect(f.batchFile().result!.outcomes).toEqual([
      { hash: 123, status: 'conflict', fields: ['text.en'] },
    ]);
    expect(f.read<{ result: unknown }>(paths(PUSH1).log)!.result).toEqual({
      status: 'rejected',
      error: `${resolveActivationMessage}: 123`,
    });
    expect(f.receipts(PUSH1)).toHaveLength(0);
    // R12 through the core resolver on the RECORD file: an edit between RECORD and resolution
    // makes `custom` conflict too (409 lists it); clean fields (the German Y) take the batch value.
    const edited = { ...theirs, custom: { name: 'Their name', categoryId: 'perks' } };
    f.change(D, { 'tooltips/123.json': edited });
    const input = { base: conflict.base, proposed: conflict.proposed, current: edited };
    expect(resolveActivation({ ...input, choices: { 'text.en': 'upcoming' } })).toEqual({
      ok: false,
      missing: ['custom'],
    });
    expect(
      resolveActivation({
        ...input,
        choices: { 'text.en': 'current', 'text.de': 'current', custom: 'current' },
      }),
    ).toEqual({ ok: true, tooltip: edited });
    const resolved = resolveActivation({
      ...input,
      choices: { 'text.en': 'upcoming', custom: 'current' },
    });
    if (!resolved.ok || !resolved.tooltip) throw new Error('unresolved');
    expect(resolved.tooltip.text.en!.text).toBe('batch en');
    expect(resolved.tooltip.text.de!.text).toBe('batch de');
    expect(resolved.tooltip.custom).toEqual(edited.custom);
    // The Worker's resolve commit writes the tooltip and deletes the file together.
    f.change(D, { 'tooltips/123.json': resolved.tooltip }, [
      'schedule/activation-conflicts/123.json',
    ]);
    await f.push(PUSH2, [123], '2030-03-17T18:05:00.000Z');
    await f.pub.run();
    expect(f.receipts(PUSH2)).toHaveLength(1);
    expect(f.read<Tooltip>('live/tooltips/123.json')).toEqual(resolved.tooltip);
  });

  it('unrelated saved work stays out of live and stays in current (I3)', async () => {
    const f = await setup();
    const current = tip({ text: { en: entry('reviewed'), de: entry('unpublished de') } });
    f.change(D, { 'tooltips/123.json': current });
    await f.schedule([
      {
        hash: 123,
        base: current,
        proposed: {
          ...current,
          text: { ...current.text, en: entry('batch en', '2030-03-17T12:00:00.000Z') },
        },
      },
    ]);
    await f.pub.run();
    assertPublished(f);
    expect(f.read<Tooltip>('live/tooltips/123.json')!.text).toEqual({
      en: entry('batch en', '2030-03-17T12:00:00.000Z'),
    });
    expect(JSON.stringify(f.live().perks[123])).not.toContain('unpublished de');
    expect(f.read<Tooltip>('tooltips/123.json')!.text.de!.text).toBe('unpublished de');
  });

  it('unpublished fields are refused at the claim (root ruling), back to draft', async () => {
    const f = await setup();
    const current = tip({
      text: { en: entry('saved, not published', '2030-03-17T10:00:00.000Z') },
    });
    f.change(D, { 'tooltips/123.json': current });
    await f.schedule([{ hash: 123, base: current, proposed: proposedEn() }]);
    await f.pub.run();
    expect(f.receipts()).toHaveLength(0);
    expect(f.batchFile()).toMatchObject({
      status: 'draft',
      result: {
        status: 'stale',
        outcomes: [{ hash: 123, status: 'unpublished', fields: ['text.en'] }],
      },
    });
  });

  it('C3: pushed without a snapshot is stale and never falls back to current', async () => {
    const f = await setup();
    f.change(D, {}, ['live/tooltips/123.json']);
    await f.schedule([{ hash: 123, base: tip(), proposed: proposedEn() }]);
    await f.pub.run();
    expect(f.receipts()).toHaveLength(0);
    expect(f.batchFile().result).toMatchObject({
      status: 'stale',
      outcomes: [{ hash: 123, status: 'stale', reason: missingSnapshotReason }],
    });
  });

  it('C4: a never-published tooltip publishes the whole proposal', async () => {
    const f = await setup();
    const current = tip({ text: { en: entry('never published') }, associated: [] }, 124);
    f.change(D, { 'tooltips/124.json': current });
    const proposed = { ...current, text: { ...current.text, de: entry('neu') } };
    await f.schedule([{ hash: 124, base: current, proposed }]);
    await f.pub.run();
    assertPublished(f);
    expect(f.read<Tooltip>('live/tooltips/124.json')).toEqual(proposed);
  });

  it('R17: legacy and bungieSnapshot edits publish and activate', async () => {
    const f = await setup();
    const proposed = tip({
      bungieSnapshot: { description: 'Bungie text', snapshotAt: '2030-03-17T12:00:00.000Z' },
      legacy: { uploadToLive: true },
    });
    await f.schedule([{ hash: 123, base: tip(), proposed }]);
    await f.pub.run();
    assertPublished(f);
    for (const path of ['tooltips/123.json', 'live/tooltips/123.json'])
      expect(f.read<Tooltip>(path)).toMatchObject({
        bungieSnapshot: { description: 'Bungie text' },
        legacy: { uploadToLive: true },
      });
  });

  it('Q4: an upcoming translation replaces a newer current edit at activation', async () => {
    const f = await setup();
    await f.schedule([
      {
        hash: 123,
        base: tip(),
        proposed: tip({ text: { en: entry('reviewed'), fr: entry('à venir') } }),
      },
    ]);
    f.change(D, {
      'tooltips/123.json': tip({ text: { en: entry('reviewed'), fr: entry('courant') } }),
    });
    await f.pub.run();
    assertPublished(f);
    expect(f.read<Tooltip>('tooltips/123.json')!.text.fr!.text).toBe('à venir');
    expect(f.read('schedule/activation-conflicts/123.json')).toBeUndefined();
  });

  it('events past 200 move to events/<seq>.json in the same commit (root ruling)', async () => {
    const f = await setup();
    await f.schedule([{ hash: 123, base: tip(), proposed: proposedEn() }], { events: 199 });
    await f.pub.run();
    const { batch } = assertPublished(f);
    expect(batch.events).toHaveLength(200);
    expect(batch.events.at(-1)!.action).toBe('published');
    const archived = f.read<{ events: { action: string }[] }>(eventsArchive(BATCH, 0))!;
    expect(archived.events).toHaveLength(1);
    expect(archived.events[0].action).toBe('save');
  });

  it.each([
    ['fresh', 0],
    ['89 days old', 89],
    ['91 days old (English fallback)', 91],
  ] as const)(
    'CONSUMER OUTPUT: liveDescriptions.json is byte-identical to a manual publish (%s translation)',
    async (_, days) => {
      const enAt = '2030-03-17T12:00:00.000Z';
      const fr = {
        ...entry('traduction'),
        sourceUpdatedAt: new Date(Date.parse(enAt) - days * 86_400_000).toISOString(),
      };
      const base = tip({ text: { en: entry('reviewed', enAt), fr } });
      const proposed = tip({ text: { en: entry('batch en', enAt), fr }, associated: [124] });
      const seed = async (f: Fixture) =>
        f.change(D, {
          'tooltips/123.json': base,
          'tooltips/124.json': tip({}, 124),
          'live/tooltips/123.json': base,
          'live/pushed.json': { 123: await publishableHash(base) },
        });
      const batched = await setup();
      await seed(batched);
      await batched.schedule([{ hash: 123, base, proposed }]);
      await batched.pub.run();
      assertPublished(batched);
      const manual = await setup();
      await seed(manual);
      manual.change(D, { 'tooltips/123.json': batched.read<Tooltip>('tooltips/123.json') });
      await manual.push(PUSH1, [123]);
      await manual.pub.run();
      expect(manual.receipts(PUSH1)).toHaveLength(1);
      const bytes = (f: Fixture) => f.git.blob(f.git.tree(f.git.head(L)!)['liveDescriptions.json']);
      expect(bytes(batched)).toBe(bytes(manual));
      expect(batched.read('live/pushed.json')).toEqual(manual.read('live/pushed.json'));
      expect(bytes(batched).includes('traduction')).toBe(days <= 89);
    },
  );

  it('rejects a batch whose approved content changed, and a revoked requester', async () => {
    const f = await setup();
    await f.schedule([{ hash: 123, base: tip(), proposed: proposedEn() }]);
    const path = `schedule/batches/${BATCH}/tooltips/123.json`;
    f.change(D, { [path]: { ...f.read<object>(path), proposed: proposedEn('tampered') } });
    await f.pub.run();
    expect(f.batchFile().result).toMatchObject({
      status: 'rejected',
      error: 'Batch content differs from what was approved',
    });
    const g = await setup();
    await g.schedule([{ hash: 123, base: tip(), proposed: proposedEn() }]);
    g.change(D, { 'config/permissions.json': { users: {} } });
    await g.pub.run();
    expect(g.batchFile().result).toMatchObject({
      status: 'rejected',
      error: expect.stringContaining('Requester revoked'),
    });
    expect(g.receipts()).toHaveLength(0);
  });

  it('the bundled runtime (lazy batch schema import) drains a batch and declares scheduledBatches', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'batch-dist-'));
    roots.push(dist);
    execFileSync(process.execPath, ['scripts/publisher/build.mjs'], {
      stdio: 'pipe',
      env: { ...process.env, PUBLISHER_DIST: dist },
    });
    const pin = JSON.parse(readFileSync(join(dist, 'PIN'), 'utf8'));
    expect(pin.capabilities).toEqual(['elementTags', 'sandboxPointers', 'scheduledBatches']);
    const f = await setup();
    // The dry-run CLI runs on the real clock: schedule a batch that is long due.
    await f.schedule([{ hash: 123, base: tip(), proposed: proposedEn() }], {
      notBefore: '2026-01-01T00:00:00.000Z',
      createdAt: '2025-12-31T00:00:00.000Z',
    });
    const dir = mkdtempSync(join(tmpdir(), 'batch-cli-'));
    roots.push(dir);
    // Functions do not serialize: JSON drops now and backoff, as the CLI expects.
    writeFileSync(join(dir, 'config.json'), JSON.stringify(f.options));
    execFileSync(
      process.execPath,
      [
        join(dist, 'publisher.mjs'),
        '--dry-run',
        (f.git as LocalRepository).path,
        join(dir, 'config.json'),
        join(dir, 'out'),
      ],
      { stdio: 'pipe' },
    );
    const result = JSON.parse(readFileSync(join(dir, 'out', 'result.json'), 'utf8'));
    expect(result.error).toBeNull();
    const replay = join(dir, 'replay.git');
    execFileSync(
      'git',
      ['clone', '--mirror', join(dir, 'out', 'would-be-commits.bundle'), replay],
      { stdio: 'pipe' },
    );
    const batch = JSON.parse(
      execFileSync(
        'git',
        ['--git-dir', replay, 'show', `${result.dataHead}:schedule/batches/${BATCH}/batch.json`],
        { encoding: 'utf8' },
      ),
    );
    expect(batch.status).toBe('published');
  });
});
