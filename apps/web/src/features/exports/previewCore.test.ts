// G-PREVIEW (spec section 9), in Node: the preview loads a snapshot exactly as the worker does
// (status -> files -> sha256 -> engine imported from its verified source text) and its builds
// equal build-site's (the same engine text, `compile(JSON.parse(input), file, { catalog,
// identical })`) byte for byte, for every style and 20 seeded random configs. A sample equals the
// whole build's entry. A mismatched snapshot or live file is refused.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { deployedLegacyPresets, legacyPresets, newStyleFile, styles } from '@clarity/export';
import type { ExportFile } from '@clarity/export/config';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  loadSnapshot,
  Preview,
  SnapshotMismatch,
  type Engine,
  type PreviewIo,
} from './previewCore';
import type { BuildStatus } from './site';
import { randomFiles } from './testConfigs';

const root = new URL('../../../../../', import.meta.url);
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const site = 'https://site.test';
const liveRaw = 'https://raw.test/live';

let engineText: string;
let files: Record<string, Uint8Array>;
let status: BuildStatus;
let served: Map<string, Uint8Array>;
let nodeEngine: Engine;
let input: unknown;
let catalog: { items: Record<string, { categoryId: string }>; categories: { id: string }[] };
let identical: number[];

const io = (): PreviewIo => ({
  async fetch(url) {
    const bytes = served.get(url);
    return bytes ? new Response(bytes as BodyInit) : new Response('missing', { status: 404 });
  },
  importEngine: (source) =>
    import(
      `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
    ) as Promise<Engine>,
  sha256: async (bytes) => sha(bytes),
  gzipSize: async () => null,
});

beforeAll(async () => {
  // The engine bundle exactly as packages/export/build.mjs makes dist/engine.mjs.
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('packages/export/src/index.ts', root))],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    write: false,
    legalComments: 'inline',
    logLevel: 'silent',
  });
  engineText = bundle.outputFiles[0]!.text;
  nodeEngine = (await io().importEngine(engineText)) as Engine;
  const inputBytes = readFileSync(new URL('packages/core/test/fixtures/live.json', root));
  catalog = JSON.parse(
    gunzipSync(
      readFileSync(new URL('packages/export/test/fixtures/catalog-c3fed8c.json.gz', root)),
    ).toString('utf8'),
  );
  identical = JSON.parse(
    readFileSync(new URL('packages/export/test/fixtures/legacy-identical.json', root), 'utf8'),
  ).live;
  input = JSON.parse(inputBytes.toString('utf8'));
  const encoder = new TextEncoder();
  files = {
    'engine.mjs': encoder.encode(engineText),
    'input.json': new Uint8Array(inputBytes),
    'identical.json': encoder.encode(JSON.stringify(identical)),
    'catalog.json': encoder.encode(JSON.stringify(catalog)),
  };
  const buildId = sha(Object.values(files).map(sha).join('\n')).slice(0, 16);
  const legacy: BuildStatus['legacy'] = {};
  served = new Map();
  for (const [name, bytes] of Object.entries(files))
    served.set(`${site}/_build/${buildId}/${name}`, bytes);
  for (const preset of deployedLegacyPresets) {
    const bytes = nodeEngine.compile(
      input as never,
      { id: 'x1', formatVersion: 1, preset },
      {
        catalog,
        identical,
      },
    ).bytes;
    legacy[`${preset}.json`] = { sha256: sha(bytes), outcome: 'built' };
    served.set(`${liveRaw}/${'c'.repeat(40)}/descriptions/${preset}.json`, bytes);
  }
  status = {
    buildId,
    builtAt: '2026-11-11T18:00:00.000Z',
    files: Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [name, sha(bytes)]),
    ) as BuildStatus['files'],
    engine: 'test',
    converterSha: 'd'.repeat(40),
    pinId: 'pin',
    liveCommit: 'c'.repeat(40),
    legacy,
  };
}, 120_000);

/** build-site's per-file build (pool.ts): the same engine, the parsed snapshot files. */
const siteBuild = (file: ExportFile) =>
  sha(nodeEngine.compile(input as never, file, { catalog, identical }).bytes);

describe('G-PREVIEW', () => {
  it('worker builds equal build-site builds byte for byte: every style and 20 random configs', async () => {
    const preview = new Preview(io(), await loadSnapshot(io(), site, status), {
      site,
      liveRaw,
    });
    const categories = catalog.categories.map((category) => category.id);
    const cases: ExportFile[] = [
      ...styles.flatMap((style) =>
        (['lines', 'text'] as const).map((shape) =>
          newStyleFile(
            `${style}-${shape}`,
            style,
            { ...newStyleFile('x1', style).data, categories, sandboxPerks: categories },
            shape,
          ),
        ),
      ),
      // clarityV2 has no deployed file: the preview builds it (re-check N3).
      { id: 'v2', formatVersion: 1, preset: 'clarityV2' },
      ...randomFiles(20, categories),
    ];
    for (const file of cases) expect(sha(await preview.bytes(file)), file.id).toBe(siteBuild(file));
  }, 300_000);

  it('a sample equals the whole build’s entry, absent rows say why', async () => {
    const preview = new Preview(io(), await loadSnapshot(io(), site, status), { site, liveRaw });
    const categories = catalog.categories.map((category) => category.id);
    for (const file of randomFiles(4, categories)) {
      const plan = nodeEngine.compile(input as never, file, { catalog, identical });
      const hashes = Object.keys((input as { perks: object }).perks);
      const picked = hashes.filter((_, index) => index % 97 === 0);
      for (const hash of picked) {
        const sample = await preview.sample(file, hash, null);
        const entry = plan.expanded?.[hash];
        if (entry) expect(sample, `${file.id} ${hash}`).toEqual({ kind: 'entry', entry });
        else expect(sample.kind, `${file.id} ${hash}`).toBe('absent');
      }
    }
  }, 300_000);

  it('unchanged deployed legacy presets show the pinned live bytes', async () => {
    const preview = new Preview(io(), await loadSnapshot(io(), site, status), { site, liveRaw });
    for (const preset of deployedLegacyPresets) {
      const file: ExportFile = { id: 'f1', formatVersion: 1, preset };
      const ref = { kind: 'legacy', name: `${preset}.json` } as const;
      const live = JSON.parse(
        new TextDecoder().decode(
          served.get(`${liveRaw}/${'c'.repeat(40)}/descriptions/${preset}.json`)!,
        ),
      );
      const hash = Object.keys(live)[5]!;
      expect(await preview.sample(file, hash, ref)).toEqual({ kind: 'entry', entry: live[hash] });
      const numbers = await preview.numbers(file, ref);
      expect(numbers.entries).toBe(Object.keys(live).length);
      expect(numbers.changed).toBe(0);
    }
    expect(legacyPresets).toContain('clarityV2');
  }, 120_000);

  it('refuses a snapshot file or live file that does not match', async () => {
    const tampered = new Map(served);
    const inputUrl = `${site}/_build/${status.buildId}/input.json`;
    tampered.set(inputUrl, new TextEncoder().encode('{"perks":{}}'));
    const original = served;
    served = tampered;
    await expect(loadSnapshot(io(), site, status)).rejects.toBeInstanceOf(SnapshotMismatch);
    served = original;
    const preview = new Preview(io(), await loadSnapshot(io(), site, status), { site, liveRaw });
    const result = await preview.liveSample(
      { kind: 'site', path: 'p1/v1/f1.json', sha256: '0'.repeat(64) },
      '1',
    );
    expect(result.kind).toBe('error');
    served.set(`${site}/p1/v1/f1.json`, new TextEncoder().encode('{}'));
    const wrong = await preview.liveSample(
      { kind: 'site', path: 'p1/v1/f1.json', sha256: '0'.repeat(64) },
      '1',
    );
    expect(wrong).toMatchObject({ kind: 'error' });
  }, 120_000);
});
