import { activateGlobalsFixture, pinGlobalsFixture } from './testGlobals.js';
import { Fixture, makePrivateKey } from '../../apps/worker/test/fixture.js';
import { seedPushGroups, pushTime } from '../../apps/worker/test/push-fixture.js';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
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
  inactivePublishableHash,
  inactiveRemovalHash,
  clearedReviewHash,
  currentSaveStagePaths,
  globalsInPlacePath,
  exportLegacy,
  translationPublishCapability,
  translationPublishIntentDigest,
  type TranslationPublishPayload,
  type TranslationPublishRow,
  classifyPublishIntent,
  validatePublishBody,
  type PublishPayload,
  type Tooltip,
  type AliasGroups,
} from '../../packages/core/src/index.js';
import { LocalRepository, RefRace, requesterCredits, type Tree } from './git.js';
import { Publisher, paths, type Options } from './publisher.js';
import { createRequest } from './request.js';
import { runPipeline } from './pipeline.js';
import publisherConfig from '../../config/publisher.json';
import { buildLegacy, legacyPresets, type LegacyInput } from '../../packages/export/src/legacy.js';
import { bundleTranslations, translationRootsPath } from './translations.js';

// These fixtures run the publisher and the Worker's legacy push-live (the golden oracle) with the
// build switch OFF, as before PUB-ENABLE turned the checked-in switch ON; a test flips it itself.
vi.mock('../../config/publisher.json', () => ({ default: { enabled: false } }));
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
      execFileSync(
        'git',
        [
          'clone',
          '--depth=1',
          '--branch',
          'editor-data',
          '--',
          pathToFileURL(f.upstream).href,
          checkout,
        ],
        { stdio: 'pipe' },
      );
      const bundleRef = 'refs/heads/editor-data-bundle';
      // A report push wins the initial bundle lease, after the pipeline snapshot.
      f.pub.bundle();
      f.change(D, { 'notes.json': { changed: true } });
      const origin = new LocalRepository(f.upstream);
      const reportBase = f.git.head(bundleRef)!;
      const reportTree = {
        ...origin.tree(reportBase),
        'report-items.json': origin.writeBlob('catalog bytes'),
      };
      const reportCommit = origin.commit(reportBase, reportTree, 'Concurrent report update');
      const hook = join(checkout, '.git', 'hooks', 'pre-push');
      vi.stubEnv('PUBLISHER_FIXTURE_ORIGIN', f.upstream.replace(/\\/g, '/'));
      writeFileSync(
        hook,
        `#!/bin/sh\ngit --git-dir "$PUBLISHER_FIXTURE_ORIGIN" update-ref ${bundleRef} ${reportCommit} ${reportBase} 2>/dev/null || true\n`,
      );
      chmodSync(hook, 0o755);
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
      }>(f.git.tree(f.git.head(bundleRef)!), 'bundle.json')!;
      expect(f.git.ancestor(reportCommit, f.git.head(bundleRef)!)).toBe(true);
      expect(f.git.tree(f.git.head(bundleRef)!)['report-items.json']).toBe(
        reportTree['report-items.json'],
      );
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

  it('rebuilds a raced publisher bundle on the winning report commit', async () => {
    const f = await setup();
    const bundleRef = 'refs/heads/editor-data-bundle';
    f.pub.bundle();
    const old = f.git.head(bundleRef)!;
    const data = f.change(D, { 'notes.json': { changed: true } });
    const writes = f.git.cas.bind(f.git);
    const origin = new LocalRepository(f.upstream);
    const catalog = origin.writeBlob('report contents');
    const report = origin.commit(
      old,
      { ...origin.tree(old), 'report-items.json': catalog },
      'Concurrent report update',
    );
    const cas = vi.spyOn(f.git, 'cas').mockImplementationOnce((ref, base, next) => {
      expect(ref).toBe(bundleRef);
      origin.cas(ref, old, report);
      writes(ref, base, next);
    });
    f.pub.bundle();
    const head = f.git.head(bundleRef)!;
    expect(f.git.git(['rev-parse', `${head}^`]).trim()).toBe(report);
    const tree = f.git.tree(head);
    expect(tree['report-items.json']).toBe(catalog);
    expect(f.pub.read(tree, 'bundle.json')).toHaveProperty('sourceCommit', data);
    expect(cas).toHaveBeenCalledTimes(2);
    cas.mockRestore();
  });

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
    for (const path of Object.keys(empty)) if (path.startsWith('tooltips/')) delete empty[path];
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
      f.change(L, {
        'liveDescriptions.json': {
          perks: {
            ...f.pub.read<{ perks: Record<string, unknown> }>(
              f.git.tree(f.git.head(L)!),
              'liveDescriptions.json',
            )!.perks,
            125: published,
          },
          databaseSettings: {},
        },
      });
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
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  it('refuses a new computed text-less Nail, Meet Hammer row before committing any candidate', async () => {
    const f = await setup();
    const source = {
      ...f.tooltip,
      hash: 1209885908,
      custom: { name: 'Nail, Meet Hammer', categoryId: 'perk' },
      text: { en: { ...f.tooltip.text.en!, text: 'import main from 2152442764' } },
    };
    const target = { hash: 2152442764, editor: { en: { main: '', secondary: '' } } };
    const old = f.pub.read<{ perks: Record<string, unknown>; databaseSettings: unknown }>(
      f.git.tree(f.git.head(L)!),
      'liveDescriptions.json',
    )!;
    f.change(L, {
      'liveDescriptions.json': { ...old, perks: { ...old.perks, 2152442764: target } },
    });
    f.change(D, { 'tooltips/1209885908.json': source });
    await f.request(A, [source.hash], { [source.hash]: await publishableHash(source) });
    f.change(D, {
      'config/permissions.json': {
        users: { '1': { login: 'alice', role: 'editor' }, '2': { login: 'bob', role: 'editor' } },
      },
    });
    await f.request(B, [123], undefined, { requester: { id: 2, login: 'bob' } });
    const live = f.git.head(L);
    await f.pub.operation(A);
    expect(f.git.head(L)).toBe(live);
    const rejected = f.git.head(D)!;
    expect(f.pub.read(f.git.tree(rejected), paths(A).log)).toMatchObject({
      result: {
        status: 'rejected',
        error: expect.stringMatching(/TextlessConsumerOutput.*1209885908/),
      },
    });
    expect(f.git.git(['show', '-s', '--format=%an <%ae>|%cn <%ce>', rejected]).trim()).toBe(
      'alice <1+alice@users.noreply.github.com>|clarity-editor-backend[bot] <clarity-editor-backend[bot]@users.noreply.github.com>',
    );
    expect(f.git.head(paths(A).candidate)).toBeUndefined();
    await f.pub.run();
    f.assertDone(B);
    expect(
      f.pub.read<Record<string, string>>(f.git.tree(f.git.head(D)!), 'live/pushed.json'),
    ).not.toHaveProperty('1209885908');
  });

  it('credits Publish, Record, and bundle commits from the signed requester and app', async () => {
    const f = await setup();
    await f.request();
    await f.pub.operation(A);
    const live = f.git.head(L)!;
    const identity = (commit: string) =>
      f.git.git(['show', '-s', '--format=%an <%ae>|%cn <%ce>', commit]).trim();
    const expected =
      'alice <1+alice@users.noreply.github.com>|clarity-editor-backend[bot] <clarity-editor-backend[bot]@users.noreply.github.com>';
    expect(identity(live)).toBe(expected);
    expect(identity(f.git.head(D)!)).toBe(expected);
    // Closing a retried request is still attributable to its signed requester.
    await f.request();
    await f.pub.operation(A);
    expect(identity(f.git.head(D)!)).toBe(expected);
    expect(f.git.head(L)).toBe(live);
    f.pub.bundle();
    expect(identity(f.git.head('refs/heads/editor-data-bundle')!)).toBe(
      'clarity-editor-backend[bot] <clarity-editor-backend[bot]@users.noreply.github.com>|clarity-editor-backend[bot] <clarity-editor-backend[bot]@users.noreply.github.com>',
    );
  });

  it('does not credit a forged requester, and rejects identity injection', async () => {
    const f = await setup();
    const { envelope } = await f.request();
    const forged = JSON.parse(envelope.payload);
    forged.requester.login = 'forged';
    f.change(D, { [paths(A).request]: { ...envelope, payload: stableStringify(forged) } });
    const live = f.git.head(L);
    await f.pub.operation(A);
    expect(f.git.head(L)).toBe(live);
    expect(f.git.git(['show', '-s', '--format=%an', f.git.head(D)!]).trim()).toBe(
      'clarity-editor-backend[bot]',
    );
    for (const login of ['bad\nInjected', 'bad <email>', 'name@example.com', ''])
      expect(() => requesterCredits({ id: 1, login })).toThrow('Invalid publisher requester');
  });

  it('does not allow simulator defaults on a GitHub transport', async () => {
    const f = await setup();
    const remote = new RemoteRepository(f.git.path, {
      repo: 'Database-Clarity/Live-Clarity-Database',
      token: 'local-test-only',
    });
    expect(() => remote.commit(undefined, {}, 'Unattributed')).toThrow(
      'Remote commits require explicit credits',
    );
  });

  it('allows historical computed text-less rows while publishing unrelated text', async () => {
    const f = await setup();
    const old = f.pub.read<{ perks: Record<string, unknown>; databaseSettings: unknown }>(
      f.git.tree(f.git.head(L)!),
      'liveDescriptions.json',
    )!;
    f.change(L, {
      'liveDescriptions.json': {
        ...old,
        perks: {
          ...old.perks,
          999: {
            hash: 999,
            editor: { en: { main: 'import main from 1000', secondary: 'import main from 1000' } },
          },
          1000: { hash: 1000, editor: { en: { main: '', secondary: '' } } },
        },
      },
    });
    await f.request();
    await f.pub.operation(A);
    f.assertDone();
  });

  it('rejects an unsafe stored candidate before live CAS and continues the queue', async () => {
    const f = await setup();
    await f.request();
    const atomic = f.git.casMany.bind(f.git);
    f.git.casMany = () => {
      throw new Error('stop before atomic publication');
    };
    await expect(f.pub.operation(A)).rejects.toThrow('stop before atomic publication');
    f.git.casMany = atomic;
    const live = f.git.head(L),
      candidate = f.git.head(paths(A).candidate)!;
    const tree = f.git.tree(candidate);
    tree['liveDescriptions.json'] = f.git.writeBlob(encode({ perks: {}, databaseSettings: {} }));
    const unsafe = f.git.commit(live, tree, 'Simulate an older unsafe candidate');
    f.git.cas(paths(A).candidate, candidate, unsafe);
    await f.request(B);
    await f.pub.operation(A);
    expect(f.git.head(L)).toBe(live);
    expect(f.git.head(paths(A).candidate)).toBeUndefined();
    expect(f.pub.read(f.git.tree(f.git.head(D)!), paths(A).log)).toMatchObject({
      result: { status: 'rejected', error: expect.stringContaining('stored candidate differs') },
    });
    await f.pub.run();
    f.assertDone(B);
  });

  it.each([false, true])(
    'rejects a candidate with the wrong signed marker (inactive=%s)',
    async (inactive) => {
      const f = await setup();
      if (inactive) {
        f.change(D, {
          'config/inactive.json': { 123: { by: 1, at: '2026-11-14T00:00:00Z' } },
        });
        await f.request(A, [123], { 123: await inactiveRemovalHash(123) });
      } else await f.request(A);
      const create = f.pub.createCandidate.bind(f.pub);
      f.pub.createCandidate = (opId, blob, live, receipt) => {
        receipt.entries[0].digest = '0'.repeat(64);
        return create(opId, blob, live, receipt);
      };
      const before = f.git.head(L);
      await f.pub.operation(A);
      expect(f.git.head(L)).toBe(before);
      expect(f.pub.read(f.git.tree(f.git.head(D)!), paths(A).log)).toMatchObject({
        result: {
          status: 'rejected',
          error: expect.stringContaining('Tooltip 123 would publish a different revision'),
        },
      });
    },
  );

  it('recovers a signed alias marker using the generator at the frozen source', async () => {
    const f = await setup();
    f.options.aliases = { 555: { to: 123, kind: 'frame' } };
    f.options.facts[555] = { name: 'Frame alias', type: 'perk' };
    f.change(D, {
      '.publisher/config.json': {
        generatorSha: f.options.generatorSha,
        aliases: f.options.aliases,
        facts: f.options.facts,
      },
    });
    const digest = await inactivePublishableHash(f.tooltip, f.options.aliases);
    await f.request(A, [555], { 555: digest });
    const create = f.pub.createCandidate.bind(f.pub);
    f.pub.createCandidate = (opId, blob, live, receipt) => {
      const candidate = create(opId, blob, live, receipt);
      f.git.cas(L, live, candidate.c);
      f.options.generatorSha = 'c'.repeat(40);
      f.options.aliases = {};
      return candidate;
    };
    await f.pub.operation(A);
    const { result } = f.pub.read<{ result: { status: string; error?: string } }>(
      f.git.tree(f.git.head(D)!),
      paths(A).log,
    )!;
    expect(result.status, result.error).toMatch(/done|unchanged/);
    f.assertDone(A);
    expect(f.pub.read(f.git.tree(f.git.head(D)!), 'live/pushed.json')).toMatchObject({
      123: digest,
    });
  });

  it.each([
    ['snapshot', false],
    ['metadata', false],
    ['export', false],
    ['export', true],
  ] as const)(
    'fails closed for a receipt with a valid signed marker and a mismatched %s (landed=%s)',
    async (part, landed) => {
      const f = await setup();
      await f.request(A);
      const create = f.pub.createCandidate.bind(f.pub);
      f.pub.createCandidate = (opId, blob, live, receipt) => {
        const changed = structuredClone(f.tooltip);
        if (part === 'metadata') changed.text.en!.updatedBy = 'someone-else';
        else changed.text.en!.text = 'different text';
        if (part !== 'export') receipt.entries[0].tooltipBlob = f.git.writeBlob(encode(changed));
        if (part !== 'snapshot')
          receipt.exported = exportLegacy([changed], receipt.now, f.options.facts);
        const candidate = create(opId, blob, live, receipt);
        if (landed) f.git.cas(L, live, candidate.c);
        return candidate;
      };
      const live = f.git.head(L);
      if (landed) {
        await expect(f.pub.operation(A)).rejects.toThrow(
          'Publication already landed. Operator required',
        );
        expect(f.git.tree(f.git.head(D)!)[paths(A).log]).toBeUndefined();
        expect(f.git.tree(f.git.head(D)!)[paths(A).request]).toBeDefined();
      } else {
        await f.pub.operation(A);
        expect(f.pub.read(f.git.tree(f.git.head(D)!), paths(A).log)).toMatchObject({
          result: {
            status: 'rejected',
            error: expect.stringMatching(
              /receipt marker|frozen source snapshot|export or upload markers/,
            ),
          },
        });
      }
      expect(f.git.head(L) === live).toBe(!landed);
      expect(f.pub.read(f.git.tree(f.git.head(D)!), 'live/pushed.json')).toEqual({});
    },
  );

  it.each([true, false])(
    'inactive: an unrelated publish cannot restore an absent pick stub (inactive=%s)',
    async (inactive) => {
      const f = await setup();
      f.options.sandboxConflicts = { 700: [123, 124] };
      f.options.facts[124] = { name: 'Other', type: 'perk' };
      const other = {
        ...f.tooltip,
        hash: 124,
        text: { en: { ...f.tooltip.text.en!, text: 'Other' } },
      };
      f.change(D, {
        'tooltips/124.json': other,
        'config/sandbox-pointers.json': {
          version: 1,
          pointers: { 700: { to: 123, candidates: [123, 124], by: 1, at: '2026-11-14T00:00:00Z' } },
        },
        'config/inactive.json': {
          700: { by: 1, at: '2026-11-14T00:00:00Z', ...(!inactive ? { inactive: false } : {}) },
        },
      });
      const before = f.pub.read<LegacyInput>(f.git.tree(f.git.head(L)!), 'liveDescriptions.json')!;
      f.change(L, {
        'liveDescriptions.json': {
          ...before,
          perks: { ...before.perks, ...exportLegacy([f.tooltip], pushTime, f.options.facts) },
        },
      });
      await f.request(A, [124], { 124: await publishableHash(other) });
      await f.pub.run();
      f.assertDone(A);
      const after = f.pub.read<LegacyInput>(f.git.tree(f.git.head(L)!), 'liveDescriptions.json')!;
      expect(after.perks[123]).toBeDefined();
      expect(after.perks[124]).toBeDefined();
      expect(after.perks[700]).toBeUndefined();
    },
  );

  it.each(['{', 'null'])(
    'inactive: malformed JSON %s is rejected terminally without wedging bundle or later requests',
    async (raw) => {
      const f = await setup();
      await f.request(A);
      await f.request(B);
      const h = f.git.head(D)!,
        tree = f.git.tree(h);
      tree['config/inactive.json'] = f.git.writeBlob(raw);
      f.git.cas(D, h, f.git.commit(h, tree, 'Invalid inactive fixture'));
      const before = f.git.head(L);
      await f.pub.run();
      expect(f.git.head(L)).toBe(before);
      for (const id of [A, B])
        expect(f.pub.read(f.git.tree(f.git.head(D)!), paths(id).log)).toMatchObject({
          result: { status: 'rejected', error: expect.stringContaining('config/inactive.json') },
        });
      const bundle = f.pub.read<Record<string, unknown>>(
        f.git.tree(f.git.head('refs/heads/editor-data-bundle')!),
        'bundle.json',
      )!;
      expect(bundle.inactiveMoves).toBeUndefined();
      f.change(D, { 'config/inactive.json': {} });
      const C = A.slice(0, -1) + '3';
      await f.request(C);
      await f.pub.run();
      f.assertDone(C);
    },
  );

  it('inactive: publishes only selected removals and re-adds, with exact eight-format output and unchanged saved text', async () => {
    const f = await setup();
    f.options.aliases[789] = { to: 123, kind: 'frame' };
    f.options.facts[789] = { name: 'Frame copy', type: 'perk' };
    f.options.facts[124] = { name: 'Retained', type: 'perk' };
    const other = {
      ...f.tooltip,
      hash: 124,
      text: { en: { ...f.tooltip.text.en!, text: 'Retained' } },
    };
    f.change(D, { 'tooltips/124.json': other });
    await f.request(A, [123, 124], {
      123: await publishableHash(f.tooltip, f.options.aliases),
      124: await publishableHash(other, f.options.aliases),
    });
    await f.pub.run();
    f.assertDone(A);
    const readLive = () =>
      f.pub.read<LegacyInput>(f.git.tree(f.git.head(L)!), 'liveDescriptions.json')!;
    const before = readLive();
    const stamp = { by: 1, at: '2026-11-14T00:00:00Z' };
    const moves = { 123: stamp, 124: stamp };
    f.change(D, { 'config/inactive.json': moves });
    expect(readLive()).toEqual(before);
    await f.request(B, [123], { 123: await inactiveRemovalHash(123) });
    await f.pub.run();
    f.assertDone(B);
    const after = readLive();
    expect(after.perks[123]).toBeUndefined();
    expect(after.perks[789]).toBeUndefined();
    expect(after.perks[124]).toEqual(before.perks[124]);
    for (const preset of legacyPresets) {
      const original = JSON.parse(new TextDecoder().decode(buildLegacy(before, preset)));
      const actual = JSON.parse(new TextDecoder().decode(buildLegacy(after, preset)));
      delete original[123];
      delete original[789];
      expect(actual, preset).toEqual(original);
    }
    expect(f.pub.read(f.git.tree(f.git.head(D)!), 'tooltips/123.json')).toEqual(f.tooltip);
    const restored = { ...moves, 123: { ...stamp, inactive: false as const } };
    f.change(D, { 'config/inactive.json': restored });
    const C = A.slice(0, -1) + '3';
    await f.request(C, [123], {
      123: await inactivePublishableHash(f.tooltip, f.options.aliases, restored),
    });
    await f.pub.run();
    f.assertDone(C);
    expect(readLive().perks[123]).toBeDefined();
    expect(readLive().perks[789]).toBeDefined();
    expect(readLive().perks[124]).toEqual(before.perks[124]);
  });

  it('inactive: refuses retained live importers before any candidate, then accepts an atomic importer edit and removal', async () => {
    const f = await setup();
    f.options.facts[125] = { name: 'Importer', type: 'perk' };
    const importer = {
      ...f.tooltip,
      hash: 125,
      text: { en: { ...f.tooltip.text.en!, text: 'import main from 123' } },
    };
    const edited = { ...importer, text: { en: { ...importer.text.en!, text: 'No import now' } } };
    const originalLive = f.pub.read<LegacyInput>(
      f.git.tree(f.git.head(L)!),
      'liveDescriptions.json',
    )!;
    f.change(L, {
      'liveDescriptions.json': {
        ...originalLive,
        perks: {
          ...originalLive.perks,
          ...exportLegacy([f.tooltip, importer], pushTime, f.options.facts),
        },
      },
    });
    f.change(D, {
      'tooltips/125.json': edited,
      'config/inactive.json': { 123: { by: 1, at: '2026-11-14T00:00:00Z' } },
    });
    const before = f.git.head(L);
    await f.request(A, [123], { 123: await inactiveRemovalHash(123) });
    await f.pub.run();
    expect(f.git.head(L)).toBe(before);
    expect(f.git.head(paths(A).candidate)).toBeUndefined();
    expect(f.pub.read(f.git.tree(f.git.head(D)!), paths(A).log)).toMatchObject({
      result: { status: 'rejected', error: expect.stringContaining('imports inactive') },
    });
    await f.request(B, [123, 125], {
      123: await inactiveRemovalHash(123),
      125: await publishableHash(edited),
    });
    await f.pub.run();
    f.assertDone(B);
    const live = f.pub.read<{ perks: Record<string, unknown> }>(
      f.git.tree(f.git.head(L)!),
      'liveDescriptions.json',
    )!;
    expect(live.perks[123]).toBeUndefined();
    expect(live.perks[125]).toBeDefined();
  });

  it('inactive: refuses malformed storage terminally, and permits a textless item removal without a tooltip file', async () => {
    const f = await setup();
    f.change(D, { 'config/inactive.json': { 123: { by: 'bad' } } });
    await f.request(A);
    const before = f.git.head(L);
    await f.pub.run();
    expect(f.git.head(L)).toBe(before);
    expect(f.pub.read(f.git.tree(f.git.head(D)!), paths(A).log)).toMatchObject({
      result: { status: 'rejected', error: expect.stringContaining('config/inactive.json') },
    });
    f.change(D, { 'config/inactive.json': { 555: { by: 1, at: '2026-11-14T00:00:00Z' } } });
    await f.request(B, [555], { 555: await inactiveRemovalHash(555) });
    await f.pub.run();
    f.assertDone(B);
    expect(f.git.tree(f.git.head(D)!)['tooltips/555.json']).toBeUndefined();
  });

  it('inactive: rebase rejects a live importer added after candidate creation', async () => {
    const f = await setup();
    const seed = f.pub.read<LegacyInput>(f.git.tree(f.git.head(L)!), 'liveDescriptions.json')!;
    f.change(L, {
      'liveDescriptions.json': {
        ...seed,
        perks: { ...seed.perks, ...exportLegacy([f.tooltip], pushTime, f.options.facts) },
      },
    });
    f.change(D, { 'config/inactive.json': { 123: { by: 1, at: '2026-11-14T00:00:00Z' } } });
    await f.request(A, [123], { 123: await inactiveRemovalHash(123) });
    const atomic = f.git.casMany.bind(f.git);
    let race = true;
    const spy = vi.spyOn(f.git, 'casMany').mockImplementation((updates) => {
      if (race) {
        race = false;
        const live = f.pub.read<LegacyInput>(f.git.tree(f.git.head(L)!), 'liveDescriptions.json')!;
        f.options.facts[125] = { name: 'Concurrent importer', type: 'perk' };
        const importer = {
          ...f.tooltip,
          hash: 125,
          text: { en: { ...f.tooltip.text.en!, text: 'import main from 123' } },
        };
        f.change(L, {
          'liveDescriptions.json': {
            ...live,
            perks: { ...live.perks, ...exportLegacy([importer], pushTime, f.options.facts) },
          },
        });
      }
      atomic(updates);
    });
    try {
      await f.pub.run();
    } finally {
      spy.mockRestore();
    }
    expect(race).toBe(false);
    expect(f.pub.read(f.git.tree(f.git.head(D)!), paths(A).log)).toMatchObject({
      result: { status: 'rejected', error: expect.stringContaining('imports inactive') },
    });
    const live = f.pub.read<LegacyInput>(f.git.tree(f.git.head(L)!), 'liveDescriptions.json')!;
    expect(live.perks[123]).toBeDefined();
    expect(live.perks[125]).toBeDefined();
  });

  it('inactive: a frozen candidate rechecks its move when the data file changes before landing', async () => {
    const f = await setup();
    const stamp = { by: 1, at: '2026-11-14T00:00:00Z' };
    f.change(D, { 'config/inactive.json': { 123: stamp } });
    await f.request(A, [123], { 123: await inactiveRemovalHash(123) });
    const cas = f.git.cas.bind(f.git);
    let changed = false;
    const spy = vi.spyOn(f.git, 'cas').mockImplementation((ref, old, next) => {
      cas(ref, old, next);
      if (ref === paths(A).candidate && !changed) {
        changed = true;
        f.change(D, { 'config/inactive.json': { 123: { ...stamp, inactive: false } } });
      }
    });
    try {
      await f.pub.run();
    } finally {
      spy.mockRestore();
    }
    expect(f.pub.read(f.git.tree(f.git.head(D)!), paths(A).log)).toMatchObject({
      result: { status: 'rejected', code: 'selected-rows-changed' },
    });
    expect(changed).toBe(true);
    expect(
      f.pub.read<LegacyInput>(f.git.tree(f.git.head(L)!), 'liveDescriptions.json')!.perks[123],
    ).toBeUndefined();
    expect(f.pub.read(f.git.tree(f.git.head(D)!), 'config/inactive.json')).toEqual({
      123: { ...stamp, inactive: false },
    });
  });

  const C = A.slice(0, -1) + '3';
  const E = A.slice(0, -1) + '4';
  const at = (minute: number) => `2026-11-14T00:0${minute}:00Z`;
  const clear = (tooltip: Tooltip): Tooltip => ({
    ...tooltip,
    text: { ...tooltip.text, en: { ...tooltip.text.en!, text: '', updatedAt: at(1) } },
  });
  type Setup = Awaited<ReturnType<typeof setup>>;
  const perks = (f: Setup) =>
    f.pub.read<LegacyInput>(f.git.tree(f.git.head(L)!), 'liveDescriptions.json')!.perks;
  const data = <T>(f: Setup, path: string) => f.pub.read<T>(f.git.tree(f.git.head(D)!), path);
  /** What Review names for the clear it shows: the saved text and the published marker. */
  const reviewed = (f: Setup, saved = data<Tooltip>(f, 'tooltips/123.json')!) =>
    clearedReviewHash(saved, data<Record<string, string>>(f, 'live/pushed.json')![123]);
  const result = (f: Setup, id: string) => data<{ result: object }>(f, paths(id).log)!.result;
  const englishChanged = (f: Setup) => {
    f.pub.bundle();
    const head = f.git.head('refs/heads/editor-data-bundle')!;
    return f.pub.read<{ englishChanged?: number[] }>(f.git.tree(head), 'bundle.json')!
      .englishChanged;
  };
  /** 123 published with English and German, with a frame stub, next to an unrelated 124. */
  async function clearedSetup() {
    const f = await setup();
    f.options.aliases[789] = { to: 123, kind: 'frame' };
    f.options.facts[789] = { name: 'Frame copy', type: 'perk' };
    f.options.facts[124] = { name: 'Retained', type: 'perk' };
    const en = f.tooltip.text.en!;
    const first: Tooltip = {
      ...f.tooltip,
      text: { en, de: { ...en, text: 'Deutsch', sourceUpdatedAt: en.updatedAt } },
    };
    const other: Tooltip = { ...f.tooltip, hash: 124, text: { en: { ...en, text: 'Retained' } } };
    f.change(D, { 'tooltips/123.json': first, 'tooltips/124.json': other });
    await f.request(A, [123, 124], {
      123: await publishableHash(first, f.options.aliases),
      124: await publishableHash(other, f.options.aliases),
    });
    await f.pub.run();
    f.assertDone(A);
    return { f, first, other };
  }

  it('cleared: publishes the removal of only the cleared row, and its English brings it back', async () => {
    const { f, first } = await clearedSetup();
    const readLive = () =>
      f.pub.read<LegacyInput>(f.git.tree(f.git.head(L)!), 'liveDescriptions.json')!;
    const before = readLive();
    expect(before.perks[789]).toBeDefined();
    expect(englishChanged(f)).toBeUndefined();
    const cleared = clear(first);
    f.change(D, { 'tooltips/123.json': cleared });
    expect(englishChanged(f)).toEqual([123]);
    const marker = await inactiveRemovalHash(123);
    await f.request(B, [123], { 123: await reviewed(f) });
    await f.pub.run();
    f.assertDone(B);
    const after = readLive();
    expect(after).toEqual({
      ...before,
      perks: Object.fromEntries(
        Object.entries(before.perks).filter(([hash]) => hash !== '123' && hash !== '789'),
      ),
    });
    for (const preset of legacyPresets) {
      const original = JSON.parse(new TextDecoder().decode(buildLegacy(before, preset)));
      delete original[123];
      delete original[789];
      expect(JSON.parse(new TextDecoder().decode(buildLegacy(after, preset))), preset).toEqual(
        original,
      );
    }
    expect(data(f, 'tooltips/123.json')).toEqual(cleared);
    expect(data(f, 'live/tooltips/123.json')).toEqual(cleared);
    expect(data(f, 'live/pushed.json')).toMatchObject({ 123: marker });
    expect(data(f, 'config/inactive.json')).toBeUndefined();
    expect(englishChanged(f)).toBeUndefined();

    // A later translation has nothing to publish, whichever way it is asked for.
    const german = {
      ...cleared,
      text: { ...cleared.text, de: { ...cleared.text.de!, text: 'Neu' } },
    };
    f.change(D, { 'tooltips/123.json': german });
    await f.request(C, [123], { 123: await publishableHash(german, f.options.aliases) });
    await f.pub.run();
    expect(result(f, C)).toMatchObject({
      status: 'rejected',
      error: expect.stringContaining('no text'),
    });
    expect(readLive()).toEqual(after);

    const back = {
      ...german,
      text: { ...german.text, en: { ...first.text.en!, text: 'Back', updatedAt: at(2) } },
    };
    f.change(D, { 'tooltips/123.json': back });
    expect(englishChanged(f)).toEqual([123]);
    await f.request(E, [123], { 123: await publishableHash(back, f.options.aliases) });
    await f.pub.run();
    f.assertDone(E);
    expect(readLive().perks[123]).toMatchObject({ editor: { en: { main: 'Back' } } });
    expect(readLive().perks[789]).toEqual(before.perks[789]);
    expect(readLive().perks[124]).toEqual(before.perks[124]);
  });

  it.each(['import main from 123', 'association'] as const)(
    'cleared: refuses a retained live reader (%s), then publishes its edit and the removal together',
    async (kind) => {
      const { f, first, other } = await clearedSetup();
      const reader: Tooltip =
        kind === 'association'
          ? { ...other, associated: [123] }
          : { ...other, text: { en: { ...other.text.en!, text: kind } } };
      const live = f.pub.read<LegacyInput>(f.git.tree(f.git.head(L)!), 'liveDescriptions.json')!;
      f.change(L, {
        'liveDescriptions.json': {
          ...live,
          perks: { ...live.perks, ...exportLegacy([reader], pushTime, f.options.facts) },
        },
      });
      f.change(D, { 'tooltips/123.json': clear(first), 'live/tooltips/124.json': reader });
      const before = f.git.head(L);
      const marker = await reviewed(f);
      await f.request(B, [123], { 123: marker });
      await f.pub.run();
      expect(f.git.head(L)).toBe(before);
      expect(result(f, B)).toMatchObject({
        status: 'rejected',
        error: expect.stringMatching(/(imports|associates) cleared tooltip 123/),
      });
      // The saved reader still reads it: refused together too.
      f.change(D, { 'tooltips/124.json': reader });
      await f.request(C, [123, 124], { 123: marker, 124: await publishableHash(reader) });
      await f.pub.run();
      expect(f.git.head(L)).toBe(before);
      expect(result(f, C)).toMatchObject({ status: 'rejected' });
      f.change(D, { 'tooltips/124.json': other });
      await f.request(E, [123, 124], { 123: marker, 124: await publishableHash(other) });
      await f.pub.run();
      f.assertDone(E);
      expect(perks(f)[123]).toBeUndefined();
      expect(perks(f)[124]).toBeDefined();
    },
  );

  it('cleared: a save or a publish that moved on refuses the queued request', async () => {
    const { f, first } = await clearedSetup();
    const marker = await reviewed(f, clear(first));
    const edited = {
      ...first,
      text: { ...first.text, en: { ...first.text.en!, text: 'Edited', updatedAt: at(1) } },
    };
    // Cleared while a publish of its text waits.
    f.change(D, { 'tooltips/123.json': edited });
    await f.request(B, [123], { 123: await publishableHash(edited, f.options.aliases) });
    f.change(D, { 'tooltips/123.json': clear(first) });
    const live = f.git.head(L);
    await f.pub.run();
    expect(result(f, B)).toMatchObject({ status: 'stale' });
    // Typed back while its removal waits.
    await f.request(C, [123], { 123: marker });
    f.change(D, { 'tooltips/123.json': first });
    await f.pub.run();
    expect(result(f, C)).toMatchObject({ status: 'stale' });
    expect(f.git.head(L)).toBe(live);
    // Two people publish the same removal.
    f.change(D, { 'tooltips/123.json': clear(first) });
    await f.request(E, [123], { 123: marker });
    const F = A.slice(0, -1) + '5';
    await f.request(F, [123], { 123: marker });
    await f.pub.run();
    f.assertDone(E);
    expect(result(f, F)).toMatchObject({ status: 'stale' });
    expect(perks(f)[123]).toBeUndefined();
  });

  it('cleared: publishes only the saved text and the published version that were reviewed', async () => {
    const { f, first } = await clearedSetup();
    const live = f.git.head(L);
    const refused = async (id: string, expected: string) => {
      await f.request(id, [123], { 123: expected });
      await f.pub.run();
      expect(result(f, id)).toMatchObject({ status: 'stale' });
      expect(f.git.head(L)).toBe(live);
    };
    f.change(D, { 'tooltips/123.json': clear(first) });
    // The removal marker alone names no review.
    await refused(B, await inactiveRemovalHash(123));
    // Another version was published since.
    const before = await reviewed(f);
    const refreshed: Tooltip = {
      ...first,
      text: { ...first.text, de: { ...first.text.de!, text: 'Neue Übersetzung' } },
    };
    const markers = data<Record<string, string>>(f, 'live/pushed.json')!;
    f.change(D, {
      'live/pushed.json': { ...markers, 123: await publishableHash(refreshed, f.options.aliases) },
      'live/tooltips/123.json': refreshed,
    });
    await refused(C, before);
    // Typed back and cleared again by someone else.
    const reviewedClear = await reviewed(f);
    const again = clear(first);
    again.text.en = { ...again.text.en!, updatedAt: at(3) };
    f.change(D, { 'tooltips/123.json': again });
    await refused(E, reviewedClear);
  });

  it('cleared: a refill of the published text in the same part does not keep the row', async () => {
    const { f, first } = await clearedSetup();
    const parent = f.git.head(L)!;
    const sourceCommit = f.change(D, { 'tooltips/123.json': clear(first) });
    const { perks: merged } = JSON.parse(
      f.pub.merge(parent, {
        opId: B,
        liveParent: parent,
        sourceCommit,
        now: pushTime,
        entries: [
          {
            hash: 123,
            digest: await inactiveRemovalHash(123),
            tooltipBlob: f.git.tree(sourceCommit)['tooltips/123.json'],
          },
        ],
        exported: { 123: perks(f)[123] },
        changed: [123],
        requester: { id: 2, login: 'bob' },
        inPlace: { globals: [], refills: [123] },
      } as unknown as Parameters<Publisher['merge']>[1]).bytes,
    ) as { perks: Record<string, unknown> };
    expect(merged[123]).toBeUndefined();
    expect(merged[789]).toBeUndefined();
  });

  it('cleared: a frozen candidate is refused when the text comes back before landing', async () => {
    const { f, first } = await clearedSetup();
    f.change(D, { 'tooltips/123.json': clear(first) });
    await f.request(B, [123], { 123: await reviewed(f) });
    const cas = f.git.cas.bind(f.git);
    let changed = false;
    const spy = vi.spyOn(f.git, 'cas').mockImplementation((ref, old, next) => {
      cas(ref, old, next);
      if (ref === paths(B).candidate && !changed) {
        changed = true;
        f.change(D, { 'tooltips/123.json': first });
      }
    });
    try {
      await f.pub.run();
    } finally {
      spy.mockRestore();
    }
    expect(changed).toBe(true);
    expect(result(f, B)).toMatchObject({ status: 'rejected', code: 'selected-rows-changed' });
    expect(perks(f)[123]).toBeDefined();
  });

  it('cleared: an entry published without English, or never published, is never a removal', async () => {
    const { f, first } = await clearedSetup();
    const empty: Tooltip = { ...clear(first), text: { en: clear(first).text.en! } };
    const marker = await inactiveRemovalHash(123);
    f.change(D, {
      'tooltips/123.json': { ...empty, associated: [124] },
      'live/tooltips/123.json': empty,
      'live/pushed.json': { 123: await publishableHash(empty) },
    });
    const live = f.git.head(L);
    expect(englishChanged(f)).toBeUndefined();
    await f.request(B, [123], { 123: marker });
    await f.pub.run();
    expect(result(f, B)).toMatchObject({ status: 'stale' });
    f.change(D, { 'tooltips/123.json': empty, 'live/pushed.json': {} });
    await f.request(C, [123], { 123: marker });
    await f.pub.run();
    expect(result(f, C)).toMatchObject({ status: 'stale' });
    expect(f.git.head(L)).toBe(live);
    // A malformed published version does not stop the bundle.
    f.change(D, {
      'live/tooltips/123.json': { hash: 123 },
      'live/pushed.json': { 123: await publishableHash(first) },
    });
    expect(englishChanged(f)).toBeUndefined();
    f.change(D, { 'live/tooltips/123.json': empty });
    // Its first English lists as gained, so a later clear in the same tab is not a removal.
    f.change(D, {
      'tooltips/123.json': first,
      'live/pushed.json': { 123: await publishableHash(empty) },
    });
    expect(englishChanged(f)).toEqual([123]);
  });

  it('cleared: an Inactive move of the same tooltip decides first', async () => {
    const { f, first } = await clearedSetup();
    f.change(D, {
      'tooltips/123.json': clear(first),
      'config/inactive.json': { 123: { by: 1, at: at(1) } },
    });
    await f.request(B, [123], { 123: await inactiveRemovalHash(123) });
    await f.pub.run();
    f.assertDone(B);
    expect(perks(f)[123]).toBeUndefined();
    // Moved back out without English: nothing to publish.
    const moves = { 123: { by: 1, at: at(2), inactive: false as const } };
    f.change(D, { 'config/inactive.json': moves });
    await f.request(C, [123], {
      123: await inactivePublishableHash(clear(first), f.options.aliases, moves),
    });
    await f.pub.run();
    expect(result(f, C)).toMatchObject({
      status: 'rejected',
      error: expect.stringContaining('no text'),
    });
  });

  async function aliasSetup() {
    const f = await setup();
    const items = Object.fromEntries(
      [123, 124].map((hash) => [
        hash,
        {
          hash,
          name: 'Thing',
          categoryId: 'weapon-trait',
          inGameDescription: 'In game',
          plugCategoryHash: 20,
          isEnhanced: false,
          exotic: false,
        },
      ]),
    );
    f.options.aliasFacts = { generatorSha: f.options.generatorSha, items };
    f.options.facts = Object.fromEntries(
      [123, 124].map((hash) => [hash, { name: 'Thing', type: 'Weapon Trait' }]),
    );
    const groups = (canonical = 123): AliasGroups => ({
      version: 1,
      rejected: {},
      groups: {
        [canonical]: {
          members: [123, 124],
          kind: 'S',
          basis: { name: 'Thing', categoryId: 'weapon-trait' },
          by: { id: '1', login: 'alice' },
          at: '2026-11-15T00:00:00Z',
        },
      },
    });
    const config = groups();
    f.change(D, { 'config/alias-groups.json': config });
    const live = () =>
      f.pub.read<LegacyInput>(f.git.tree(f.git.head(L)!), 'liveDescriptions.json')!.perks;
    const aliases = () => f.pub.aliasesAt(f.git.tree(f.git.head(D)!));
    const log = (id: string) =>
      f.pub.read<{ result: { status: string; error?: string } }>(
        f.git.tree(f.git.head(D)!),
        paths(id).log,
      )!.result;
    return { ...f, groups, config, live, aliases, log };
  }

  it('alias groups: reject stale review, publish members, recanonicalize, and restore ungrouped text', async () => {
    const f = await aliasSetup();
    await f.request(A);
    await f.pub.run();
    expect(f.log(A).status).toBe('stale');
    await f.request(B, [124], { 124: await publishableHash(f.tooltip, f.aliases()) });
    await f.pub.run();
    f.assertDone(B);
    expect(f.live()[124]).toMatchObject({ aliasOf: 123, aliasKind: 'name' });
    const replacement = { ...f.tooltip, hash: 124 };
    f.change(D, { 'config/alias-groups.json': f.groups(124), 'tooltips/124.json': replacement });
    const C = A.slice(0, -1) + '3';
    await f.request(C, [123], { 123: await publishableHash(replacement, f.aliases()) });
    await f.pub.run();
    f.assertDone(C);
    expect(f.live()[123]).toMatchObject({ aliasOf: 124, aliasKind: 'name' });
    expect(f.live()[124]).not.toHaveProperty('aliasOf');
    f.change(D, {
      'config/alias-groups.json': { version: 1, groups: {}, rejected: {} },
      'tooltips/123.json': f.tooltip,
    });
    const E = A.slice(0, -1) + '4';
    await f.request(E, [124], { 124: await publishableHash(replacement, {}) });
    await f.pub.run();
    f.assertDone(E);
    expect(f.live()).not.toHaveProperty('123');
    const F = A.slice(0, -1) + '5';
    await f.request(F, [123], { 123: await publishableHash(f.tooltip, {}) });
    await f.pub.run();
    f.assertDone(F);
    expect(f.live()[123]).not.toHaveProperty('aliasOf');
    expect(f.live()[124]).not.toHaveProperty('aliasOf');
  });

  it('alias groups: a removed member stays live through other publishes until its own', async () => {
    const f = await aliasSetup();
    f.options.aliases = { 700: { to: 124, kind: 'sandbox' } };
    await f.request(A, [123], { 123: await publishableHash(f.tooltip, f.aliases()) });
    await f.pub.run();
    f.assertDone(A);
    expect(f.live()).toMatchObject({ 124: { aliasOf: 123 }, 700: { aliasOf: 123 } });
    const copy = { ...f.tooltip, hash: 124 };
    f.change(D, {
      'config/alias-groups.json': {
        version: 1,
        groups: {},
        rejected: {},
        removed: {
          124: { canonical: 123, by: { id: '1', login: 'alice' }, at: '2026-11-23T00:00:00Z' },
        },
      },
      'tooltips/124.json': copy,
    });
    const before = { 124: f.live()[124], 700: f.live()[700] };
    await f.request(B, [123], { 123: await publishableHash(f.tooltip, f.aliases()) });
    await f.pub.run();
    f.assertDone(B);
    expect({ 124: f.live()[124], 700: f.live()[700] }).toEqual(before);
    const C = A.slice(0, -1) + '3';
    await f.request(C, [124], { 124: await publishableHash(copy, f.aliases()) });
    await f.pub.run();
    f.assertDone(C);
    expect(f.live()[124]).not.toHaveProperty('aliasOf');
    expect(f.live()[700]).toMatchObject({ aliasOf: 124, aliasKind: 'sandbox' });
  });

  it.each(['missing', 'revision', 'partial', 'shape', 'drift', 'config', 'json'] as const)(
    'alias groups: fail closed on %s facts/config without touching live',
    async (invalid) => {
      const f = await aliasSetup();
      const before = f.git.head(L);
      if (invalid === 'missing') delete f.options.aliasFacts;
      if (invalid === 'revision') f.options.aliasFacts!.generatorSha = 'c'.repeat(40);
      if (invalid === 'partial')
        f.options.aliasFacts!.items = { 123: f.options.aliasFacts!.items[123]! };
      if (invalid === 'shape')
        f.options.aliasFacts!.items = {
          ...f.options.aliasFacts!.items,
          124: { ...f.options.aliasFacts!.items[124]!, categoryId: undefined as unknown as string },
        };
      if (invalid === 'drift')
        f.options.aliasFacts!.items = {
          ...f.options.aliasFacts!.items,
          124: { ...f.options.aliasFacts!.items[124]!, name: 'Changed by generator' },
        };
      if (invalid === 'config') f.change(D, { 'config/alias-groups.json': { version: 2 } });
      if (invalid === 'json') {
        const h = f.git.head(D)!,
          t = f.git.tree(h);
        t['config/alias-groups.json'] = f.git.writeBlob('{');
        f.git.cas(D, h, f.git.commit(h, t, 'Invalid config'));
      }
      await f.request(A);
      await f.pub.run();
      expect(f.log(A)).toMatchObject({
        status: 'rejected',
        error: expect.stringContaining('Invalid alias configuration'),
      });
      expect(f.git.head(L)).toBe(before);
      const bundle = f.pub.read<Record<string, unknown>>(
        f.git.tree(f.git.head('refs/heads/editor-data-bundle')!),
        'bundle.json',
      )!;
      expect(bundle).toHaveProperty(
        'aliasGroups',
        invalid === 'json' ? null : invalid === 'config' ? { version: 2 } : f.config,
      );
    },
  );

  it.each(['beforeS', 'liveRace', 'recovery'] as const)(
    'alias groups: recheck the current config on %s change',
    async (phase) => {
      const f = await aliasSetup();
      await f.request(A, [124], { 124: await publishableHash(f.tooltip, f.aliases()) });
      if (phase === 'beforeS') {
        f.change(D, { 'config/alias-groups.json': { version: 1, groups: {}, rejected: {} } });
        await f.pub.run();
        expect(f.log(A).status).toMatch(/stale|rejected/);
        return;
      }
      const cas = f.git.cas.bind(f.git);
      const atomic = f.git.casMany.bind(f.git);
      let changed = false;
      f.git.cas = (ref, old, next) => {
        cas(ref, old, next);
        if (phase === 'liveRace' && ref === paths(A).candidate && !changed) {
          changed = true;
          f.change(D, { 'config/alias-groups.json': { version: 1, groups: {}, rejected: {} } });
          if (phase === 'liveRace')
            f.change(L, {
              'liveDescriptions.json': { perks: { ...f.live() }, databaseSettings: { race: true } },
            });
        }
      };
      if (phase === 'recovery') {
        f.git.casMany = () => {
          throw new Error('runner crash');
        };
        await expect(f.pub.run()).rejects.toThrow('runner crash');
        f.git.cas = cas;
        f.git.casMany = atomic;
        f.change(D, { 'config/alias-groups.json': { version: 1, groups: {}, rejected: {} } });
      }
      await f.pub.run();
      f.git.cas = cas;
      expect(f.log(A).status).toMatch(/stale|rejected/);
      expect(f.pub.receipt(f.git.head(L)!, A)).toBeUndefined();
      expect(f.pub.read(f.git.tree(f.git.head(D)!), 'config/alias-groups.json')).toEqual({
        version: 1,
        groups: {},
        rejected: {},
      });
      const bundle = f.pub.read<Record<string, unknown>>(
        f.git.tree(f.git.head('refs/heads/editor-data-bundle')!),
        'bundle.json',
      )!;
      expect(bundle.sourceCommit).toBe(f.git.head(D));
      expect(bundle.aliasGroups).toEqual({ version: 1, groups: {}, rejected: {} });
    },
  );

  async function setup(liveBranch = 'converter-v2-test') {
    const liveRef = `refs/heads/${liveBranch}`;
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
        : new RemoteRepository(cache, {
            fileUrl: pathToFileURL(root).href,
            liveBranch: liveBranch as 'converter' | 'converter-v2-test',
          });
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const options: Options = {
      repo: 'test/local',
      dataBranch: 'editor-data',
      liveBranch,
      publicKey,
      keyFingerprint: createHash('sha256')
        .update(keys.publicKey.export({ type: 'spki', format: 'der' }))
        .digest('hex'),
      publisherSha: 'a'.repeat(40),
      publisherDigest: 'c'.repeat(64),
      generatorSha: 'b'.repeat(40),
      aliases: {},
      facts: { 123: { name: 'Thing', type: 'perk' } },
      now: () => pushTime,
      runUrl: 'local://fixture',
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
      liveRef,
      undefined,
      git.commit(
        undefined,
        {
          'liveDescriptions.json': git.writeBlob(
            encode({
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
        'Seed live',
      ),
    );
    activateGlobalsFixture(pub);
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

  it('publishes reviewed translation lanes atomically and preserves an ordinary publish', async () => {
    const f = await setup();
    await f.request();
    await f.pub.operation(A);
    const before = f.pub.read<LegacyInput>(f.git.tree(f.git.head(L)!), 'liveDescriptions.json')!;
    const de = { text: 'Geprüft', updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'dora' };
    const fr = { ...de, text: 'Vérifié', updatedBy: 'fabien' };
    const current = { ...f.tooltip, text: { ...f.tooltip.text, de, fr } };
    const pin = f.pub.read<{ capabilities: string[] }>(
      f.git.tree(f.git.head(D)!),
      '.publisher/PIN',
    )!;
    const permissions = {
      users: {
        '1': { login: 'alice', role: 'editor' },
        '2': { login: 'dora', role: 'translator', languages: ['de'], manages: ['de'] },
        '3': { login: 'fabien', role: 'translator', languages: ['fr'] },
        '4': { login: 'dan', role: 'translator', languages: ['de'] },
      },
    };
    f.change(D, {
      '.publisher/PIN': {
        ...pin,
        capabilities: [...pin.capabilities, translationPublishCapability],
      },
      'config/permissions.json': permissions,
      'tooltips/123.json': current,
    });
    const rows = async (tooltip = current) => {
      const bundle = await bundleTranslations(f.pub, f.git.tree(f.git.head(D)!), f.git.head(L)!, {
        123: tooltip,
      });
      return bundle.lanes;
    };
    const submit = async (
      opId: string,
      ready: NonNullable<Awaited<ReturnType<typeof rows>>['de']>[number],
      id: number,
    ) => {
      expect(ready.status).toBe('ready');
      if (ready.status !== 'ready') throw new Error('Missing review');
      const { kind, lang, expected, english, before, effects } = ready;
      const row: TranslationPublishRow =
        kind === 'tooltip'
          ? { kind, hash: ready.hash, lang, expected, english, before, effects }
          : {
              kind,
              id: ready.id,
              lang,
              expected,
              english,
              before,
              effects,
              affected: ready.affected,
            };
      const payload: TranslationPublishPayload = {
        kind: 'push',
        scope: 'translations',
        rows: [row],
        opId,
        repo: f.options.repo,
        dataBranch: f.options.dataBranch,
        liveBranch: f.options.liveBranch,
        requester: { id, login: id === 2 ? 'dora' : id === 3 ? 'fabien' : 'dan' },
        createdAt: '2026-11-03T12:00:00.000Z',
        intentDigest: '',
      };
      payload.intentDigest = await translationPublishIntentDigest(payload);
      const bytes = stableStringify(payload);
      f.change(D, { [paths(opId).request]: { payload: bytes, sig: f.sign(bytes) } });
    };
    const result = (id: string) =>
      f.pub.read<{ result: unknown }>(f.git.tree(f.git.head(D)!), paths(id).log)!.result;
    const next = (digit: number) => A.slice(0, -1) + digit;
    const reviewed = await rows();
    await submit(B, reviewed.de![0], 2);
    await submit(next(3), reviewed.fr![0], 3);
    await submit(next(4), reviewed.de![0], 4);
    expect(f.pub.queue(f.git.head(D)!)).toEqual([B, next(3), next(4)]);
    await f.pub.operation(B);
    const german = f.pub.read<LegacyInput>(f.git.tree(f.git.head(L)!), 'liveDescriptions.json')!;
    expect(result(B)).toMatchObject({
      status: 'done',
      rows: [{ hash: 123, lang: 'de', status: 'published' }],
    });
    expect(result(B)).not.toMatchObject({ error: expect.any(String) });
    expect(german.perks[123]).toMatchObject({
      ...before.perks[123],
      editor: { en: { main: 'reviewed' }, de: { main: de.text } },
    });
    expect(german.perks[123]).not.toHaveProperty('editor.fr');
    const publishedDe = f.pub.read<Tooltip>(f.git.tree(f.git.head(D)!), 'live/tooltips/123.json')!;
    expect(publishedDe).toEqual({ ...f.tooltip, text: { ...f.tooltip.text, de } });
    const candidate = f.git.head(L)!;
    await f.pub.verifyTranslationReceipt(f.pub.receipt(candidate, B)!, candidate);
    expect(f.pub.read(f.git.tree(f.git.head(D)!), translationRootsPath)).toMatchObject({
      destination: f.options.liveBranch,
      liveCommit: candidate,
      roots: { 123: f.git.tree(f.git.head(D)!)['live/tooltips/123.json'] },
    });
    await f.pub.operation(next(3));
    await f.pub.operation(next(4));
    expect(result(next(3))).toMatchObject({ status: 'done' });
    expect(result(next(4))).toMatchObject({ status: 'unchanged' });
    const pending = { ...current, text: { ...current.text, de: { ...de, text: 'Neu' } } };
    f.change(D, { 'tooltips/123.json': pending });
    const pendingRows = await rows(pending);
    await submit(next(5), pendingRows.de![0], 2);
    const englishPending = {
      ...pending,
      text: {
        ...pending.text,
        en: { ...current.text.en!, text: 'Pending English', updatedAt: '2026-11-02T00:00:00Z' },
      },
    };
    f.change(D, { 'tooltips/123.json': englishPending });
    await f.pub.operation(next(5));
    expect(result(next(5))).toMatchObject({
      status: 'rejected',
      rows: [{ reason: 'english-pending' }],
    });
    await f.request(next(6), [123], { 123: await publishableHash(englishPending) });
    await f.pub.operation(next(6));
    expect(result(next(6))).toMatchObject({ status: 'done' });
    const withdrawn = { ...englishPending, text: { en: englishPending.text.en, fr } };
    f.change(D, { 'tooltips/123.json': withdrawn });
    const removal = await rows(withdrawn as typeof current);
    await submit(next(7), removal.de![0], 2);
    await f.pub.operation(next(7));
    expect(result(next(7))).toMatchObject({ status: 'done' });
    const after = f.pub.read<LegacyInput>(f.git.tree(f.git.head(L)!), 'liveDescriptions.json')!;
    expect(after.perks[123]).not.toHaveProperty('editor.de');
    expect(after.perks[123]).not.toHaveProperty('updateTracker.descriptions.de');
    expect(after.perks[123]).toHaveProperty('editor.fr.main', fr.text);
  });
  it.skipIf(transport !== 'simulator').each(['hold', 'undo'] as const)(
    'preserves staged Current uploads when migration %s wins during the key fetch',
    async (transition) => {
      const f = await setup();
      const upstream = new LocalRepository(f.upstream);
      const active = f.pub.read<object>(upstream.tree(upstream.head(D)!), globalsInPlacePath)!;
      const stagedPath = currentSaveStagePaths.record(A);
      f.change(D, {
        [stagedPath]: {
          requester: { id: 1, login: 'alice' },
          status: 'uploading',
          parts: 1,
          updatedAt: '2020-01-01T00:00:00Z',
        },
      });
      const root = mkdtempSync(join(tmpdir(), 'publisher-hold-'));
      roots.push(root);
      const checkout = join(root, 'checkout');
      execFileSync('git', ['clone', '--branch', 'editor-data', f.upstream, checkout], {
        stdio: 'pipe',
      });
      let heldRefs: string | undefined;
      vi.stubEnv('GITHUB_TOKEN', 'fixture-token');
      vi.stubGlobal('fetch', async () => {
        if (transition === 'hold') {
          f.change(D, { [globalsInPlacePath]: { ...active, state: 'hold' } });
        } else {
          const head = upstream.head(D)!;
          const tree = upstream.tree(head);
          delete tree[globalsInPlacePath];
          upstream.cas(D, head, upstream.commit(head, tree, 'Undo the migration fence'));
        }
        heldRefs = upstream.git(['show-ref']);
        return Response.json({
          algorithm: 'Ed25519',
          publicKey: f.options.publicKey,
          fingerprint: f.options.keyFingerprint,
        });
      });
      const remoteGit = RemoteRepository.prototype.remoteGit;
      const transportStub = vi
        .spyOn(RemoteRepository.prototype, 'remoteGit')
        .mockImplementation(function (this: RemoteRepository, args) {
          return remoteGit.call(
            this,
            args.map((arg) =>
              arg === 'https://github.com/Database-Clarity/Live-Clarity-Database.git'
                ? pathToFileURL(f.upstream).href
                : arg,
            ),
          );
        });
      publisherConfig.enabled = true;
      try {
        const run = runPipeline(
          checkout,
          {
            ...f.options,
            repo: 'Database-Clarity/Live-Clarity-Database',
            keyEndpoint: 'https://worker.invalid/publish/key',
            publishWritesEnabled: true,
          },
          join(root, 'out'),
          true,
        );
        if (transition === 'hold') await run;
        else await expect(run).rejects.toThrow('requires an active config/globals-in-place.json');
        expect(heldRefs).toBeDefined();
        expect(upstream.git(['show-ref'])).toBe(heldRefs);
        expect(upstream.tree(upstream.head(D)!)[stagedPath]).toBeDefined();
      } finally {
        publisherConfig.enabled = false;
        transportStub.mockRestore();
      }
    },
  );
  it.each(['test', 'production', 'rejected', 'atomic-failure', 'stale', 'concurrent'])(
    'cutover handoff: %s',
    async (scenario) => {
      const liveBranch = scenario === 'test' ? 'converter-v2-test' : 'converter';
      const liveRef = `refs/heads/${liveBranch}`;
      const f = await setup(liveBranch);
      const engine = '// pinned fixture engine\n';
      const runtime = '// pinned fixture publisher\n';
      const digest = createHash('sha256').update(runtime).digest('hex');
      const verifier = readFileSync(
        'scripts/publisher/template/.publisher/verify-publication.mjs',
        'utf8',
      );
      f.options.verifierDigest = createHash('sha256').update(verifier).digest('hex');
      // Production installs its engine separately at G4, before enabling G5.
      if (liveBranch === 'converter') {
        const head = f.git.head(liveRef)!;
        f.git.cas(
          liveRef,
          head,
          f.git.commit(
            head,
            {
              ...f.git.tree(head),
              '.exports/PIN': f.git.writeBlob('c'.repeat(40) + '\n'),
              '.exports/engine.mjs': f.git.writeBlob(engine),
            },
            'Install fixture engine',
          ),
        );
      }
      const config = {
        ...f.options,
        repo: 'Database-Clarity/Live-Clarity-Database',
        keyEndpoint: 'https://worker.invalid/publish/key',
        publishWritesEnabled: true,
        publisherDigest: digest,
      };
      f.options.repo = config.repo;
      const data = f.git.head(D)!;
      f.git.cas(
        D,
        data,
        f.git.commit(
          data,
          {
            ...f.git.tree(data),
            '.publisher/config.json': f.git.writeBlob(encode(config)),
            '.publisher/PIN': f.git.writeBlob(
              encode({
                sourceSha: config.publisherSha,
                sha256: digest,
                capabilities: ['globalsRelease', 'globalsInPlaceV1'],
              }),
            ),
            '.publisher/publisher.mjs': f.git.writeBlob(runtime),
            '.publisher/verify-publication.mjs': f.git.writeBlob(verifier),
          },
          'Install fixture publisher',
        ),
      );
      await f.request(A, [123], scenario === 'rejected' ? { 123: '0'.repeat(64) } : undefined);
      const root = mkdtempSync(join(tmpdir(), 'cutover-handoff-'));
      roots.push(root);
      const checkout = join(root, 'checkout');
      execFileSync('git', ['clone', '--branch', 'editor-data', f.upstream, checkout], {
        stdio: 'pipe',
      });
      const out = join(root, 'out');
      const output = join(root, 'github-output');
      vi.stubEnv('GITHUB_TOKEN', 'fixture-token');
      vi.stubEnv('GITHUB_OUTPUT', output);
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
      let inject = true;
      const remoteGit = RemoteRepository.prototype.remoteGit;
      const transport = vi
        .spyOn(RemoteRepository.prototype, 'remoteGit')
        .mockImplementation(function (this: RemoteRepository, args) {
          const publish = args[0] === 'push' && args.includes('--atomic');
          if (inject && scenario === 'atomic-failure' && publish) throw new Error('Rejected push');
          if (inject && scenario === 'concurrent' && publish) {
            inject = false;
            f.change(liveRef, { 'concurrent.json': { retained: true } });
          }
          const result = remoteGit.call(
            this,
            args.map((arg) =>
              arg === 'https://github.com/Database-Clarity/Live-Clarity-Database.git'
                ? pathToFileURL(f.upstream).href
                : arg,
            ),
          );
          if (inject && scenario === 'stale' && publish) {
            inject = false;
            f.change(liveRef, { 'later.json': { retained: true } });
          }
          return result;
        });
      publisherConfig.enabled = true;
      try {
        const task = runPipeline(checkout, config, out, true);
        if (scenario === 'atomic-failure') {
          await expect(task).rejects.toThrow();
          expect(existsSync(output)).toBe(false);
          expect(f.pub.receipt(f.git.head(liveRef)!, A)).toBeUndefined();
          inject = false;
          await runPipeline(checkout, config, out, true);
        } else await task;
        const lines = readFileSync(output, 'utf8');
        const production = liveBranch === 'converter' && !['rejected', 'stale'].includes(scenario);
        expect(lines).toContain(`production_push=${production}\n`);
        const result = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'));
        if (['rejected', 'stale'].includes(scenario)) {
          expect(result.publications).toEqual([]);
          return;
        }
        expect(result.publications).toHaveLength(1);
        const identity = result.publications[0];
        expect(identity).toMatchObject({
          commit: f.git.head(liveRef),
          opId: A,
          generatorSha: config.generatorSha,
          publisherSha: config.publisherSha,
          publisherDigest: digest,
          enginePin: liveBranch === 'converter' ? 'c'.repeat(40) : null,
        });
        expect(identity.inputBlob).toBe(f.git.tree(identity.commit)['liveDescriptions.json']);
        if (scenario === 'concurrent')
          expect(f.git.tree(identity.commit)['concurrent.json']).toBeDefined();
        if (production) {
          execFileSync('git', ['-C', checkout, 'fetch', 'origin'], { stdio: 'pipe' });
          const producer = join(root, 'producer');
          const converter = join(root, 'converter');
          for (const [dir, commit] of [
            [producer, identity.recordCommit],
            [converter, identity.commit],
          ]) {
            execFileSync('git', ['clone', '--no-checkout', f.upstream, dir], { stdio: 'pipe' });
            execFileSync('git', ['-c', 'core.autocrlf=false', '-C', dir, 'checkout', commit], {
              stdio: 'pipe',
            });
          }
          const verify = (value: unknown) =>
            execFileSync(
              process.execPath,
              ['scripts/publisher/template/.publisher/verify-publication.mjs', converter, producer],
              { env: { ...process.env, PUBLICATION: JSON.stringify(value) }, stdio: 'pipe' },
            );
          expect(() => verify(identity)).not.toThrow();
          for (const key of [
            'commit',
            'receiptBlob',
            'inputBlob',
            'inputSha256',
            'enginePin',
            'engineSha256',
            'generatorSha',
            'publisherDigest',
            'verifierSha256',
          ])
            expect(() =>
              verify({ ...identity, [key]: '0'.repeat(identity[key].length) }),
            ).toThrow();
        }
        // A crash after RECORD or a failed downstream job leaves no pending request.
        // Until an export pin confirms these inputs, a queue-less Retry re-emits them.
        writeFileSync(output, '');
        await runPipeline(checkout, config, out, true);
        expect(readFileSync(output, 'utf8')).toContain(`production_push=${production}\n`);
        if (production) {
          const pins = new LocalRepository(f.upstream);
          const ref = 'refs/heads/export-pins';
          pins.cas(
            ref,
            undefined,
            pins.commit(
              undefined,
              {
                'pins/latest.json': pins.writeBlob(
                  encode({
                    converterSha: identity.commit,
                    inputSha256: identity.inputSha256,
                    engine: identity.enginePin,
                    generatorSha: identity.generatorSha,
                  }),
                ),
              },
              'Confirm output fixture',
            ),
          );
          // Byte-identical publication has a receipt but reuses the existing output pin.
          await f.request(B);
        }
        writeFileSync(output, '');
        await runPipeline(checkout, config, out, true);
        expect(readFileSync(output, 'utf8')).toContain('production_push=false\n');
      } finally {
        transport.mockRestore();
        publisherConfig.enabled = false;
        vi.unstubAllEnvs();
      }
    },
  );
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
    pinGlobalsFixture(f.pub, 'scripts/publisher/template/.publisher');
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
    const atomic = f.git.casMany.bind(f.git);
    f.git.casMany = () => {
      throw new Error('RECORD unavailable');
    };
    await expect(f.pub.run()).rejects.toThrow('RECORD unavailable');
    const landed = f.git.head(L);
    f.git.casMany = atomic;
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
  it.each([false, true])(
    'RECORD closes a changed request blob as duplicate/conflict (conflict=%s)',
    async (conflict) => {
      const f = await setup();
      const { envelope, payload } = await f.request();
      await f.pub.operation(A);
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
      await f.pub.operation(A);
      f.assertDone();
      expect(
        f.pub.read(f.git.tree(f.git.head(D)!), paths(A).log.replace('.json', '.dup-1.json')),
      ).toMatchObject({ status: conflict ? 'conflict' : 'duplicate' });
    },
  );
  it('pinned runtime accepts additive partners and rejects invalid permissions without source writes', async () => {
    const f = await setup();
    pinGlobalsFixture(f.pub, 'scripts/publisher/template/.publisher');
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
      const root = mkdtempSync(join(tmpdir(), 'publisher-cli-'));
      roots.push(root);
      const dist = join(root, 'dist');
      execFileSync(process.execPath, ['scripts/publisher/build.mjs'], {
        stdio: 'pipe',
        env: { ...process.env, PUBLISHER_DIST: dist },
      });
      for (const directory of [dist, 'scripts/publisher/template/.publisher']) {
        pinGlobalsFixture(f.pub, directory);
        const before = f.git.git(['show-ref']);
        writeFileSync(join(root, 'config.json'), JSON.stringify(f.options));
        execFileSync(
          process.execPath,
          [
            join(directory, 'publisher.mjs'),
            '--dry-run',
            f.upstream,
            join(root, 'config.json'),
            join(root, 'out'),
          ],
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
        const replay = join(root, directory === dist ? 'dist.git' : 'template.git');
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
  it('unresolved atomic publication blocks later work and resumes the exact candidate', async () => {
    const f = await setup();
    await f.request();
    await f.request(B);
    const atomic = f.git.casMany.bind(f.git);
    f.git.casMany = () => {
      throw new Error('disconnect');
    };
    await expect(f.pub.run()).rejects.toThrow('disconnect');
    const c = f.git.head(paths(A).candidate);
    expect(c).toBeTruthy();
    expect(f.git.head(paths(B).candidate)).toBeUndefined();
    f.git.casMany = atomic;
    await f.pub.run();
    f.assertDone();
    f.assertDone(B);
    expect(
      f.pub.read<{ candidateCommit: string }>(f.git.tree(f.git.head(D)!), paths(A).log)!
        .candidateCommit,
    ).toBe(c);
  });
  it.each([true, false])(
    'reconciles a lost atomic acknowledgement and rechecks authority when unlanded (%s)',
    async (landed) => {
      const f = await setup();
      await f.request();
      const atomic = f.git.casMany.bind(f.git);
      f.git.casMany = (updates) => {
        if (landed) atomic(updates);
        throw new Error('disconnect');
      };
      await expect(f.pub.run()).rejects.toThrow('disconnect');
      const candidate = f.git.head(paths(A).candidate)!;
      expect(candidate).toBeTruthy();
      f.git.casMany = atomic;
      f.change(D, { 'config/permissions.json': { users: {} } });
      await f.pub.run();
      if (landed) f.assertDone();
      else {
        expect(f.pub.receipt(f.git.head(L)!, A)).toBeUndefined();
        expect(f.pub.read(f.git.tree(f.git.head(D)!), paths(A).log)).toMatchObject({
          result: { status: 'rejected' },
        });
      }
    },
  );
  it.each(['ambiguous', 'exists'])('uses persisted candidate: %s', async (mode) => {
    const f = await setup();
    await f.request();
    const cas = f.git.cas.bind(f.git);
    let stored = '';
    const atomic = f.git.casMany.bind(f.git);
    f.git.cas = (ref, old, next) => {
      if (ref === paths(A).candidate && !stored) {
        stored = next!;
        cas(ref, old, next);
        throw new Error(mode);
      }
      cas(ref, old, next);
    };
    if (mode === 'exists') {
      f.git.casMany = () => {
        throw new Error('crash');
      };
      await expect(f.pub.run()).rejects.toThrow();
      expect(f.pub.receipt(f.git.head(L)!, A)).toBeUndefined();
      expect(f.git.head(paths(A).candidate)).toBe(stored);
      f.git.casMany = atomic;
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
    const atomic = f.git.casMany.bind(f.git);
    let delayed: (() => void) | undefined;
    f.git.casMany = (updates) => {
      if (!delayed) {
        delayed = () => atomic(updates);
        f.change(L, { 'other.json': { other: true } });
      }
      atomic(updates);
    };
    await f.pub.run();
    f.assertDone();
    expect(() => delayed!()).toThrow(RefRace);
    expect(f.git.tree(f.git.head(L)!)['other.json']).toBeTruthy();
  });
  it('RECORD ref race preserves a concurrent unrelated save and records the approved tooltip', async () => {
    const f = await setup();
    await f.request();
    const source = f.git.head(D)!;
    const atomic = f.git.casMany.bind(f.git);
    let raced = false;
    f.git.casMany = (updates) => {
      if (!raced) {
        raced = true;
        f.change(D, { 'tooltips/124.json': { ...f.tooltip, hash: 124 } });
      }
      atomic(updates);
    };
    await f.pub.run(false);
    f.assertDone();
    const tree = f.git.tree(f.git.head(D)!);
    expect(tree['live/tooltips/123.json']).toBe(f.git.tree(source)['tooltips/123.json']);
    expect(tree['tooltips/124.json']).toBeDefined();
    expect(tree['live/tooltips/124.json']).toBeUndefined();
  });
  it('failed first atomic transaction prevents all LIVE writes, then recovers both in committed order', async () => {
    const f = await setup();
    await f.request(B);
    await f.request(A);
    expect(f.pub.queue(f.git.head(D)!)).toEqual([B, A]);
    const atomic = f.git.casMany.bind(f.git);
    f.git.casMany = () => {
      throw new Error('record unavailable');
    };
    await expect(f.pub.run()).rejects.toThrow('record unavailable');
    expect(f.pub.receipt(f.git.head(L)!, B)).toBeUndefined();
    expect(f.pub.receipt(f.git.head(L)!, A)).toBeUndefined();
    f.git.casMany = atomic;
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
  it.skipIf(transport !== 'simulator').each(['absent', 'picks', 'groups'] as const)(
    'parity verifies %s config at the receipt snapshot and matches the live bytes',
    async (mode) => {
      const f = mode === 'groups' ? await aliasSetup() : await setup();
      if (mode === 'picks') {
        f.options.sandboxConflicts = { 700: [123, 124] };
        f.change(D, {
          'config/sandbox-pointers.json': {
            version: 1,
            pointers: {
              700: { to: 123, candidates: [123, 124], by: 1, at: '2026-11-12T20:00:00Z' },
            },
          },
        });
      }
      await f.request(A, [123], {
        123: await publishableHash(f.tooltip, f.pub.aliasesAt(f.git.tree(f.git.head(D)!))),
      });
      await f.pub.run();
      f.assertDone(A);
      if (mode === 'groups')
        f.change(D, { 'config/alias-groups.json': { version: 1, groups: {}, rejected: {} } });
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
        vi.resetModules();
        await expect(import('./parity.js')).rejects.toThrow(/missing-adapters|Cannot find|ERR_/);
      } finally {
        process.argv = previous;
      }
      expect(readFileSync(join(dir, 'out', 'expected-liveDescriptions.json'), 'utf8')).toBe(
        readFileSync(join(dir, 'out', 'actual-liveDescriptions.json'), 'utf8'),
      );
    },
  );
  it('bundle.json never copies entry marks', async () => {
    const f = await setup();
    for (const marks of [
      {
        types: [],
        entries: { 123: [{ note: 'Retest' }] },
        compendium: { 123: { kind: 'no-match', by: 1, at: '2026-11-23T00:00:00Z' } },
      },
      'malformed',
    ]) {
      f.change(D, { 'config/marks.json': marks });
      f.pub.bundle();
      const bundle = f.pub.read<Record<string, unknown>>(
        f.git.tree(f.git.head('refs/heads/editor-data-bundle')!),
        'bundle.json',
      )!;
      expect(bundle).not.toHaveProperty('marks');
      expect(JSON.stringify(bundle)).not.toContain('Retest');
      expect(JSON.stringify(bundle)).not.toContain('no-match');
      expect(JSON.stringify(bundle)).not.toContain('malformed');
    }
  });

  it('publishes byte-identical output and digests with or without Compendium decisions', async () => {
    const publish = async (withDecisions: boolean) => {
      const f = await setup();
      if (withDecisions)
        f.change(D, {
          'config/marks.json': {
            types: [],
            entries: {},
            compendium: { 123: { kind: 'not-needed', by: 1, at: '2026-11-23T00:00:00Z' } },
          },
        });
      await f.request();
      await f.pub.operation(A);
      f.assertDone();
      return {
        live: f.git.tree(f.git.head(L)!)['liveDescriptions.json'],
        pushed: f.git.tree(f.git.head(D)!)['live/pushed.json'],
      };
    };
    expect(await publish(true)).toEqual(await publish(false));
  });

  it('bundle.json carries the globals catalogue at its head, in page order, with public sync', async () => {
    const f = await setup();
    const bundle = () =>
      f.pub.read<Record<string, unknown>>(
        f.git.tree(f.git.head('refs/heads/editor-data-bundle')!),
        'bundle.json',
      )!;
    f.pub.bundle();
    expect(bundle().globals).toBeNull();
    const record = (id: string, name: string) => ({
      version: 1,
      id,
      kind: 'variables',
      name,
      revision: 'r1',
      nameHistory: [],
      definitions: {
        en: { body: name, revision: 'r1', updatedAt: '2026-11-18T00:00:00Z', updatedBy: 'a' },
      },
    });
    const [b, a, c] = [
      record('g_bbbbbbbb', 'Beta'),
      record('g_aaaaaaaa', 'Alpha'),
      record('g_cccccccc', 'Gamma'),
    ];
    const secret = 'producer detail: token=not-public';
    f.change(D, {
      'globals/catalog.json': { version: 1, lastPage: 1 },
      'globals/pages/p0.json': { version: 1, ids: [b.id, a.id], nextCursor: 'p1' },
      'globals/pages/p1.json': { version: 1, ids: [c.id], nextCursor: null },
      ...Object.fromEntries([a, b, c].map((entry) => [`globals/entries/${entry.id}.json`, entry])),
      'globals/sync.json': {
        version: 1,
        status: 'sync-failed',
        causeIds: ['cause1'],
        causeEntries: { cause1: b.id },
        lastFailure: secret,
      },
    });
    f.pub.bundle();
    expect(bundle().sourceCommit).toBe(f.git.head(D));
    expect(bundle().globals).toEqual({
      entries: [b, a, c],
      sync: {
        status: 'sync-failed',
        causeIds: ['cause1'],
        lastFailure: 'Sync failed. Retry sync.',
        causeEntries: { cause1: b.id },
      },
    });
    expect(JSON.stringify(bundle())).not.toContain(secret);
    // A broken catalogue is unavailable (null), never a partial list; tooltips still update.
    f.change(D, { 'globals/pages/p1.json': { version: 1, ids: ['g_dddddddd'], nextCursor: null } });
    f.pub.bundle();
    expect(bundle().sourceCommit).toBe(f.git.head(D));
    expect(bundle().globals).toBeNull();
    expect(Object.keys(bundle().tooltips as object).length).toBeGreaterThan(0);
  });

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
    // Re-pin S3's head-coherent selection, pick cleanup scope, and absent-config fast path.
    // Re-pinned for sandbox picks: push merges config/sandbox-pointers.json (core
    // mergeSandboxPointers) like the publisher, and merges live perks with core mergeLivePerks
    // (keys the picks file names are recomputed); with no picks file, as here, every byte is the same.
    // Re-pinned for error-log redaction, and removal of the unused publisher PIN read.
    // Re-pinned for global-metadata detection and refusal of the non-atomic fallback
    // writer. With no global metadata, the golden consumer bytes remain unchanged.
    // Re-pinned for alias group removals: an unpublished removed member keeps its live stub. With
    // no removals in the config, as here, every byte is the same.
    // Re-pinned for cleared removals: a published tooltip whose English was cleared leaves as a
    // removal. With no cleared tooltip, as here, every byte is the same.
    for (const [path, expected] of [
      ['apps/worker/src/push.ts', '8c939e1d80c2162c6a5a777e0fec28573e4ca0d5'],
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
    worker.live.perks = {
      ...f.pub.read<{ perks: Record<string, unknown> }>(
        f.git.tree(f.git.head(L)!),
        'liveDescriptions.json',
      )!.perks,
      ...(worker.live.perks as Record<string, unknown>),
    };
    // This oracle now crosses the real consumer boundary, which reads both editor forms.
    for (const perk of Object.values(
      worker.live.perks as Record<
        string,
        { editor?: Record<string, { main: string; secondary?: string }> }
      >,
    ))
      for (const text of Object.values(perk.editor ?? {})) text.secondary ??= text.main;
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
    const store = (text: string) => f.git.git(['hash-object', '-w', '--stdin'], text).trim();
    for (const ref of [D, L]) {
      const h = f.git.head(ref)!;
      f.git.git(['read-tree', h]);
      f.git.git(
        ['update-index', '-z', '--index-info'],
        `100755 ${store('exec bytes')}\texecutable\0` +
          `120000 ${store('executable')}\tlink\0` +
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
      if (fault === 'not-landed') {
        await expect(f.pub.run()).rejects.toThrow('Injected disconnect');
        expect(f.pub.receipt(f.git.head(L)!, A)).toBeUndefined();
        expect(f.git.head(paths(A).candidate)).toBeDefined();
      }
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
  it('fails closed the same way when the build is ON but the installed config is not', async () => {
    publisherConfig.enabled = true;
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
            publishWritesEnabled: false,
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
      publisherConfig.enabled = false;
      remoteGit.mockRestore();
    }
  });
});
