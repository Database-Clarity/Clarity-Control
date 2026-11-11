// G-BUILD (spec section 9) and the pin gates of spec section 3, on the dry-run harness: the same
// scripts the workflows run, against local bare repositories and a simulated Pages project.
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { newStyleFile } from '../../src/index.js';
import { buildDist, fixturesDir, Harness } from './harness.js';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fixtureText = () => readFileSync(join(fixturesDir, 'legacy-input.json'), 'utf8');
/** The fixture input with one tooltip's English text changed (a new publish). */
const edited = (text: string, tag: string) => {
  const input = JSON.parse(text);
  const perk = input.perks['1001'];
  for (const part of ['main', 'secondary'] as const)
    perk.editor.en[part] = `${perk.editor.en[part]} ${tag}`;
  return JSON.stringify(input);
};

/** Perks that make clarity and braytech fail (an import only the main text exports), as in engine.test.ts. */
const failClarityBraytech = (text: string) => {
  const input = JSON.parse(text);
  const perk = (hash: number, main: string, secondary = main) => ({
    hash,
    name: `Perk ${hash}`,
    type: 'Weapon Perk',
    uploadedBy: 'test',
    lastUpload: 1,
    updateTracker: { descriptions: {} },
    editor: { en: { main, secondary } },
    inLiveDatabase: true,
    uploadToLive: true,
  });
  input.perks['60000'] = perk(60000, 'import X from 60001\nUses X');
  input.perks['60001'] = perk(60001, 'export X (\nfrom main\n)\nBody', 'Body');
  return JSON.stringify(input);
};
/** The fixture with perk 1001 (every symbol and class) reduced to plain text: a smaller vocabulary. */
const plainSymbols = (text: string) => {
  const input = JSON.parse(text);
  for (const part of ['main', 'secondary'] as const)
    input.perks['1001'].editor.en[part] = 'Plain text only';
  return JSON.stringify(input);
};
const readJson = (bytes: Uint8Array | undefined) =>
  JSON.parse(Buffer.from(bytes!).toString('utf8'));
const builtPaths = (manifest: { files: Record<string, { outcome: string }> }) =>
  Object.entries(manifest.files)
    .filter(([path, file]) => /\/v1\/f\d\.json$/.test(path) && file.outcome === 'built')
    .map(([path]) => path);

const style = (id: string, uid: string, extra: Record<string, unknown> = {}) => ({
  ...newStyleFile(id, 'structured', {
    categories: ['weapon-trait'],
    sandboxPerks: [],
    frameAliases: true,
    languages: ['en'],
    keys: ['name'],
    bungieIdentical: false,
  }),
  uid,
  ...extra,
});
const project = (id: string, files: unknown[], retained?: unknown[]) => ({
  schema: 1,
  id,
  name: id.toUpperCase(),
  files,
  ...(retained ? { retained } : {}),
});
const legacyFile = (id: string, uid: string, preset: string) => ({
  id,
  uid,
  formatVersion: 1,
  preset,
});

let harness: Harness;
beforeAll(() => buildDist(), 120_000);
afterEach(() => harness?.cleanup());

const expectOk = (run: { status: number; stderr: string; stdout: string }) => {
  if (run.status !== 0) throw new Error(`exit ${run.status}\n${run.stderr}\n${run.stdout}`);
};

describe('pins and the legacy job', () => {
  it('bootstrap waits for the first pin, then builds an empty site plus every configured file', async () => {
    harness = new Harness();
    await harness.seed({
      input: fixtureText(),
      projects: {
        alpha: project('alpha', [
          style('main', 'alpha00001'),
          legacyFile('dim', 'alpha00002', 'dim'),
        ]),
      },
    });
    const waiting = harness.siteRun();
    expectOk(waiting);
    expect(waiting.result).toMatchObject({ deploy: false, reason: 'no-pin' });
    expect(waiting.deployed).toBeUndefined();

    const legacy = harness.legacyRun();
    expectOk(legacy);
    const live = harness.head('live');
    const pin = JSON.parse(harness.show('export-pins', `pins/${live}.json`)!.toString());
    expect(JSON.parse(harness.show('export-pins', 'pins/latest.json')!.toString())).toEqual(pin);
    expect(harness.show('export-pins', `pending/${pin.pinId}.json`)).toBeDefined();
    expect(pin.files.map((file: { outcome: string }) => file.outcome)).toEqual(
      Array(7).fill('built'),
    );
    expect(JSON.parse(harness.show(live, 'versions.json')!.toString())).toEqual({
      descriptions: 2.0626,
    });
    expect(harness.show(live, '.github/workflows/contributors.yml')).toBeDefined();

    const site = harness.siteRun();
    expectOk(site);
    expect(site.result).toMatchObject({ deploy: true, bootstrap: true, pinId: pin.pinId });
    expect(harness.served('alpha/v1/dim.json')).toEqual(
      harness.show(live, 'descriptions/dim.json'),
    );
    expect(harness.served('alpha/v1/main.json')).toBeDefined();
    const index = harness.servedJson<{ files: { path: string; sha256: string }[] }>(
      'alpha/index.json',
    );
    expect(index.files.map((file) => file.path)).toEqual([
      'alpha/v1/main.json',
      'alpha/v1/dim.json',
    ]);
    const status = harness.servedJson<{
      buildId: string;
      files: Record<string, string>;
      legacy: Record<string, { sha256: string }>;
    }>('_build/status.json');
    for (const [name, hash] of Object.entries(status.files))
      expect(sha256(harness.served(`_build/${status.buildId}/${name}`)!)).toBe(hash);
    expect(status.legacy['dim.json']!.sha256).toBe(
      sha256(harness.show(live, 'descriptions/dim.json')!),
    );
    expect(harness.served('_headers')!.toString()).toContain(`/_build/${status.buildId}/*`);
  }, 120_000);

  it('a config save interleaved with a publish builds from the pin, never the converter head', async () => {
    harness = new Harness();
    await harness.seed({
      input: fixtureText(),
      projects: {
        alpha: project('alpha', [
          legacyFile('dim', 'alpha00002', 'dim'),
          legacyFile('cv', 'alpha00003', 'clarityV2'),
        ]),
      },
    });
    expectOk(harness.legacyRun());
    const pin1 = readJson(harness.show('export-pins', 'pins/latest.json'));
    expectOk(harness.siteRun());
    // A publish lands on converter with a new engine; the legacy job has not run yet; a config
    // save builds now.
    const c2 = harness.commit('converter', {
      'liveDescriptions.json': edited(fixtureText(), 'v2'),
      ...harness.wrapEngine({}, 'engine-2'),
    });
    harness.commit('editor-data', {
      'exports/projects/beta.json': JSON.stringify(
        project('beta', [legacyFile('crayon', 'beta000001', 'crayon')]),
      ),
    });
    const during = harness.siteRun();
    expectOk(during);
    expect(during.result).toMatchObject({ pinId: pin1.pinId });
    // The pinned engine, not the converter head's.
    expect(pin1.engine).toBe('harness');
    expect(harness.servedJson('_build/status.json')).toMatchObject({
      converterSha: pin1.converterSha,
      liveCommit: pin1.liveCommit,
      engine: pin1.engine,
    });
    const pinnedEngine = harness.show(pin1.converterSha, '.exports/engine.mjs');
    const duringId = harness.servedJson<{ buildId: string }>('_build/status.json').buildId;
    expect(harness.served(`_build/${duringId}/engine.mjs`)).toEqual(pinnedEngine);
    expect(harness.served('beta/v1/crayon.json')).toEqual(
      harness.show(pin1.liveCommit, 'descriptions/crayon.json'),
    );
    // clarityV2 is built from the pinned input with the pinned manifest list.
    const engine = await import('../../src/index.js');
    const input1 = JSON.parse(harness.show(pin1.converterSha, 'liveDescriptions.json')!.toString());
    expect(harness.served('alpha/v1/cv.json')).toEqual(
      Buffer.from(engine.buildLegacy(input1, 'clarityV2', { identical: pin1.hashes })),
    );
    const buildId = harness.servedJson<{ buildId: string }>('_build/status.json').buildId;
    expect(readJson(harness.served(`_build/${buildId}/identical.json`))).toEqual(pin1.hashes);
    // The legacy job lands; the next config-only run catches up.
    expectOk(harness.legacyRun());
    const pin2 = readJson(harness.show('export-pins', 'pins/latest.json'));
    expect(pin2.converterSha).toBe(c2);
    expectOk(harness.siteRun());
    expect(pin2.engine).toBe('engine-2');
    expect(harness.servedJson('_build/status.json')).toMatchObject({
      pinId: pin2.pinId,
      converterSha: c2,
      engine: 'engine-2',
    });
    for (const [path, name] of [
      ['alpha/v1/dim.json', 'dim.json'],
      ['beta/v1/crayon.json', 'crayon.json'],
    ])
      expect(harness.served(path!)).toEqual(harness.show(pin2.liveCommit, `descriptions/${name}`));
    // A pin whose engine is not `.exports/PIN` at its converter SHA stops the build.
    const canonical = readFileSync(join(harness.pages, 'canonical'), 'utf8');
    const wrong = JSON.stringify({ ...pin2, engine: 'harness' });
    harness.commit('export-pins', {
      'pins/latest.json': wrong,
      [`pins/${pin2.liveCommit}.json`]: wrong,
    });
    const mismatch = harness.siteRun();
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toMatch(/is not the pinned one/);
    expect(readFileSync(join(harness.pages, 'canonical'), 'utf8')).toBe(canonical);
  }, 180_000);

  it('a crash between the live push and promotion: config-only runs use the landed record, the next legacy run promotes it', async () => {
    harness = new Harness();
    await harness.seed({
      input: fixtureText(),
      projects: { alpha: project('alpha', [legacyFile('dim', 'alpha00002', 'dim')]) },
    });
    expectOk(harness.legacyRun());
    const pin1 = readJson(harness.show('export-pins', 'pins/latest.json'));
    harness.commit('converter', { 'liveDescriptions.json': edited(fixtureText(), 'v2') });
    expectOk(harness.legacyRun());
    const live2 = harness.head('live');
    const pin2 = readJson(harness.show('export-pins', `pins/${live2}.json`));
    // Undo phase 3 as if the job died right after the live push.
    harness.commit(
      'export-pins',
      { [`pins/${live2}.json`]: null, 'pins/latest.json': JSON.stringify(pin1, null, 2) },
      'simulate crash',
    );
    const site = harness.siteRun();
    expectOk(site);
    expect(site.result).toMatchObject({ pinId: pin2.pinId, pinSource: 'pending' });
    expect(harness.served('alpha/v1/dim.json')).toEqual(
      harness.show(live2, 'descriptions/dim.json'),
    );
    // The retry (a new legacy run) promotes first, then deploys its own pin.
    harness.commit('converter', { 'liveDescriptions.json': edited(fixtureText(), 'v3') });
    const retry = harness.legacyRun();
    expectOk(retry);
    expect(String(retry.result?.notices)).toContain(`Promoted pin ${pin2.pinId}`);
    expect(readJson(harness.show('export-pins', `pins/${live2}.json`))).toEqual(pin2);
    const live3 = harness.head('live');
    expect(readJson(harness.show('export-pins', 'pins/latest.json')).liveCommit).toBe(live3);
    expectOk(harness.siteRun());
    expect(harness.served('alpha/v1/dim.json')).toEqual(
      harness.show(live3, 'descriptions/dim.json'),
    );
    // A pending record whose deploy never landed is ignored.
    const zero = '0'.repeat(40);
    harness.commit('export-pins', {
      [`pending/${zero}-9-1.json`]: JSON.stringify({
        ...pin2,
        pinId: `${zero}-9-1`,
        converterSha: zero,
      }),
    });
    const after = harness.siteRun();
    expectOk(after);
    expect(after.result).toMatchObject({
      pinSource: 'promoted',
      pinId: readJson(harness.show('export-pins', 'pins/latest.json')).pinId,
    });
  }, 180_000);

  it('a rerun of the same converter SHA with a changed manifest is a new pin, and a failed manifest fetch writes none', async () => {
    harness = new Harness();
    const c1 = await harness.seed({
      input: fixtureText(),
      projects: { alpha: project('alpha', [legacyFile('crayon', 'alpha00002', 'crayon')]) },
    });
    expectOk(harness.legacyRun({ runId: '500', attempt: '1' }));
    const first = readJson(harness.show('export-pins', 'pins/latest.json'));
    const versionsBefore = readJson(harness.show('live', 'versions.json'));
    const failed = harness.legacyRun({ runId: '501', manifest: 'fail' });
    expectOk(failed);
    expect(failed.result?.outcome).toBe('manifest failed: nothing deployed');
    expect(readJson(harness.show('live', 'versions.json'))).toEqual(versionsBefore);
    expect(readJson(harness.show('export-pins', 'pins/latest.json'))).toEqual(first);
    // A config save after the failed fetch still builds from the last pin.
    harness.commit('editor-data', {
      'exports/projects/beta.json': JSON.stringify(
        project('beta', [legacyFile('dim', 'beta000001', 'dim')]),
      ),
    });
    const site = harness.siteRun();
    expectOk(site);
    expect(site.result).toMatchObject({ pinId: first.pinId });
    expectOk(harness.legacyRun({ runId: '500', attempt: '2', manifest: 'changed' }));
    const second = readJson(harness.show('export-pins', 'pins/latest.json'));
    expect(second.converterSha).toBe(c1);
    expect(first.pinId).toBe(`${c1}-500-1`);
    expect(second.pinId).toBe(`${c1}-500-2`);
    expect(second.manifestVersion).toBe('v-changed');
    expect(readJson(harness.show('export-pins', `pins/${first.liveCommit}.json`))).toEqual(first);
  }, 180_000);

  it('reverse-order legacy runs never restore older files or versions.json', async () => {
    harness = new Harness();
    await harness.seed({ input: fixtureText() });
    expectOk(harness.legacyRun());
    harness.commit('converter', { 'liveDescriptions.json': edited(fixtureText(), 'A') });
    const runA = harness.legacyCheckouts(); // run A starts (older input)
    harness.commit('converter', { 'liveDescriptions.json': edited(fixtureText(), 'B') });
    const runB = harness.legacyCheckouts();
    expectOk(harness.legacyRun({ checkouts: runB })); // B finishes first
    const liveB = harness.head('live');
    const versionsB = readJson(harness.show(liveB, 'versions.json'));
    const lateA = harness.legacyRun({ checkouts: runA }); // A's live checkout predates B's push
    expect(lateA.status).not.toBe(0);
    expect(harness.head('live')).toBe(liveB);
    // A run holding the old converter checkout but a fresh live checkout: the stale guard.
    const staleA = harness.legacyRun({
      checkouts: { ...harness.legacyCheckouts(), converter: runA.converter },
    });
    expectOk(staleA);
    expect(staleA.result?.outcome).toBe('stale: nothing deployed');
    expect(harness.head('live')).toBe(liveB);
    expect(readJson(harness.show('live', 'versions.json'))).toEqual(versionsB);
    expect(readJson(harness.show('export-pins', 'pins/latest.json')).liveCommit).toBe(liveB);
  }, 180_000);

  it('one failed and one frozen legacy file while a third updates; site copies stay byte-equal to the old URLs', async () => {
    harness = new Harness();
    await harness.seed({
      input: plainSymbols(fixtureText()),
      projects: {
        alpha: project('alpha', [
          legacyFile('clarity', 'alpha00001', 'clarity'),
          legacyFile('dim', 'alpha00002', 'dim'),
          legacyFile('foundry', 'alpha00003', 'foundry'),
        ]),
      },
    });
    expectOk(harness.legacyRun());
    const live1 = harness.head('live');
    // Vocabulary baseline captured by the one-off job (spec section 5).
    const vocabPath = join(harness.root, 'legacy-vocab.json');
    const manifestPath = join(harness.root, 'manifest-ok.json');
    expectOk(
      harness.node('legacy-job.mjs', [
        'vocab',
        '--converter',
        harness.checkout('converter'),
        '--out',
        vocabPath,
        '--manifest-file',
        manifestPath,
      ]),
    );
    const vocab = JSON.parse(readFileSync(vocabPath, 'utf8')).presets;
    // New input: planted classes (perk 1001's symbols), a clarity/braytech failure, and a text edit.
    harness.commit('converter', {
      'liveDescriptions.json': failClarityBraytech(edited(fixtureText(), 'v2')),
    });
    expectOk(harness.legacyRun({ vocab: { dim: vocab.dim } }));
    const live2 = harness.head('live');
    const pin = readJson(harness.show('export-pins', 'pins/latest.json'));
    const outcome = Object.fromEntries(
      pin.files.map((file: { name: string; outcome: string }) => [file.name, file.outcome]),
    );
    expect(outcome).toMatchObject({
      'clarity.json': 'carried',
      'braytech.json': 'carried',
      'dim.json': 'frozen',
      'foundry.json': 'built',
    });
    for (const name of ['clarity.json', 'braytech.json', 'dim.json'])
      expect(harness.show(live2, `descriptions/${name}`)).toEqual(
        harness.show(live1, `descriptions/${name}`),
      );
    expect(harness.show(live2, 'descriptions/foundry.json')).not.toEqual(
      harness.show(live1, 'descriptions/foundry.json'),
    );
    // Config-only run: copies equal the old URLs (never rebuilt, repaired, or unfrozen).
    harness.commit('editor-data', {
      'exports/projects/beta.json': JSON.stringify(
        project('beta', [legacyFile('dim', 'beta000001', 'dim')]),
      ),
    });
    expectOk(harness.siteRun());
    for (const [path, name] of [
      ['alpha/v1/clarity.json', 'clarity.json'],
      ['alpha/v1/dim.json', 'dim.json'],
      ['alpha/v1/foundry.json', 'foundry.json'],
      ['beta/v1/dim.json', 'dim.json'],
    ])
      expect(harness.served(path!)).toEqual(harness.show(live2, `descriptions/${name}`));
    const status = harness.servedJson<{ legacy: Record<string, { outcome: string }> }>(
      '_build/status.json',
    );
    expect(status.legacy['dim.json']!.outcome).toBe('frozen');
    const index = harness.servedJson<{
      files: { path: string; outcome: string }[];
      notices: { kind: string }[];
    }>('alpha/index.json');
    expect(index.files.find((file) => file.path === 'alpha/v1/dim.json')?.outcome).toBe('frozen');
    expect(index.notices.map((notice) => notice.kind)).toEqual(
      expect.arrayContaining(['frozen', 'carried-forward']),
    );
  }, 180_000);
});

describe('build-site per-file outcomes', () => {
  it('a retained copy of a deployed legacy preset freezes on a vocabulary change; the active copy updates', async () => {
    harness = new Harness();
    const retained = [
      {
        path: 'alpha/v1/olddim.json',
        uid: 'alpha00009',
        formatVersion: 1,
        snapshot: legacyFile('olddim', 'alpha00009', 'dim'),
        until: '2099-01-01T00:00:00.000Z',
      },
    ];
    await harness.seed({
      input: plainSymbols(fixtureText()),
      projects: { alpha: project('alpha', [legacyFile('dim', 'alpha00001', 'dim')], retained) },
    });
    expectOk(harness.legacyRun());
    expectOk(harness.siteRun());
    const old = harness.served('alpha/v1/olddim.json');
    expect(old).toEqual(harness.served('alpha/v1/dim.json'));
    // New input plants classes; the legacy job has no vocabulary file, so live's dim.json takes them.
    harness.commit('converter', { 'liveDescriptions.json': fixtureText() });
    expectOk(harness.legacyRun());
    expectOk(harness.siteRun());
    const liveCommit = readJson(harness.show('export-pins', 'pins/latest.json')).liveCommit;
    const live = harness.show(liveCommit, 'descriptions/dim.json');
    expect(live).not.toEqual(old);
    expect(harness.served('alpha/v1/dim.json')).toEqual(live);
    expect(harness.served('alpha/v1/olddim.json')).toEqual(old);
    const manifest = harness.servedJson<{ files: Record<string, { outcome: string }> }>(
      '_build/manifest.json',
    );
    expect(manifest.files['alpha/v1/olddim.json']!.outcome).toBe('frozen');
    const notices =
      harness.servedJson<{ kind: string; path?: string; message: string }[]>('_build/notices.json');
    const frozen = notices.find(
      (notice) => notice.path === 'alpha/v1/olddim.json' && notice.kind === 'frozen',
    );
    expect(frozen?.message).toMatch(/Breaking change \(added class /);
    // The baseline stays: the next run still freezes it.
    expectOk(harness.siteRun());
    expect(harness.served('alpha/v1/olddim.json')).toEqual(old);
  }, 180_000);

  it('one project fails or freezes while another updates; a carried file is checked by sha256', async () => {
    harness = new Harness();
    const retained = [
      {
        path: 'beta/v1/old.json',
        uid: 'beta000009',
        formatVersion: 1,
        snapshot: legacyFile('old', 'beta000009', 'clarityV2'),
        until: '2099-01-01T00:00:00.000Z',
      },
    ];
    await harness.seed({
      input: plainSymbols(fixtureText()),
      projects: {
        alpha: project('alpha', [legacyFile('cv', 'alpha00001', 'clarityV2')]),
        beta: project('beta', [legacyFile('v2b', 'beta000001', 'clarityV2')], retained),
        gamma: project('gamma', [legacyFile('v2c', 'gamma00001', 'clarityV2')]),
      },
    });
    expectOk(harness.legacyRun());
    expectOk(harness.siteRun());
    const before = {
      alpha: harness.served('alpha/v1/cv.json'),
      old: harness.served('beta/v1/old.json'),
      gamma: harness.served('gamma/v1/v2c.json'),
    };
    // New input: planted classes freeze the retained URL; alpha's build hangs (killed at the limit).
    harness.commit('converter', {
      'liveDescriptions.json': edited(fixtureText(), 'v2'),
      ...harness.wrapEngine({ hang: ['cv'] }),
    });
    expectOk(harness.legacyRun());
    expectOk(harness.siteRun({ extra: ['--file-timeout', '3000'] }));
    expect(harness.served('alpha/v1/cv.json')).toEqual(before.alpha);
    expect(harness.served('beta/v1/old.json')).toEqual(before.old);
    expect(harness.served('gamma/v1/v2c.json')).not.toEqual(before.gamma);
    const manifest = harness.servedJson<{ files: Record<string, { outcome: string }> }>(
      '_build/manifest.json',
    );
    expect(manifest.files['alpha/v1/cv.json']!.outcome).toBe('carried');
    expect(manifest.files['beta/v1/old.json']!.outcome).toBe('frozen');
    expect(manifest.files['gamma/v1/v2c.json']!.outcome).toBe('built');
    const notices =
      harness.servedJson<{ kind: string; path?: string; message: string }[]>('_build/notices.json');
    expect(notices.find((notice) => notice.path === 'alpha/v1/cv.json')?.message).toMatch(
      /Timed out/,
    );
    // A carried file whose served bytes no longer match the manifest stops the deploy.
    const canonical = readFileSync(join(harness.pages, 'canonical'), 'utf8');
    writeFileSync(
      join(harness.pages, 'deployments', canonical, 'alpha', 'v1', 'cv.json'),
      'tampered',
    );
    const tampered = harness.siteRun({ extra: ['--file-timeout', '3000'] });
    expect(tampered.status).not.toBe(0);
    expect(tampered.stderr).toMatch(/does not match the manifest sha256/);
    expect(tampered.deployed).toBeUndefined();
    expect(readFileSync(join(harness.pages, 'canonical'), 'utf8')).toBe(canonical);
  }, 180_000);

  it('a new file whose first build fails is absent (bootstrap, normal run, budget); oversized published files carry', async () => {
    harness = new Harness();
    await harness.seed({
      input: fixtureText(),
      projects: {
        alpha: project('alpha', [legacyFile('big', 'alpha00001', 'clarityV2')]),
        beta: project('beta', [style('small', 'beta000001')]),
      },
    });
    expectOk(harness.legacyRun());
    // Bootstrap with a limit only the clarityV2 file breaks: it is absent, beta deploys.
    const boot = harness.siteRun({ extra: ['--max-bytes', '4000'] });
    expectOk(boot);
    expect(boot.result).toMatchObject({ bootstrap: true });
    expect(harness.served('alpha/v1/big.json')).toBeUndefined();
    expect(harness.served('beta/v1/small.json')).toBeDefined();
    expect(harness.servedJson<{ files: unknown[] }>('alpha/index.json').files).toEqual([]);
    // A normal run without the limit publishes it; then it is oversized while beta updates: carried.
    expectOk(harness.siteRun());
    const big = harness.served('alpha/v1/big.json');
    expect(big).toBeDefined();
    const keys = {
      categories: ['weapon-trait'],
      sandboxPerks: [],
      frameAliases: true,
      languages: ['en'],
      keys: ['name', 'itemHash'],
      bungieIdentical: false,
    };
    harness.commit('editor-data', {
      'exports/projects/beta.json': JSON.stringify(
        project('beta', [style('small', 'beta000001', { data: keys })]),
      ),
      'exports/projects/gamma.json': JSON.stringify(
        project('gamma', [legacyFile('big', 'gamma00001', 'clarityV2')]),
      ),
    });
    expectOk(harness.siteRun({ extra: ['--max-bytes', '4000'] }));
    expect(harness.served('alpha/v1/big.json')).toEqual(big);
    expect(harness.served('gamma/v1/big.json')).toBeUndefined(); // new and oversized: absent
    const notices = harness.servedJson<{ kind: string; path?: string }[]>('_build/notices.json');
    expect(
      notices.filter((notice) => notice.path === 'gamma/v1/big.json').map((notice) => notice.kind),
    ).toEqual(['not-published']);
    expect(
      notices.filter((notice) => notice.path === 'alpha/v1/big.json').map((notice) => notice.kind),
    ).toEqual(['build-failed']);
    // Budget exhausted (nothing may start): published files carry, new ones stay absent, legacy copies still copy.
    harness.commit('editor-data', {
      'exports/projects/delta.json': JSON.stringify(
        project('delta', [legacyFile('dim', 'delta00001', 'dim'), style('nn', 'delta00002')]),
      ),
    });
    const budget = harness.siteRun({ extra: ['--carry-after', '0'] });
    expectOk(budget);
    expect(budget.result).toMatchObject({ budgetHit: true });
    expect(harness.served('alpha/v1/big.json')).toEqual(big);
    expect(harness.served('delta/v1/nn.json')).toBeUndefined();
    const liveCommit = readJson(harness.show('export-pins', 'pins/latest.json')).liveCommit;
    expect(harness.served('delta/v1/dim.json')).toEqual(
      harness.show(liveCommit, 'descriptions/dim.json'),
    );
  }, 180_000);

  it('the budget carries the rest forward and the next run starts with the least recently built', async () => {
    harness = new Harness();
    const files = Array.from({ length: 6 }, (_, index) =>
      legacyFile(`f${index}`, `file00000${index}`, 'clarityV2'),
    );
    await harness.seed({
      input: fixtureText(),
      projects: {
        alpha: project('alpha', files.slice(0, 3)),
        beta: project('beta', files.slice(3)),
      },
    });
    expectOk(harness.legacyRun());
    expectOk(harness.siteRun());
    harness.commit(
      'converter',
      harness.wrapEngine({ slowMs: Object.fromEntries(files.map((file) => [file.id, 1500])) }),
    );
    expectOk(harness.legacyRun());
    const first = harness.siteRun({ extra: ['--carry-after', '2000'] });
    expectOk(first);
    expect(first.result).toMatchObject({ budgetHit: true });
    const builtFirst = builtPaths(harness.servedJson('_build/manifest.json'));
    expect(builtFirst.length).toBeGreaterThan(0);
    expect(builtFirst.length).toBeLessThan(6);
    expectOk(harness.siteRun({ extra: ['--carry-after', '2000'] }));
    const builtSecond = builtPaths(harness.servedJson('_build/manifest.json'));
    expect(builtSecond.length).toBeGreaterThan(0);
    // The files the first run skipped go first (no starvation); only then any it rebuilt.
    const all = files.map((file, index) => `${index < 3 ? 'alpha' : 'beta'}/v1/${file.id}.json`);
    const skipped = all.filter((path) => !builtFirst.includes(path));
    expect(builtSecond.filter((path) => skipped.includes(path))).toHaveLength(
      Math.min(skipped.length, builtSecond.length),
    );
  }, 180_000);

  it('a corrupt or missing manifest on a project with deployments deploys nothing; an invalid config keeps its URLs', async () => {
    harness = new Harness();
    await harness.seed({
      input: fixtureText(),
      projects: {
        alpha: project('alpha', [legacyFile('dim', 'alpha00001', 'dim')]),
        beta: project('beta', [legacyFile('crayon', 'beta000001', 'crayon')]),
      },
    });
    expectOk(harness.legacyRun());
    expectOk(harness.siteRun());
    const crayon = harness.served('beta/v1/crayon.json');
    // Invalid config: beta's URLs (and index.json) stay; alpha still deploys.
    harness.commit('editor-data', {
      'exports/projects/beta.json': '{"schema":1,"id":"beta","name":"B","files":[],"extra":true}',
    });
    expectOk(harness.siteRun());
    expect(harness.served('beta/v1/crayon.json')).toEqual(crayon);
    expect(harness.served('beta/index.json')).toBeDefined();
    const canonical = readFileSync(join(harness.pages, 'canonical'), 'utf8');
    const manifestPath = join(harness.pages, 'deployments', canonical, '_build', 'manifest.json');
    writeFileSync(manifestPath, '{"manifestVersion":1,');
    expect(harness.siteRun().status).not.toBe(0);
    expect(readFileSync(join(harness.pages, 'canonical'), 'utf8')).toBe(canonical);
    rmSync(manifestPath);
    expect(harness.siteRun().status).not.toBe(0);
    expect(readFileSync(join(harness.pages, 'canonical'), 'utf8')).toBe(canonical);
  }, 180_000);

  it('expired retained entries are carried frozen (downloads only); snapshots keep the last three', async () => {
    harness = new Harness();
    const retained = [
      {
        path: 'alpha/v1/old.json',
        uid: 'alpha00009',
        formatVersion: 1,
        snapshot: legacyFile('old', 'alpha00009', 'clarityV2'),
        until: '2030-01-01T00:00:00.000Z',
      },
    ];
    await harness.seed({
      input: fixtureText(),
      projects: { alpha: project('alpha', [legacyFile('dim', 'alpha00001', 'dim')], retained) },
    });
    expectOk(harness.legacyRun());
    expectOk(harness.siteRun({ extra: ['--now', '2029-12-01T00:00:00.000Z'] }));
    const old = harness.served('alpha/v1/old.json');
    expect(old).toBeDefined();
    const ids: string[] = [harness.servedJson<{ buildId: string }>('_build/status.json').buildId];
    for (const tag of ['b', 'c', 'd', 'e']) {
      harness.commit('converter', { 'liveDescriptions.json': edited(fixtureText(), tag) });
      expectOk(harness.legacyRun());
      expectOk(harness.siteRun({ extra: ['--now', '2030-02-01T00:00:00.000Z'] }));
      ids.push(harness.servedJson<{ buildId: string }>('_build/status.json').buildId);
    }
    expect(harness.served('alpha/v1/old.json')).toEqual(old);
    const manifest = harness.servedJson<{
      files: Record<string, { outcome: string }>;
      snapshots: { buildId: string }[];
    }>('_build/manifest.json');
    expect(manifest.files['alpha/v1/old.json']!.outcome).toBe('frozen');
    expect(manifest.snapshots.map((snapshot) => snapshot.buildId)).toEqual(ids.slice(-4).reverse());
    expect(harness.served(`_build/${ids[0]}/engine.mjs`)).toBeUndefined();
    for (const id of ids.slice(-4)) expect(harness.served(`_build/${id}/input.json`)).toBeDefined();
  }, 240_000);
});
