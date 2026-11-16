import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { exportLegacy, publishableHash, stableStringify, type Tooltip } from '@clarity/core';
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
import { SchedulePreparer, SCHEDULE_GLOBALS_UNSUPPORTED } from '../schedule-prepare/prepare.js';
import { globalTreeOid } from './globals.js';
import { LocalRepository, RefRace, type Tree, type Repository } from './git.js';
import { Publisher, paths, type Options } from './publisher.js';
import { json } from './batch.js';
import { stampUploads } from '../../apps/worker/src/stamp.js';
import { runPipeline } from './pipeline.js';

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
  return { git, pub, prep, options, read, change, batch, request, admit, base, proposed, clock };
}

describe('offline schedule preparation', () => {
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
    expect(f.request().reasons?.[0].reason).toBe(SCHEDULE_GLOBALS_UNSUPPORTED);
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
