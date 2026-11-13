import { Fixture, makePrivateKey } from '../../apps/worker/test/fixture.js';
import { seedPushGroups, pushTime } from '../../apps/worker/test/push-fixture.js';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RemoteRepository } from './remote.js';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  stableStringify,
  baseEnhancedPublishMessage,
  setBonusHoldMessage,
  publishIntentDigest,
  publishableHash,
  classifyPublishIntent,
  validatePublishBody,
  type PublishPayload,
  type Tooltip,
} from '../../packages/core/src/index.js';
import { LocalRepository, RefRace, type Tree } from './git.js';
import { Publisher, paths, type Options } from './publisher.js';
import { createRequest } from './request.js';
import { runPipeline } from './pipeline.js';
// Configure before registering the Git subprocess tests (Windows runs exceed 20 seconds).
vi.setConfig({ testTimeout: 300_000 });

describe.each(['simulator', 'remote'] as const)('%s repository contract', (transport) => {
  it.each([false, true])(
    'pipeline bundles real heads, isolates publish writes, and catches up (bad key=%s)',
    async (badKey) => {
      const f = await setup();
      const repo = 'Database-Clarity/Live-Clarity-Database';
      await f.request(A, [123], undefined, { repo });
      const originalLive = f.git.head(L);
      const checkoutRoot = mkdtempSync(join(tmpdir(), 'pipeline-checkout-'));
      const checkout = join(checkoutRoot, 'checkout');
      roots.push(checkoutRoot);
      execFileSync('git', ['clone', '--branch', 'editor-data', '--', f.upstream, checkout], {
        stdio: 'pipe',
      });
      let latest = f.git.head(D)!;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          latest = f.change(D, { 'tooltips/123.json': { ...f.tooltip, associated: [456] } });
          return new Response(
            JSON.stringify({
              algorithm: 'Ed25519',
              publicKey: f.options.publicKey,
              fingerprint: badKey ? 'bad' : f.options.keyFingerprint,
            }),
          );
        }),
      );
      const out = join(checkout, 'artifacts');
      const task = runPipeline(
        checkout,
        { ...f.options, repo, keyEndpoint: 'https://worker.invalid/publish/key' },
        out,
      );
      if (badKey) await expect(task).rejects.toThrow('fingerprint');
      else await task;
      expect(f.git.head(D)).toBe(latest);
      expect(f.git.head(L)).toBe(originalLive);
      expect(f.git.tree(latest)[paths(A).request]).toBeDefined();
      expect(f.git.tree(latest)[paths(A).log]).toBeUndefined();
      expect(f.git.head(paths(A).candidate)).toBeUndefined();
      const bundle = f.pub.read<{
        sourceCommit: string;
        publishQueue: {
          opId: string;
          requester: { id: number; login: string };
          hashes: number[];
          createdAt: string;
        }[];
      }>(f.git.tree(f.git.head('refs/heads/editor-data-bundle')!), 'bundle.json')!;
      expect(bundle.sourceCommit).toBe(latest);
      expect(bundle.publishQueue.map((p) => p.opId)).toEqual([A]);
      expect(Object.keys(bundle.publishQueue[0]).sort()).toEqual([
        'createdAt',
        'hashes',
        'opId',
        'requester',
      ]);
      expect(bundle.publishQueue[0].hashes).toEqual([123]);
      expect(bundle.publishQueue[0].requester.id).toBeTypeOf('number');
      const report = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'));
      expect(report.publishWritesEnabled).toBe(false);
      expect(report.reports).toHaveLength(2);
      const manifest = JSON.parse(readFileSync(join(out, 'would-be-commits.json'), 'utf8'));
      expect(manifest.commits > 0).toBe(!badKey);
      expect(existsSync(join(out, 'would-be-commits.bundle'))).toBe(!badKey);
      if (badKey) return;
      const artifact = join(checkout, 'inspect.git');
      execFileSync('git', ['clone', '--bare', f.upstream, artifact], {
        stdio: 'pipe',
      });
      execFileSync(
        'git',
        [
          '--git-dir',
          artifact,
          'fetch',
          join(out, 'would-be-commits.bundle'),
          '+refs/heads/*:refs/heads/*',
        ],
        { stdio: 'pipe' },
      );
      const simulatedLog = execFileSync(
        'git',
        ['--git-dir', artifact, 'ls-tree', '-r', 'refs/heads/editor-data'],
        { encoding: 'utf8' },
      );
      expect(simulatedLog.includes(paths(A).log)).toBe(!badKey);
    },
  );

  it('invalid bundle inputs preserve the prior bundle, including the remote pipeline bundle', async () => {
    const f = await setup();
    f.pub.bundle();
    const ref = 'refs/heads/editor-data-bundle',
      old = f.git.head(ref);
    const base = f.git.tree(f.git.head(D)!);
    const invalid = [
      { 'tooltips/123.json': { ...f.tooltip, hash: 234 } },
      { 'tooltips/123.json': { hash: 123, text: 'bad schema' } },
      { 'tooltips/0123.json': f.tooltip },
      { 'tooltips/nested/123.json': f.tooltip },
      { 'config/permissions.json': { users: [] } },
      { 'live/pushed.json': { 123: 'invalid digest' } },
    ];
    for (const files of invalid) {
      const tree = { ...base };
      for (const [path, value] of Object.entries(files))
        tree[path] = f.git.writeBlob(encode(value));
      const h = f.git.head(D)!;
      f.git.cas(D, h, f.git.commit(h, tree, 'Invalid bundle fixture'));
      expect(() => f.pub.bundle()).toThrow();
      expect(f.git.head(ref)).toBe(old);
    }
    const empty = { ...base };
    delete empty['tooltips/123.json'];
    f.git.cas(D, f.git.head(D), f.git.commit(f.git.head(D), empty, 'Empty tooltips'));
    expect(() => f.pub.bundle()).toThrow('No tooltips');
    expect(f.git.head(ref)).toBe(old);
    const checkoutRoot = mkdtempSync(join(tmpdir(), 'invalid-pipeline-'));
    roots.push(checkoutRoot);
    const checkout = join(checkoutRoot, 'checkout');
    execFileSync('git', ['clone', '--branch', 'editor-data', f.upstream, checkout], {
      stdio: 'pipe',
    });
    vi.stubGlobal('fetch', vi.fn());
    await expect(
      runPipeline(
        checkout,
        {
          ...f.options,
          repo: 'Database-Clarity/Live-Clarity-Database',
          keyEndpoint: 'https://worker.invalid/publish/key',
        },
        join(checkoutRoot, 'artifacts'),
      ),
    ).rejects.toThrow('No tooltips');
    expect(f.git.head(ref)).toBe(old);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a correctly signed link-only request without live or push-marker writes', async () => {
    const f = await setup();
    const empty = { ...f.tooltip, text: {} };
    f.change(D, { 'tooltips/123.json': empty });
    await f.request(A, [123], { 123: await publishableHash(empty) });
    const live = f.git.head(L);
    await f.pub.run();
    expect(f.git.head(L)).toBe(live);
    const tree = f.git.tree(f.git.head(D)!);
    expect(f.pub.read(tree, paths(A).log)).toMatchObject({ result: { status: 'rejected' } });
    expect(f.pub.read(tree, 'live/pushed.json')).toEqual({});
    expect(tree['live/tooltips/123.json']).toBeUndefined();
  });

  it('publishes an intentionally emptied reserved global library', async () => {
    const f = await setup();
    const global: Tooltip = {
      hash: 2,
      text: {},
      associated: [],
      custom: { name: 'Variables', categoryId: 'global' },
    };
    f.change(D, { 'tooltips/2.json': global });
    await f.request(A, [2], { 2: await publishableHash(global) });
    await f.pub.run();
    const live = f.git.tree(f.git.head(L)!);
    expect(f.pub.read(live, 'liveDescriptions.json')).toMatchObject({
      perks: { 2: { editor: {} } },
    });
    expect(f.pub.read(f.git.tree(f.git.head(D)!), paths(A).log)).toMatchObject({
      result: { status: 'done' },
    });
  });

  it.each([125, 456])(
    'rejects association-race after target %s becomes text-less',
    async (target) => {
      const f = await setup();
      f.options.aliases = { 456: { to: 125, kind: 'frame' } };
      const root = { ...f.tooltip, associated: [target] };
      const associated: Tooltip = {
        ...f.tooltip,
        hash: 125,
        custom: { name: 'Associated', categoryId: 'perk' },
      };
      f.change(D, { 'tooltips/123.json': root, 'tooltips/125.json': associated });
      await f.request(A, [123], { 123: await publishableHash(root, f.options.aliases) });
      f.change(D, { 'tooltips/125.json': { ...associated, text: {} } });
      const live = f.git.head(L);
      await f.pub.run();
      expect(f.git.head(L)).toBe(live);
      const tree = f.git.tree(f.git.head(D)!);
      expect(f.pub.read(tree, paths(A).log)).toMatchObject({ result: { status: 'rejected' } });
      expect(f.pub.read(tree, 'live/pushed.json')).toEqual({});
    },
  );

  it.each(['native', 'transitive'] as const)(
    'checks only direct associations, ignoring an unselected target draft (%s)',
    async (mode) => {
      const f = await setup();
      const published = {
        hash: 125,
        editor: { en: { main: 'Published', secondary: 'Published' } },
      };
      f.change(L, { 'liveDescriptions.json': { perks: { 125: published }, databaseSettings: {} } });
      const root = { ...f.tooltip, associated: [125] };
      f.change(D, {
        'tooltips/123.json': root,
        'tooltips/125.json': {
          ...f.tooltip,
          hash: 125,
          associated: mode === 'transitive' ? [126] : [],
          text: {
            en: {
              ...f.tooltip.text.en!,
              text: mode === 'native' ? '{{base|enhanced}}' : 'Written draft',
            },
          },
        },
        'tooltips/126.json': { ...f.tooltip, hash: 126, text: {} },
      });
      await f.request(A, [123], { 123: await publishableHash(root) });
      await f.pub.run();
      const live = f.pub.read<{ perks: Record<string, unknown> }>(
        f.git.tree(f.git.head(L)!),
        'liveDescriptions.json',
      )!;
      expect(live.perks[125]).toEqual(published);
      expect(f.pub.read(f.git.tree(f.git.head(D)!), paths(A).log)).toMatchObject({
        result: { status: 'done' },
      });
    },
  );

  const A = '01K95H00000000000000000001',
    B = '01K95H00000000000000000002';
  const D = 'refs/heads/editor-data',
    L = 'refs/heads/converter-v2-test';
  const encode = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
  const roots: string[] = [];
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  async function setup() {
    const root = mkdtempSync(join(tmpdir(), 'publisher-fixture-'));
    roots.push(root);
    execFileSync('git', ['init', '--bare', root], { stdio: 'pipe' });
    execFileSync('git', ['--git-dir', root, 'config', 'publisher.simulator', 'true']);
    const cache = mkdtempSync(join(tmpdir(), 'publisher-cache-'));
    roots.push(cache);
    execFileSync('git', ['init', '--bare', cache], { stdio: 'pipe' });
    execFileSync('git', ['--git-dir', cache, 'config', 'publisher.simulator', 'true']);
    const git =
      transport === 'simulator'
        ? new LocalRepository(root)
        : new RemoteRepository(cache, { fileUrl: pathToFileURL(root).href });
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const options: Options = {
      repo: 'test/local',
      dataBranch: 'editor-data',
      liveBranch: 'converter-v2-test',
      publicKey,
      keyFingerprint: createHash('sha256')
        .update(keys.publicKey.export({ type: 'spki', format: 'der' }))
        .digest('hex'),
      publisherSha: 'a'.repeat(40),
      generatorSha: 'b'.repeat(40),
      aliases: {},
      facts: { 123: { name: 'Thing', type: 'perk' } },
      now: () => pushTime,
      runUrl: 'local://fixture',
      backoff: async () => {},
    };
    const pub = new Publisher(git, options);
    const tooltip: Tooltip = {
      hash: 123,
      text: { en: { text: 'reviewed', updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'alice' } },
      associated: [],
    };
    const initial: Tree = {};
    for (const [p, v] of Object.entries({
      'config/permissions.json': { users: { '1': { login: 'alice', role: 'editor' } } },
      'tooltips/123.json': tooltip,
      'live/pushed.json': {},
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
    function change(ref: string, files: Record<string, unknown>) {
      const h = git.head(ref)!,
        tree = git.tree(h);
      for (const [p, v] of Object.entries(files)) tree[p] = git.writeBlob(encode(v));
      const c = git.commit(h, tree, 'Save fixture');
      git.cas(ref, h, c);
      return c;
    }
    async function request(
      id = A,
      hashes = [123],
      expected?: Record<string, string>,
      overrides: Partial<PublishPayload> = {},
    ) {
      const payload: PublishPayload = {
        opId: id,
        kind: 'push',
        repo: options.repo,
        dataBranch: options.dataBranch,
        liveBranch: options.liveBranch,
        requester: { id: 1, login: 'alice' },
        createdAt: '2026-11-03T12:00:00.000Z',
        hashes,
        expected: expected ?? { 123: await publishableHash(tooltip, options.aliases) },
        intentDigest: '0'.repeat(64),
        ...overrides,
      };
      payload.intentDigest = await publishIntentDigest(payload);
      const bytes = stableStringify(payload),
        envelope = {
          payload: bytes,
          sig: sign(null, Buffer.from(bytes), keys.privateKey).toString('base64'),
        };
      change(D, { [paths(id).request]: envelope });
      return { payload, envelope };
    }
    function assertDone(id = A) {
      const t = git.tree(git.head(D)!);
      expect(t[paths(id).request]).toBeUndefined();
      const log = pub.read<{
        candidateCommit: string;
        liveCommit: string;
        result: { status: string };
      }>(t, paths(id).log)!;
      expect(log.result.status).toMatch(/done|unchanged/);
      expect(git.ancestor(log.liveCommit, git.head(L)!)).toBe(true);
      const receipt = pub.receipt(log.candidateCommit, id)!;
      expect(receipt.opId).toBe(id);
      for (const e of receipt.entries) {
        expect(t[`live/tooltips/${e.hash}.json`]).toBe(e.tooltipBlob);
        expect(pub.read<Record<string, string>>(t, 'live/pushed.json')![e.hash]).toBe(e.digest);
      }
      const introduced = git
        .history(git.head(L)!)
        .filter(
          (c, i, all) =>
            git.tree(c)[paths(id).receipt] && (!i || !git.tree(all[i - 1])[paths(id).receipt]),
        );
      expect(introduced).toHaveLength(1);
      expect(Object.keys(t).filter((p) => p === paths(id).log)).toHaveLength(1);
    }
    return {
      upstream: root,
      git,
      pub,
      options,
      tooltip,
      change,
      request,
      assertDone,
      sign: (p: string) => sign(null, Buffer.from(p), keys.privateKey).toString('base64'),
    };
  }

  it('publishes and records exactly the reviewed blobs', async () => {
    const f = await setup();
    await f.request();
    await f.pub.run();
    f.assertDone();
  });
  it('rejects native pairs hidden by stale translations and continues the publish queue', async () => {
    const f = await setup();
    const current: Tooltip = {
      ...f.tooltip,
      text: {
        en: { ...f.tooltip.text.en!, updatedAt: '2026-10-01T00:00:00Z' },
        fr: {
          text: 'old translation',
          updatedAt: '2026-01-01T00:00:00Z',
          updatedBy: 'alice',
          sourceUpdatedAt: '2026-01-01T00:00:00Z',
        },
      },
    };
    const edited = structuredClone(current);
    edited.text.fr!.text = '{{un}{deux}}';
    expect(await publishableHash(edited)).toBe(await publishableHash(current));
    f.change(D, { 'tooltips/123.json': current });
    await f.request(A, [123], { 123: await publishableHash(current) });
    f.change(D, { 'tooltips/123.json': edited });
    const live = f.git.head(L);
    await f.pub.run();
    expect(f.git.head(L)).toBe(live);
    const tree = f.git.tree(f.git.head(D)!);
    expect(tree[paths(A).request]).toBeUndefined();
    expect(f.pub.read(tree, paths(A).log)).toMatchObject({
      result: { status: 'rejected', error: baseEnhancedPublishMessage },
    });
    f.change(D, { 'tooltips/123.json': f.tooltip });
    await f.request(B);
    await f.pub.run();
    f.assertDone(B);
  });

  it('pinned runtime refuses native pairs and leaves later requests runnable', async () => {
    const f = await setup();
    const paired = { ...f.tooltip, text: { en: { ...f.tooltip.text.en!, text: '{{a}{b}}' } } };
    f.change(D, { 'tooltips/123.json': paired });
    await f.request(A, [123], { 123: await publishableHash(paired) });
    const plain = { ...f.tooltip, hash: 124 };
    f.options.facts[124] = { name: 'Plain', type: 'perk' };
    f.change(D, { 'tooltips/124.json': plain });
    await f.request(B, [124], { 124: await publishableHash(plain) });
    const root = mkdtempSync(join(tmpdir(), 'native-pinned-runtime-'));
    roots.push(root);
    const config = join(root, 'config.json'),
      out = join(root, 'artifacts'),
      replay = join(root, 'replay.git');
    writeFileSync(config, JSON.stringify(f.options));
    execFileSync(
      process.execPath,
      [
        resolve('scripts/publisher/template/.publisher/publisher.mjs'),
        '--dry-run',
        f.upstream,
        config,
        out,
      ],
      { stdio: 'pipe' },
    );
    const result = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'));
    expect(result.error).toBeNull();
    expect(result.liveHead).not.toBe(f.git.head(L));
    execFileSync('git', ['clone', '--mirror', join(out, 'would-be-commits.bundle'), replay], {
      stdio: 'pipe',
    });
    const log = JSON.parse(
      execFileSync('git', ['--git-dir', replay, 'show', `${result.dataHead}:${paths(A).log}`], {
        encoding: 'utf8',
      }),
    );
    expect(log.result).toMatchObject({ status: 'rejected', error: baseEnhancedPublishMessage });
    const nextLog = JSON.parse(
      execFileSync('git', ['--git-dir', replay, 'show', `${result.dataHead}:${paths(B).log}`], {
        encoding: 'utf8',
      }),
    );
    expect(nextLog.result.status).toMatch(/done|unchanged/);
    const live = JSON.parse(
      execFileSync(
        'git',
        ['--git-dir', replay, 'show', `${result.liveHead}:liveDescriptions.json`],
        { encoding: 'utf8' },
      ),
    );
    expect(live.perks[123]).toBeUndefined();
    expect(live.perks[124].editor.en.main).toBe('reviewed');
    expect(() =>
      execFileSync('git', ['--git-dir', replay, 'show', `${result.dataHead}:${paths(A).request}`], {
        stdio: 'pipe',
      }),
    ).toThrow();
  });

  it('malformed request JSON cannot block receipt recovery or later valid requests', async () => {
    const f = await setup();
    await f.request();
    const cas = f.git.cas.bind(f.git);
    f.git.cas = (ref, old, next) => {
      if (ref === D) throw new Error('RECORD unavailable');
      cas(ref, old, next);
    };
    await expect(f.pub.run()).rejects.toThrow('RECORD unavailable');
    const landed = f.git.head(L);
    f.git.cas = cas;
    await f.request(B);
    const h = f.git.head(D)!,
      tree = f.git.tree(h);
    tree[paths(B).request] = f.git.writeBlob('{malformed');
    f.git.cas(D, h, f.git.commit(h, tree, 'Inject malformed envelope'));
    const c = '01K95H00000000000000000003';
    await f.request(c);
    f.pub.bundle();
    const bundle = f.pub.read<{ publishQueue: unknown[] }>(
      f.git.tree(f.git.head('refs/heads/editor-data-bundle')!),
      'bundle.json',
    )!;
    expect(bundle.publishQueue).toContainEqual({ opId: B, invalid: true });
    await f.pub.run();
    f.assertDone(A);
    f.assertDone(c);
    expect(f.git.ancestor(landed!, f.git.head(L)!)).toBe(true);
    expect(f.pub.read(f.git.tree(f.git.head(D)!), paths(B).log)).toMatchObject({
      result: { status: 'rejected' },
    });
    expect(f.pub.receipt(f.git.head(L)!, B)).toBeUndefined();
  });
  it('records a successful sixth push immediately, with only five backoffs', async () => {
    const f = await setup();
    await f.request();
    const cas = f.git.cas.bind(f.git);
    let pushes = 0,
      backoffs = 0;
    f.options.backoff = async () => {
      backoffs++;
    };
    f.git.cas = (ref, old, next) => {
      if (ref === L && ++pushes < 6) throw new Error('disconnect');
      cas(ref, old, next);
    };
    await f.pub.run();
    f.assertDone();
    expect(pushes).toBe(6);
    expect(backoffs).toBe(5);
    expect(f.git.head(paths(A).candidate)).toBeUndefined();
  });
  it.each([false, true])(
    'RECORD closes a changed request blob as duplicate/conflict (conflict=%s)',
    async (conflict) => {
      const f = await setup();
      const { envelope, payload } = await f.request();
      const cas = f.git.cas.bind(f.git);
      let swapped = false;
      f.git.cas = (ref, old, next) => {
        cas(ref, old, next);
        if (ref === L && !swapped) {
          swapped = true;
          f.change(D, {
            [paths(A).request]: {
              ...envelope,
              payload: stableStringify({
                ...payload,
                createdAt: '2027-01-01T00:00:00.000Z',
                intentDigest: conflict ? 'f'.repeat(64) : payload.intentDigest,
              }),
            },
          });
        }
      };
      await f.pub.run();
      f.assertDone();
      expect(
        f.pub.read(f.git.tree(f.git.head(D)!), paths(A).log.replace('.json', '.dup-1.json')),
      ).toMatchObject({ status: conflict ? 'conflict' : 'duplicate' });
    },
  );
  it('pinned runtime accepts additive partners and rejects invalid permissions without source writes', async () => {
    const f = await setup();
    const users = { '1': { login: 'alice', role: 'editor' } };
    const partner = { login: 'bob', projects: ['dim', 'clarity'] };
    const cases = [
      { permissions: { users }, valid: true },
      { permissions: { users, partners: {} }, valid: true },
      { permissions: { users, partners: { '2': partner } }, valid: true },
      { permissions: { users: {}, partners: { '2': partner } }, valid: true },
      { permissions: { users, partners: { '02': partner } }, valid: false },
      { permissions: { users, partners: { '2': { ...partner, projects: [] } } }, valid: false },
      {
        permissions: { users, partners: { '2': { ...partner, projects: ['dim', 'dim'] } } },
        valid: false,
      },
      {
        permissions: { users, partners: { '2': { ...partner, projects: ['../dim'] } } },
        valid: false,
      },
      { permissions: { users, partners: { '2': { ...partner, login: '' } } }, valid: false },
      { permissions: { users, partners: { '2': { ...partner, role: 'editor' } } }, valid: false },
      { permissions: { users, extra: true }, valid: false },
      { permissions: { users: { '1': { login: 'alice', role: 'partner' } } }, valid: false },
    ];
    const root = mkdtempSync(join(tmpdir(), 'publisher-permissions-cli-'));
    roots.push(root);
    const config = join(root, 'config.json');
    writeFileSync(config, JSON.stringify(f.options));
    for (const [index, { permissions, valid }] of cases.entries()) {
      f.change(D, { 'config/permissions.json': permissions });
      const before = f.git.git(['show-ref']);
      const out = join(root, `case-${index}`);
      const run = () =>
        execFileSync(
          process.execPath,
          [
            'scripts/publisher/template/.publisher/publisher.mjs',
            '--dry-run',
            f.upstream,
            config,
            out,
          ],
          { stdio: 'pipe' },
        );
      if (valid) expect(run).not.toThrow();
      else expect(run).toThrow();
      const result = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'));
      expect(result).toMatchObject({ dryRun: true, writesEnabled: false });
      if (valid) expect(result.error).toBeNull();
      else {
        expect(JSON.parse(result.error)).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: expect.any(String) })]),
        );
      }
      expect(f.git.git(['show-ref'])).toBe(before);
    }
  });
  it.each(['set-bonus', 'link-only'] as const)(
    'plain-node dry-run CLI emits artifacts and never changes its input refs (%s)',
    async (kind) => {
      const f = await setup();
      if (kind === 'set-bonus') f.options.facts[123].type = 'armor-set-bonus';
      f.change(D, {
        'tooltips/123.json': {
          ...f.tooltip,
          custom: { name: 'Set bonus', categoryId: 'armor-set-bonus' },
          compendium: {
            gid: '1287885342',
            rowKey: 'set-bonus',
            snapshot: { plain: 'Set bonus', runs: [{ text: 'Set bonus' }] },
            snapshotAt: '2026-11-03T00:00:00Z',
            setBonusPieces: 2,
          },
        },
      });
      if (kind === 'link-only') f.change(D, { 'tooltips/123.json': { ...f.tooltip, text: {} } });
      const currentTooltip = f.pub.read<Tooltip>(f.git.tree(f.git.head(D)!), 'tooltips/123.json')!;
      await f.request(A, [123], { 123: await publishableHash(currentTooltip, f.options.aliases) });
      const before = f.git.git(['show-ref']);
      const root = mkdtempSync(join(tmpdir(), 'publisher-cli-'));
      roots.push(root);
      writeFileSync(join(root, 'config.json'), JSON.stringify(f.options));
      execFileSync(process.execPath, ['scripts/publisher/build.mjs'], { stdio: 'pipe' });
      for (const runtime of [
        'scripts/publisher/dist/publisher.mjs',
        'scripts/publisher/template/.publisher/publisher.mjs',
      ]) {
        execFileSync(
          process.execPath,
          [runtime, '--dry-run', f.upstream, join(root, 'config.json'), join(root, 'out')],
          { stdio: 'pipe' },
        );
        expect(f.git.git(['show-ref'])).toBe(before);
        expect(JSON.parse(readFileSync(join(root, 'out', 'result.json'), 'utf8'))).toMatchObject({
          dryRun: true,
          writesEnabled: false,
          error: null,
        });
        expect(readFileSync(join(root, 'out', 'would-be-commits.bundle')).length).toBeGreaterThan(
          0,
        );
        const result = JSON.parse(readFileSync(join(root, 'out', 'result.json'), 'utf8'));
        expect(result.liveHead).toBe(f.git.head(L));
        const replay = join(root, runtime.includes('/dist/') ? 'dist.git' : 'template.git');
        execFileSync(
          'git',
          ['clone', '--mirror', join(root, 'out', 'would-be-commits.bundle'), replay],
          {
            stdio: 'pipe',
          },
        );
        const readResult = (path: string) =>
          JSON.parse(
            execFileSync('git', ['--git-dir', replay, 'show', `${result.dataHead}:${path}`], {
              encoding: 'utf8',
            }),
          );
        expect(readResult(paths(A).log)).toMatchObject({
          result: {
            status: 'rejected',
            error: kind === 'set-bonus' ? setBonusHoldMessage : 'Tooltip has no text to publish',
          },
        });
        expect(readResult('live/pushed.json')).toEqual({});
      }
    },
  );
  it('exhausted unresolved publication blocks later work and resumes the exact candidate', async () => {
    const f = await setup();
    await f.request();
    await f.request(B);
    const cas = f.git.cas.bind(f.git);
    f.git.cas = (ref, old, next) => {
      if (ref === L) throw new Error('disconnect');
      cas(ref, old, next);
    };
    await expect(f.pub.run()).rejects.toThrow('Publish unresolved');
    const c = f.git.head(paths(A).candidate);
    expect(c).toBeTruthy();
    expect(f.git.head(paths(B).candidate)).toBeUndefined();
    f.git.cas = cas;
    await f.pub.run();
    f.assertDone();
    f.assertDone(B);
    expect(
      f.pub.read<{ candidateCommit: string }>(f.git.tree(f.git.head(D)!), paths(A).log)!
        .candidateCommit,
    ).toBe(c);
  });
  it.each(['landed', 'not-landed', 'delayed-success'])(
    'reconciles ambiguous push: %s',
    async (mode) => {
      const f = await setup();
      await f.request();
      const cas = f.git.cas.bind(f.git);
      let pending: (() => void) | undefined,
        intercepted = false;
      f.git.cas = (ref, old, next) => {
        if (ref === L && !intercepted) {
          intercepted = true;
          if (mode === 'landed') cas(ref, old, next);
          if (mode === 'delayed-success') pending = () => cas(ref, old, next);
          throw new Error('Transport timeout');
        }
        if (ref === L && pending) {
          pending();
          pending = undefined;
        }
        cas(ref, old, next);
      };
      await f.pub.run();
      expect(intercepted).toBe(true);
      f.assertDone();
    },
  );
  it.each([true, false])(
    'runner crash with ambiguous push (landed=%s), unconditional recovery after revocation',
    async (landed) => {
      const f = await setup();
      await f.request();
      const cas = f.git.cas.bind(f.git);
      f.git.cas = (ref, old, next) => {
        if (ref === L) {
          if (landed) cas(ref, old, next);
          throw new Error('disconnect');
        }
        cas(ref, old, next);
      };
      f.options.backoff = async () => {
        throw new Error('runner crash');
      };
      await expect(f.pub.run()).rejects.toThrow('runner crash');
      const candidate = f.git.head(paths(A).candidate)!;
      expect(candidate).toBeTruthy();
      f.git.cas = cas;
      f.options.backoff = undefined;
      f.change(D, { 'config/permissions.json': { users: {} } });
      f.options.now = () => pushTime + 999999999;
      await f.pub.run();
      f.assertDone();
      expect(
        f.pub.read<{ candidateCommit: string }>(f.git.tree(f.git.head(D)!), paths(A).log)!
          .candidateCommit,
      ).toBe(candidate);
    },
  );
  it.each(['ambiguous', 'exists'])('uses persisted candidate: %s', async (mode) => {
    const f = await setup();
    await f.request();
    const cas = f.git.cas.bind(f.git);
    let stored = '';
    let deadRun = mode === 'exists';
    f.git.cas = (ref, old, next) => {
      if (ref === paths(A).candidate && !stored) {
        stored = next!;
        cas(ref, old, next);
        throw new Error(mode);
      }
      if (ref === L && deadRun) throw new Error('disconnect before LIVE update');
      cas(ref, old, next);
    };
    if (mode === 'exists') {
      f.options.backoff = async () => {
        throw new Error('crash');
      };
      await expect(f.pub.run()).rejects.toThrow();
      expect(f.pub.receipt(f.git.head(L)!, A)).toBeUndefined();
      expect(f.git.head(paths(A).candidate)).toBe(stored);
      deadRun = false;
      f.options.backoff = undefined;
    }
    await f.pub.run();
    f.assertDone();
    expect(
      f.pub.read<{ candidateCommit: string }>(f.git.tree(f.git.head(D)!), paths(A).log)!
        .candidateCommit,
    ).toBe(stored);
  });
  it('stops for an existing candidate whose receipt does not match', async () => {
    const f = await setup();
    await f.request();
    f.git.cas(paths(A).candidate, undefined, f.git.head(L));
    const before = f.git.head(L);
    await expect(f.pub.run()).rejects.toThrow('Candidate mismatch');
    expect(f.git.head(L)).toBe(before);
  });
  it('rebases only after LIVE advances and rejects a late original push', async () => {
    const f = await setup();
    await f.request();
    const cas = f.git.cas.bind(f.git);
    let delayed: (() => void) | undefined;
    f.git.cas = (ref, old, next) => {
      if (ref === L && !delayed) {
        delayed = () => cas(ref, old, next);
        f.change(L, { 'other.json': { other: true } });
        throw new Error('timeout');
      }
      cas(ref, old, next);
    };
    await f.pub.run();
    f.assertDone();
    expect(() => delayed!()).toThrow(RefRace);
    expect(f.git.tree(f.git.head(L)!)['other.json']).toBeTruthy();
  });
  it('RECORD ref race preserves save S2 but records S blobs and digests', async () => {
    const f = await setup();
    await f.request();
    const source = f.git.head(D)!;
    const cas = f.git.cas.bind(f.git);
    let raced = false;
    f.git.cas = (ref, old, next) => {
      if (ref === D && !raced) {
        raced = true;
        f.change(D, { 'tooltips/123.json': { ...f.tooltip, associated: [456] } });
      }
      cas(ref, old, next);
    };
    await f.pub.run();
    f.assertDone();
    const tree = f.git.tree(f.git.head(D)!);
    expect(tree['live/tooltips/123.json']).toBe(f.git.tree(source)['tooltips/123.json']);
    expect(tree['tooltips/123.json']).not.toBe(tree['live/tooltips/123.json']);
  });
  it('failed first RECORD prevents the second live write, then recovers both in committed order', async () => {
    const f = await setup();
    await f.request(B);
    await f.request(A);
    expect(f.pub.queue(f.git.head(D)!)).toEqual([B, A]);
    const cas = f.git.cas.bind(f.git);
    f.git.cas = (ref, old, next) => {
      if (ref === D) throw new Error('record unavailable');
      cas(ref, old, next);
    };
    await expect(f.pub.run()).rejects.toThrow('record unavailable');
    expect(f.pub.receipt(f.git.head(L)!, B)).toBeTruthy();
    expect(f.pub.receipt(f.git.head(L)!, A)).toBeUndefined();
    f.git.cas = cas;
    await f.pub.run();
    f.assertDone(A);
    f.assertDone(B);
  });
  it('byte-identical output still has a durable receipt-only commit', async () => {
    const f = await setup();
    await f.request();
    await f.pub.run();
    const before = f.git.tree(f.git.head(L)!)['liveDescriptions.json'];
    await f.request(B);
    await f.pub.run();
    f.assertDone(B);
    expect(f.git.tree(f.git.head(L)!)['liveDescriptions.json']).toBe(before);
    expect(f.pub.receipt(f.git.head(L)!, B)!.outcome).toBe('unchanged');
  });
  it.each(['bad-signature', 'wrong-branch', 'revoked'])(
    'rejects forged or edited request: %s',
    async (kind) => {
      const f = await setup();
      const { envelope } = await f.request(
        A,
        [123],
        undefined,
        kind === 'wrong-branch' ? { liveBranch: 'forged' } : {},
      );
      if (kind === 'bad-signature')
        f.change(D, {
          [paths(A).request]: {
            ...envelope,
            payload: envelope.payload.replace('alice', 'mallory'),
          },
        });
      if (kind === 'revoked')
        f.change(D, {
          'config/permissions.json': { users: { '1': { login: 'alice', role: 'trial' } } },
        });
      const before = f.git.head(L);
      await f.pub.run();
      expect(f.git.head(L)).toBe(before);
      expect(
        f.pub.read<{ result: { status: string } }>(f.git.tree(f.git.head(D)!), paths(A).log)!.result
          .status,
      ).toBe('rejected');
    },
  );
  it('parses permissions with the export partners map; a partner-only requester is refused', async () => {
    const partners = {
      '1': { login: 'alice', projects: ['dim'] },
      '9': { login: 'p', projects: ['x1'] },
    };
    const f = await setup();
    f.change(D, {
      'config/permissions.json': { users: { '1': { login: 'alice', role: 'editor' } }, partners },
    });
    await f.request();
    await f.pub.run();
    f.assertDone();
    const g = await setup();
    g.change(D, { 'config/permissions.json': { users: {}, partners } });
    await g.request();
    const before = g.git.head(L);
    await g.pub.run();
    expect(g.git.head(L)).toBe(before);
    expect(
      g.pub.read<{ result: { status: string } }>(g.git.tree(g.git.head(D)!), paths(A).log)!.result
        .status,
    ).toBe('rejected');
  });
  it('aliases canonicalize and one stale member rejects the whole request', async () => {
    const f = await setup();
    f.options.aliases = { 789: { to: 123, kind: 'sandbox' } };
    const t2 = { ...f.tooltip, hash: 234 };
    f.change(D, { 'tooltips/234.json': t2 });
    await f.request(A, [789, 234], {
      789: await publishableHash(f.tooltip, f.options.aliases),
      234: '0'.repeat(64),
    });
    const before = f.git.head(L);
    await f.pub.run();
    expect(f.git.head(L)).toBe(before);
    expect(
      f.pub.read<{ result: unknown }>(f.git.tree(f.git.head(D)!), paths(A).log)!.result,
    ).toMatchObject({
      status: 'stale',
      outcomes: [
        { hash: 123, status: 'accepted' },
        { hash: 234, status: 'stale' },
      ],
    });
  });
  it('merges maintainer sandbox picks: stub for a pick, none for "no tooltip", picked digest', async () => {
    const f = await setup();
    f.options.sandboxConflicts = { 700: [123, 124], 701: [123, 125], 702: [123, 126] };
    const pointers = {
      version: 1,
      pointers: {
        700: { to: 123, candidates: [123, 124], by: 1, at: '2026-11-12T20:00:00Z' },
        701: { none: true, candidates: [123, 125], by: 1, at: '2026-11-12T20:00:00Z' },
        // The generator's set changed since the pick: it keeps working (owner 2026-11-12).
        702: { to: 123, candidates: [123], by: 1, at: '2026-11-12T20:00:00Z' },
      },
    };
    f.change(D, { 'config/sandbox-pointers.json': pointers });
    const merged = {
      700: { to: 123, kind: 'sandbox' as const },
      702: { to: 123, kind: 'sandbox' as const },
    };
    // A review made without the picks is stale against the picked aliases.
    await f.request(A, [123], { 123: await publishableHash(f.tooltip, {}) });
    await f.pub.run();
    expect(
      f.pub.read<{ result: { status: string } }>(f.git.tree(f.git.head(D)!), paths(A).log)!.result
        .status,
    ).toBe('stale');
    await f.request(B, [123], { 123: await publishableHash(f.tooltip, merged) });
    await f.pub.run();
    f.assertDone(B);
    const perks = f.pub.read<{ perks: Record<string, unknown> }>(
      f.git.tree(f.git.head(L)!),
      'liveDescriptions.json',
    )!.perks;
    expect(perks['700']).toEqual({ hash: 700, aliasOf: 123, aliasKind: 'sandbox' });
    expect(perks['702']).toEqual({ hash: 702, aliasOf: 123, aliasKind: 'sandbox' });
    expect(perks).not.toHaveProperty('701');
  });
  it('recomputes an undone pick to absent on the next publish, keeping other records', async () => {
    const f = await setup();
    f.options.sandboxConflicts = { 700: [123, 124], 701: [123, 125] };
    const pick = (to: number) => ({
      to,
      candidates: [123, 124],
      by: 1,
      at: '2026-11-12T20:00:00Z',
    });
    f.change(D, {
      'config/sandbox-pointers.json': { version: 1, pointers: { 700: pick(123), 701: pick(123) } },
    });
    const both = {
      700: { to: 123, kind: 'sandbox' as const },
      701: { to: 123, kind: 'sandbox' as const },
    };
    await f.request(A, [123], { 123: await publishableHash(f.tooltip, both) });
    await f.pub.run();
    f.assertDone(A);
    // 700 is undone (a tombstone): publishing 123 again recomputes it to absent; 701 stays.
    f.change(D, {
      'config/sandbox-pointers.json': {
        version: 1,
        pointers: {
          700: { state: 'undone', by: 1, at: '2026-11-12T21:00:00Z' },
          701: pick(123),
        },
      },
    });
    await f.request(B, [123], { 123: await publishableHash(f.tooltip, { 701: both[701] }) });
    await f.pub.run();
    f.assertDone(B);
    const perks = f.pub.read<{ perks: Record<string, unknown> }>(
      f.git.tree(f.git.head(L)!),
      'liveDescriptions.json',
    )!.perks;
    expect(perks).not.toHaveProperty('700');
    expect(perks['701']).toEqual({ hash: 701, aliasOf: 123, aliasKind: 'sandbox' });
    expect(perks).toHaveProperty('123');
  });
  it.skipIf(transport !== 'simulator')(
    'parity verifies a picked receipt with the merged aliases and matches the live bytes',
    async () => {
      const f = await setup();
      f.options.sandboxConflicts = { 700: [123, 124] };
      f.change(D, {
        'config/sandbox-pointers.json': {
          version: 1,
          pointers: { 700: { to: 123, candidates: [123, 124], by: 1, at: '2026-11-12T20:00:00Z' } },
        },
      });
      await f.request(A, [123], {
        123: await publishableHash(f.tooltip, { 700: { to: 123, kind: 'sandbox' } }),
      });
      await f.pub.run();
      f.assertDone(A);
      const dir = mkdtempSync(join(tmpdir(), 'parity-picks-'));
      roots.push(dir);
      const config = join(dir, 'config.json');
      writeFileSync(config, JSON.stringify(f.options));
      const previous = process.argv;
      process.argv = [
        'node',
        'parity',
        f.upstream,
        f.git.head(L)!,
        paths(A).receipt,
        config,
        join(dir, 'missing-adapters.mjs'),
        join(dir, 'out'),
      ];
      try {
        // It stops at the (absent) converter adapters, after the digest check and the live bytes.
        await expect(import('./parity.js')).rejects.toThrow(/missing-adapters|Cannot find|ERR_/);
      } finally {
        process.argv = previous;
      }
      expect(readFileSync(join(dir, 'out', 'expected-liveDescriptions.json'), 'utf8')).toBe(
        readFileSync(join(dir, 'out', 'actual-liveDescriptions.json'), 'utf8'),
      );
    },
  );
  it('bundle.json carries maintainer sandbox picks only while the file holds some', async () => {
    const f = await setup();
    const bundle = () =>
      f.pub.read<Record<string, unknown>>(
        f.git.tree(f.git.head('refs/heads/editor-data-bundle')!),
        'bundle.json',
      )!;
    f.pub.bundle();
    expect(bundle()).not.toHaveProperty('sandboxPointers');
    f.change(D, { 'config/sandbox-pointers.json': { version: 1, pointers: {} } });
    f.pub.bundle();
    expect(bundle()).not.toHaveProperty('sandboxPointers');
    const picks = {
      version: 1,
      pointers: { 700: { to: 123, candidates: [123, 124], by: 1, at: '2026-11-12T20:00:00Z' } },
    };
    f.change(D, { 'config/sandbox-pointers.json': picks });
    f.pub.bundle();
    expect(bundle().sandboxPointers).toEqual(picks);
  });
  it('rejects a request terminally when the picks file is malformed', async () => {
    const f = await setup();
    f.change(D, { 'config/sandbox-pointers.json': { version: 1, pointers: { 700: { to: 1 } } } });
    await f.request();
    const before = f.git.head(L);
    await f.pub.run();
    expect(f.git.head(L)).toBe(before);
    expect(
      f.pub.read<{ result: { status: string; error: string } }>(
        f.git.tree(f.git.head(D)!),
        paths(A).log,
      )!.result,
    ).toMatchObject({ status: 'rejected', error: expect.stringContaining('sandbox-pointers') });
    // The bundle still updates; it leaves the malformed picks out.
    const bundle = f.pub.read<Record<string, unknown>>(
      f.git.tree(f.git.head('refs/heads/editor-data-bundle')!),
      'bundle.json',
    )!;
    expect(bundle.sourceCommit).toBe(f.git.head(D));
    expect(bundle).not.toHaveProperty('sandboxPointers');
  });
  it.each([false, true])(
    'guard closes a stray request (conflict=%s) without changing original log',
    async (conflict) => {
      const f = await setup();
      const original = await f.request();
      await f.pub.run();
      const head = f.git.head(L),
        log = f.git.tree(f.git.head(D)!)[paths(A).log];
      if (conflict) await f.request(A, [123], { 123: '0'.repeat(64) });
      else f.change(D, { [paths(A).request]: original.envelope });
      await f.pub.run();
      expect(f.git.head(L)).toBe(head);
      const t = f.git.tree(f.git.head(D)!);
      expect(t[paths(A).log]).toBe(log);
      expect(f.pub.read(t, paths(A).log.replace('.json', '.dup-1.json'))).toMatchObject({
        status: conflict ? 'conflict' : 'duplicate',
      });
    },
  );
  it('CAS request creation reconciles duplicate/lost-202, delayed create after RECORD, and landed timeout', async () => {
    const f = await setup();
    const h = f.git.head(D)!;
    const { payload, envelope } = await f.request();
    const requestHead = f.git.head(D)!;
    const renamed = {
      ...payload,
      createdAt: '2027-01-01T00:00:00.000Z',
      requester: { id: 1, login: 'renamed' },
    };
    expect(await publishIntentDigest(renamed)).toBe(payload.intentDigest);
    expect(classifyPublishIntent(payload.intentDigest, payload).status).toBe('pending');
    expect(classifyPublishIntent('f'.repeat(64), payload).status).toBe('conflict');
    expect(() =>
      validatePublishBody(
        { opId: A, hashes: payload.hashes, expected: payload.expected },
        pushTime,
        false,
      ),
    ).not.toThrow();
    // A second creator prepared on the same H is delayed until after RECORD deletes the request.
    const delayed = f.git.commit(
      h,
      { ...f.git.tree(h), [paths(A).request]: f.git.writeBlob(encode(envelope)) },
      'Delayed duplicate',
    );
    await f.pub.run();
    f.assertDone();
    expect(() => f.git.cas(D, h, delayed)).toThrow(RefRace);
    const log = f.pub.read<{ intentDigest: string; result: unknown }>(
      f.git.tree(f.git.head(D)!),
      paths(A).log,
    )!;
    expect(classifyPublishIntent(payload.intentDigest, undefined, log)).toEqual({
      status: 'complete',
      result: log.result,
    });
    expect(f.git.tree(f.git.head(D)!)[paths(A).request]).toBeUndefined();
    // The timed-out create landed at requestHead: reread that authoritative head, no new write.
    expect(
      classifyPublishIntent(
        payload.intentDigest,
        JSON.parse(
          f.pub.read<{ payload: string }>(f.git.tree(requestHead), paths(A).request)!.payload,
        ),
      ).status,
    ).toBe('pending');
  });
  it('bundle repairs after an empty run and refuses a source regression', async () => {
    const f = await setup();
    await f.pub.run();
    const first = f.git.head('refs/heads/editor-data-bundle')!;
    f.change(D, { 'save.json': 1 });
    await f.pub.run();
    const newer = f.git.head('refs/heads/editor-data-bundle')!;
    expect(newer).not.toBe(first);
    const bundle = f.pub.read<{ sourceCommit: string }>(f.git.tree(newer), 'bundle.json')!;
    expect(bundle.sourceCommit).toBe(f.git.head(D));
    const unrelated = f.git.commit(undefined, f.git.tree(f.git.head(D)!), 'Unrelated data');
    if (transport === 'remote') {
      expect(() => f.git.cas(D, f.git.head(D), unrelated)).toThrow('monotonically');
      return;
    }
    f.git.cas(D, f.git.head(D), unrelated);
    expect(() => f.pub.bundle()).toThrow('backwards');
    expect(f.git.head('refs/heads/editor-data-bundle')).toBe(newer);
  });
  it('a bundle push carries both report catalogs forward and adds the sandbox picks', async () => {
    const f = await setup();
    const ref = 'refs/heads/editor-data-bundle',
      source = f.git.head(D)!;
    const catalogs = {
      'report-items.json': `{"v":1,"sourceCommit":"${source}","items":{"123":{"name":"Thing"}}}
`,
      'report-items.worker.json': `{"v":1,"sourceCommit":"${source}","items":{"123":{}}}
`,
    };
    const seeded: Tree = { 'bundle.json': f.git.writeBlob(encode({ sourceCommit: source })) };
    for (const [p, bytes] of Object.entries(catalogs)) seeded[p] = f.git.writeBlob(bytes);
    f.git.cas(ref, undefined, f.git.commit(undefined, seeded, 'Bundle editor data'));
    const picks = {
      version: 1,
      pointers: { 700: { to: 123, candidates: [123, 124], by: 1, at: '2026-11-12T20:00:00Z' } },
    };
    f.change(D, { 'config/sandbox-pointers.json': picks });
    f.pub.bundle();
    const tree = f.git.tree(f.git.head(ref)!);
    expect(Object.keys(tree).sort()).toEqual(
      ['bundle.json', 'report-items.json', 'report-items.worker.json'].sort(),
    );
    for (const [p, bytes] of Object.entries(catalogs)) expect(f.git.blob(tree[p]!)).toBe(bytes);
    expect(f.pub.read<{ sandboxPointers: unknown }>(tree, 'bundle.json')!.sandboxPointers).toEqual(
      picks,
    );
  });
  it('bundle pushes, dry-run included, carry the report catalogs forward byte-identical', async () => {
    const f = await setup();
    const ref = 'refs/heads/editor-data-bundle',
      source = f.git.head(D)!;
    // The bundle.yml shape: an orphan commit holding bundle.json and both report catalogs.
    const catalogs = {
      'report-items.json': `{"v":1,"sourceCommit":"${source}","items":{"123":{"name":"Thing"}}}\n`,
      'report-items.worker.json': `{"v":1,"sourceCommit":"${source}","items":{"123":{}}}\n`,
    };
    const seeded: Tree = { 'bundle.json': f.git.writeBlob(encode({ sourceCommit: source })) };
    for (const [p, bytes] of Object.entries(catalogs)) seeded[p] = f.git.writeBlob(bytes);
    const prior = f.git.commit(undefined, seeded, 'Bundle editor data');
    f.git.cas(ref, undefined, prior);
    const latest = f.change(D, { 'save.json': 1 });
    const checkoutRoot = mkdtempSync(join(tmpdir(), 'carry-pipeline-'));
    roots.push(checkoutRoot);
    const checkout = join(checkoutRoot, 'checkout');
    execFileSync('git', ['clone', '--branch', 'editor-data', '--', f.upstream, checkout], {
      stdio: 'pipe',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              algorithm: 'Ed25519',
              publicKey: f.options.publicKey,
              fingerprint: f.options.keyFingerprint,
            }),
          ),
      ),
    );
    await runPipeline(
      checkout,
      {
        ...f.options,
        repo: 'Database-Clarity/Live-Clarity-Database',
        keyEndpoint: 'https://worker.invalid/publish/key',
      },
      join(checkoutRoot, 'artifacts'),
    );
    const carried = (next: string, parent: string, sourceCommit: string) => {
      const before = f.git.tree(parent),
        after = f.git.tree(next);
      expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
      for (const p of Object.keys(catalogs)) {
        expect(after[p]).toBe(before[p]);
        expect(f.git.blob(after[p])).toBe(catalogs[p as keyof typeof catalogs]);
      }
      expect(after['bundle.json']).not.toBe(before['bundle.json']);
      expect(f.pub.read<{ sourceCommit: string }>(after, 'bundle.json')!.sourceCommit).toBe(
        sourceCommit,
      );
      expect(
        execFileSync('git', ['--git-dir', f.upstream, 'rev-parse', `${next}^`], {
          encoding: 'utf8',
        }).trim(),
      ).toBe(parent);
    };
    const dryRun = f.git.head(ref)!;
    carried(dryRun, prior, latest);
    // The direct bundle path (the remote transport's CAS included) carries them forward, too.
    const newer = f.change(D, { 'save.json': 2 });
    f.pub.bundle();
    carried(f.git.head(ref)!, dryRun, newer);
  });
  it.each([false, true])(
    'create transport timeout rereads authoritative head (landed=%s)',
    async (landed) => {
      const f = await setup();
      const { payload } = await f.request();
      const t = f.git.tree(f.git.head(D)!);
      delete t[paths(A).request];
      f.git.cas(D, f.git.head(D), f.git.commit(f.git.head(D), t, 'Remove seed request'));
      const cas = f.git.cas.bind(f.git);
      let calls = 0;
      f.git.cas = (ref, old, next) => {
        if (ref === D && ++calls === 1) {
          if (landed) cas(ref, old, next);
          throw new Error('create timeout');
        }
        cas(ref, old, next);
      };
      // This fixture's opId timestamp, rather than the publisher clock, bounds initial creation.
      // Use the exact ULID time derived from its Crockford prefix.
      const time = [...A.slice(0, 10)].reduce(
        (n, c) => n * 32 + '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(c),
        0,
      );
      expect(await createRequest(f.git, payload, () => time, f.sign)).toEqual({
        status: 'pending',
      });
      const before = f.git.head(D);
      expect(
        await createRequest(
          f.git,
          { ...payload, requester: { id: 1, login: 'renamed' } },
          () => time + 999999999,
          f.sign,
        ),
      ).toEqual({ status: 'pending' });
      expect(f.git.head(D)).toBe(before);
      expect(
        await createRequest(
          f.git,
          { ...payload, expected: { 123: '0'.repeat(64) } },
          () => time,
          f.sign,
        ),
      ).toEqual({ status: 'conflict' });
      await f.pub.run();
      f.assertDone();
      expect((await createRequest(f.git, payload, () => time + 999999999, f.sign)).status).toBe(
        'complete',
      );
    },
  );
  it('fixed-now golden matches guarded pushLive byte for byte and pushed map', async () => {
    // Retain the afa1e8e stamp oracle; re-pin push.ts for its reviewed native refusal
    // and budget checks, the link-only empty-description guard, and the set-bonus hold; the
    // element-tag export hold is lifted (exportLegacy lowers; untagged pushes write the same bytes).
    // The written, pair-free golden still matches byte for byte; empty refusals are tested above.
    // Re-pinned for sandbox picks: push merges config/sandbox-pointers.json (core
    // mergeSandboxPointers) like the publisher, and merges live perks with core mergeLivePerks
    // (only withdrawable sandbox stubs removed); with no picks file, as here, every byte is the same.
    for (const [path, expected] of [
      ['apps/worker/src/push.ts', '193ccc839723f99cdfcfeb32059dc32c74cc7a85'],
      ['apps/worker/src/stamp.ts', 'debdbefc1657c970f27b1304e4c8ea509c54b4a1'],
    ]) {
      const content = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
      expect(
        createHash('sha1')
          .update(`blob ${Buffer.byteLength(content)}\0`)
          .update(content)
          .digest('hex'),
      ).toBe(expected);
    }
    vi.useFakeTimers({ toFake: ['Date'], now: pushTime });
    const worker = new Fixture(await makePrivateKey());
    const values = await seedPushGroups(worker);
    const f = await setup();
    f.options.aliases = worker.aliases;
    f.options.facts = {
      123: { name: 'Demo perk', type: 'Weapon Perk', itemHash: 456, itemName: 'Demo item' },
      234: { name: 'Member 234', type: 'Weapon Perk', itemHash: 2234 },
      345: { name: 'Member 345', type: 'Weapon Perk', itemHash: 2345 },
      456: { name: 'Member 456', type: 'Weapon Perk', itemHash: 2456 },
    };
    f.change(D, worker.current());
    f.change(L, { 'liveDescriptions.json': worker.live });
    const expected = {
      123: await publishableHash(values.changed, worker.aliases),
      234: await publishableHash(values.unchanged, worker.aliases),
    };
    await f.request(A, [123, 234], expected);
    const response = await worker.request(
      '/push-live',
      'POST',
      { hashes: [123, 234], expected },
      1,
    );
    expect(response.status).toBe(200);
    await f.pub.run();
    f.assertDone();
    expect(f.git.blob(f.git.tree(f.git.head(L)!)['liveDescriptions.json'])).toBe(
      encode(worker.live),
    );
    expect(f.pub.read(f.git.tree(f.git.head(D)!), 'live/pushed.json')).toEqual(
      worker.current()['live/pushed.json'],
    );
  });
  it.each([
    ['stale', false],
    ['stale', true],
    ['rejected', false],
    ['rejected', true],
  ] as const)(
    'RECORD closes a replacement while recording %s (same intent=%s)',
    async (status, sameIntent) => {
      const f = await setup();
      const original = await f.request();
      const oldBlob = f.git.tree(f.git.head(D)!)[paths(A).request];
      await f.request(A, [123], sameIntent ? undefined : { 123: 'b'.repeat(64) }, {
        createdAt: '2026-11-03T13:00:00.000Z',
      });
      const replaced = f.git.tree(f.git.head(D)!)[paths(A).request];
      expect(replaced).not.toBe(oldBlob);
      await f.pub.record(A, undefined, undefined, { status }, oldBlob);
      const tree = f.git.tree(f.git.head(D)!);
      expect(tree[paths(A).request]).toBeUndefined();
      expect(
        f.pub.read<{ status: string; requestBlob: string }>(
          tree,
          paths(A).log.replace('.json', '.dup-1.json'),
        ),
      ).toEqual({ status: sameIntent ? 'duplicate' : 'conflict', requestBlob: replaced });
      expect(f.pub.read<{ intentDigest: string }>(tree, paths(A).log)?.intentDigest).toBe(
        original.payload.intentDigest,
      );
    },
  );

  it('preserves executable, symlink and gitlink modes (simulator fails closed)', async () => {
    const f = await setup();
    await f.request();
    for (const ref of [D, L]) {
      const h = f.git.head(ref)!;
      f.git.git(['read-tree', h]);
      f.git.git(
        ['update-index', '-z', '--index-info'],
        `100755 ${f.git.writeBlob('exec bytes')}\texecutable\0` +
          `120000 ${f.git.writeBlob('executable')}\tlink\0` +
          `160000 ${h}\tmodule\0`,
      );
      const root = f.git.git(['write-tree']).trim();
      const c = f.git.git(['commit-tree', root, '-p', h], 'Modes').trim();
      f.git.cas(ref, h, c);
    }
    if (transport === 'simulator') {
      expect(() => f.git.tree(f.git.head(D)!)).toThrow('Only plain blob');
      return;
    }
    await f.pub.run();
    f.assertDone();
    for (const ref of [D, L]) {
      const entries = f.git.git(['ls-tree', f.git.head(ref)!]);
      expect(entries).toMatch(/100755 blob [a-f0-9]+\texecutable/);
      expect(entries).toMatch(/120000 blob [a-f0-9]+\tlink/);
      expect(entries).toMatch(/160000 commit [a-f0-9]+\tmodule/);
    }
  });
  it.each(['landed', 'not-landed'] as const)(
    'subprocess boundary disconnect: %s',
    async (fault) => {
      const f = await setup();
      if (!(f.git instanceof RemoteRepository)) return;
      await f.request();
      const remoteGit = f.git.remoteGit.bind(f.git);
      let injected = false;
      f.git.remoteGit = (args) => {
        if (!injected && args[0] === 'push' && args.at(-1)?.endsWith(`:${L}`)) {
          injected = true;
          if (fault === 'landed') remoteGit(args);
          throw new Error('Injected disconnect after receive-pack');
        }
        return remoteGit(args);
      };
      await f.pub.run();
      expect(injected).toBe(true);
      f.assertDone();
    },
  );
  it('fails closed before credentials or network access when remote config is OFF', async () => {
    const f = await setup();
    const tokenRead = vi.fn(),
      networkFetch = vi.fn();
    vi.stubGlobal('fetch', networkFetch);
    const remoteGit = vi.spyOn(RemoteRepository.prototype, 'remoteGit');
    const originalEnv = process.env;
    process.env = new Proxy(originalEnv, {
      get(target, key) {
        if (key === 'GITHUB_TOKEN') tokenRead();
        return Reflect.get(target, key);
      },
    });
    try {
      await expect(
        runPipeline(
          '.',
          {
            ...f.options,
            repo: 'Database-Clarity/Live-Clarity-Database',
            keyEndpoint: 'https://worker.invalid',
            publishWritesEnabled: true,
          },
          join(f.upstream, 'out'),
          true,
        ),
      ).rejects.toThrow('disabled by config');
      expect(tokenRead).not.toHaveBeenCalled();
      expect(networkFetch).not.toHaveBeenCalled();
      expect(remoteGit).not.toHaveBeenCalled();
      expect(existsSync(join(f.upstream, 'out'))).toBe(false);
    } finally {
      process.env = originalEnv;
      remoteGit.mockRestore();
    }
  });
});
