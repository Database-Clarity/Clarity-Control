// The legacy job (spec section 3, "Legacy files", "Legacy serialization", "Publish pins"): builds
// the seven old-URL files with the vendored engine and writes them to `live`, plus the two-phase
// publish pin on `export-pins`. Runs in the repo-wide group `legacy-outputs`, on the CURRENT
// `converter` and `live` heads (not the triggering SHA).
//
//   legacy-job.mjs run   --converter <dir> --live <dir> --pins <dir> --run-id <id> --attempt <n>
//                        [--vocab <legacy-vocab.json>] [--manifest-file <json>] [--repo <owner/name>]
//   legacy-job.mjs vocab --converter <dir> --out <file> [--manifest-file <json>]
//
// Each file builds on its own: a failed or frozen file is copied byte for byte from the `live`
// checkout while the others update. versions.json gets +0.0001 on every deploying run, read from
// the `live` checkout. A deploy happens only when the converter SHA is the last deployed one or a
// descendant of it (stale-deploy guard) and `live` did not move since its checkout (plain push).
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Engine from '../index.js';
import {
  deployMessage,
  effectivePin,
  lastDeploy,
  makePinId,
  writePending,
  writePromoted,
  type Pin,
  type PinFile,
} from './pins.js';
import {
  ensureCommit,
  git,
  gitShow,
  isAncestor,
  isSha,
  parseArgs,
  readJson,
  required,
  sha256,
  stepSummary,
  writeFile,
  json,
} from './util.js';

/** `sandboxPerk`: a set bonus's Bungie text (set bonuses are sandbox perks, not inventory items). */
type BungieManifest = {
  version: string;
  inventoryItem: Engine.InventoryItems;
  sandboxPerk?: Engine.SandboxPerks;
};

const bungie = 'https://www.bungie.net';

/**
 * The Bungie manifest's inventory items and sandbox perks, fetched once (3 tries); undefined when
 * either fails, so the Bungie-identical test never runs on half a manifest.
 */
export async function loadManifest(file: string | undefined): Promise<BungieManifest | undefined> {
  if (file) {
    if (!existsSync(file)) return undefined; // the harness's "fetch failed"
    return readJson<BungieManifest>(file);
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const index = (await (await fetch(`${bungie}/Platform/Destiny2/Manifest/`)).json()) as {
        Response?: {
          version?: string;
          jsonWorldComponentContentPaths?: { en?: Record<string, string> };
        };
      };
      const version = index.Response?.version;
      const paths = index.Response?.jsonWorldComponentContentPaths?.en;
      const tables = [paths?.DestinyInventoryItemDefinition, paths?.DestinySandboxPerkDefinition];
      if (!version || !tables.every((path) => path?.startsWith('/')))
        throw new Error('Manifest index without inventory items or sandbox perks');
      const [inventoryItem, sandboxPerk] = await Promise.all(
        tables.map(async (path) => {
          const response = await fetch(`${bungie}${path}`);
          if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
          return (await response.json()) as Engine.InventoryItems;
        }),
      );
      return { version, inventoryItem, sandboxPerk };
    } catch (error) {
      console.log(`Bungie manifest attempt ${attempt + 1} failed: ${(error as Error).message}`);
    }
  }
  return undefined;
}

/** generatorSha: the newest publish receipt in the converter tree, else the engine install's pin. */
function generatorSha(converterDir: string, converterSha: string, engineDir: string): string {
  const listing = git(converterDir, [
    'ls-tree',
    '-r',
    '--name-only',
    converterSha,
    '--',
    '.publish/receipts',
  ]);
  const receipts = listing
    ? listing
        .split('\n')
        .filter((path) => path.endsWith('.json'))
        .sort()
    : [];
  const month = receipts.at(-1)?.split('/').slice(0, -1).join('/');
  let best: { now: number; generatorSha: string } | undefined;
  for (const path of receipts.filter((candidate) => candidate.startsWith(`${month}/`))) {
    const receipt = JSON.parse(gitShow(converterDir, converterSha, path)!.toString('utf8')) as {
      now?: number;
      generatorSha?: string;
    };
    if (
      typeof receipt.now === 'number' &&
      isSha(receipt.generatorSha) &&
      (!best || receipt.now > best.now)
    )
      best = { now: receipt.now, generatorSha: receipt.generatorSha };
  }
  if (best) return best.generatorSha;
  const config = join(engineDir, 'config.json');
  const pinned = existsSync(config)
    ? readJson<{ generatorSha?: string }>(config).generatorSha
    : undefined;
  if (!isSha(pinned))
    throw new Error('No publish receipt and no generatorSha in .exports/config.json');
  return pinned;
}

const loadEngine = async (engineDir: string) =>
  (await import(pathToFileURL(join(engineDir, 'engine.mjs')).href)) as typeof Engine;

type Built = {
  name: string;
  preset: Engine.LegacyPreset;
  bytes?: Uint8Array;
  markers?: string[];
  error?: string;
};

function buildSeven(
  engine: typeof Engine,
  input: Engine.LegacyInput,
  identical: number[],
): Built[] {
  return engine.deployedLegacyPresets.map((preset) => {
    const name = engine.legacyFileName(preset);
    const file = { id: preset.toLowerCase(), formatVersion: 1 as const, preset };
    try {
      // compile() is buildLegacy plus the refusal of markup the old files cannot express.
      const plan = engine.compile(input, file, {
        catalog: { items: {}, categories: [] },
        identical,
      });
      const parsed = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(plan.bytes),
      ) as unknown;
      return {
        name,
        preset,
        bytes: plan.bytes,
        markers: engine.markerSet(parsed, engine.outputTokens(file)),
      };
    } catch (error) {
      return { name, preset, error: (error as Error).message.slice(0, 500) };
    }
  });
}

export async function runLegacy(options: Record<string, string>) {
  const engineDir = options['engine-dir'] ?? dirname(fileURLToPath(import.meta.url));
  const converterDir = required(options, 'converter');
  const liveDir = required(options, 'live');
  const pinsDir = required(options, 'pins');
  const repo = options.repo ?? 'Database-Clarity/Live-Clarity-Database';
  const runId = required(options, 'run-id');
  const attempt = required(options, 'attempt');
  const pinsBranch = options['pins-branch'] ?? 'export-pins';
  const notices: string[] = [];
  const report = (outcome: string) => {
    console.log(outcome);
    stepSummary(
      [`### Legacy outputs: ${outcome}`, '', ...notices.map((notice) => `- ${notice}`)].join('\n'),
    );
    if (options.result) writeFile(options.result, json({ outcome, notices }));
  };
  const engine = await loadEngine(engineDir);
  const enginePin = existsSync(join(engineDir, 'PIN'))
    ? readFileSync(join(engineDir, 'PIN'), 'utf8').trim()
    : 'unpinned';

  // 1. Start-of-run promotion of a landed pending record (a crash between push and phase 3).
  const liveHead = git(liveDir, ['rev-parse', 'HEAD']);
  const effective = effectivePin(pinsDir, liveDir, liveHead);
  if (effective?.promote) {
    writePromoted(pinsDir, liveDir, effective.promote.pin, pinsBranch);
    notices.push(
      `Promoted pin ${effective.promote.pin.pinId} (live ${effective.promote.pin.liveCommit})`,
    );
  }

  // 2. The current converter head and the stale-deploy guard.
  const converterSha = git(converterDir, ['rev-parse', 'HEAD']);
  // The pin names the engine of `.exports/` at converterSha (site runs load that copy by SHA).
  const installedPin = gitShow(converterDir, converterSha, '.exports/PIN')?.toString('utf8').trim();
  if (installedPin !== enginePin)
    throw new Error(
      `This engine (${enginePin}) is not .exports/PIN at ${converterSha} (${installedPin ?? 'none'})`,
    );
  const last = lastDeploy(liveDir, liveHead);
  if (last && last.converterSha !== converterSha) {
    let newer = false;
    try {
      ensureCommit(converterDir, last.converterSha);
      newer = isAncestor(converterDir, last.converterSha, converterSha);
    } catch {
      newer = false;
    }
    if (!newer) {
      notices.push(
        `live was deployed from ${last.converterSha}, which ${converterSha} does not descend from`,
      );
      return report('stale: nothing deployed');
    }
  }
  const inputBytes = gitShow(converterDir, converterSha, 'liveDescriptions.json');
  if (!inputBytes) throw new Error(`No liveDescriptions.json at ${converterSha}`);
  const input = JSON.parse(inputBytes.toString('utf8')) as Engine.LegacyInput;

  // 3. Bungie manifest: a failure carries every file forward (no deploy) and writes no pin.
  const manifest = await loadManifest(options['manifest-file']);
  if (!manifest) {
    notices.push(
      'Bungie manifest fetch failed: every legacy file stays as it is; the next publish retries',
    );
    return report('manifest failed: nothing deployed');
  }
  const identical = engine
    .bungieIdentical(input, manifest.inventoryItem, manifest.sandboxPerk)
    .map(Number)
    .sort((a, b) => a - b);

  // 4. Build each file on its own; failed and frozen files are copied from `live`.
  const vocab =
    options.vocab && existsSync(options.vocab)
      ? (readJson<{ presets?: Record<string, string[]> }>(options.vocab).presets ?? {})
      : {};
  const previousFiles = new Map((effective?.pin.files ?? []).map((file) => [file.name, file]));
  const files: (PinFile & { bytes: Uint8Array })[] = [];
  for (const built of buildSeven(engine, input, identical)) {
    let outcome: PinFile['outcome'] = 'built';
    let bytes = built.bytes;
    const baseline = vocab[built.preset];
    if (bytes && baseline) {
      const change = engine.markerChange(baseline, built.markers!);
      if (change) {
        outcome = 'frozen';
        notices.push(
          `${built.name} frozen: breaking change (added ${change.added.slice(0, 5).join(', ') || 'none'}; removed ${change.removed.slice(0, 5).join(', ') || 'none'})`,
        );
      }
    }
    if (!bytes) {
      outcome = 'carried';
      notices.push(`${built.name} failed to build: ${built.error}`);
    }
    if (outcome !== 'built') {
      bytes = gitShow(liveDir, liveHead, `descriptions/${built.name}`);
      if (!bytes) {
        notices.push(`${built.name} is not on live either: it stays absent`);
        continue;
      }
    }
    const source =
      outcome === 'built'
        ? converterSha
        : (previousFiles.get(built.name)?.sourceConverterSha ?? last?.converterSha ?? converterSha);
    files.push({
      name: built.name,
      sha256: sha256(bytes!),
      outcome,
      sourceConverterSha: source,
      bytes: bytes!,
    });
  }

  // 5. versions.json: +0.0001 from the `live` checkout.
  const versionsBytes = gitShow(liveDir, liveHead, 'versions.json');
  if (!versionsBytes) throw new Error('live has no versions.json');
  const versions = engine.nextVersions(
    JSON.parse(versionsBytes.toString('utf8')) as Engine.LegacyVersions,
  );

  // 6. Phase 1: the pending pin, before the `live` push.
  const pin: Pin = {
    pinId: makePinId(converterSha, runId, attempt),
    converterSha,
    inputSha256: sha256(inputBytes),
    manifestVersion: manifest.version,
    hashes: identical,
    engine: enginePin,
    generatorSha: generatorSha(converterDir, converterSha, engineDir),
    files: files.map(({ name, sha256: hash, outcome, sourceConverterSha }) => ({
      name,
      sha256: hash,
      outcome,
      sourceConverterSha,
    })),
  };
  writePending(pinsDir, pin, pinsBranch);

  // 7. Phase 2: the `live` deploy commit (names the converter SHA and the pin), plain push.
  rmSync(join(liveDir, 'descriptions'), { recursive: true, force: true });
  for (const file of files) writeFile(join(liveDir, 'descriptions', file.name), file.bytes);
  writeFile(join(liveDir, 'versions.json'), versions.bytes);
  git(liveDir, ['add', '-A', '--', 'descriptions', 'versions.json']);
  git(
    liveDir,
    [
      '-c',
      'user.name=github-actions[bot]',
      '-c',
      'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit',
      '--quiet',
      '--allow-empty',
      '-F',
      '-',
    ],
    new TextEncoder().encode(deployMessage(repo, converterSha, pin.pinId)),
  );
  // Not forced: if `live` moved since the checkout, the push is refused and nothing lands.
  git(liveDir, [
    'push',
    '--quiet',
    'origin',
    `HEAD:refs/heads/${options['live-branch'] ?? 'live'}`,
  ]);
  const liveCommit = git(liveDir, ['rev-parse', 'HEAD']);

  // 8. Phase 3: pins/<liveCommit>.json and latest.json.
  writePromoted(pinsDir, liveDir, { ...pin, liveCommit }, pinsBranch);
  report(
    `deployed ${liveCommit} from ${converterSha} (pin ${pin.pinId}; ${files.map((file) => `${file.name} ${file.outcome}`).join(', ')})`,
  );
}

/** One-off vocabulary baseline (spec section 5): the seven files' marker sets, for a maintainer to commit. */
export async function captureVocab(options: Record<string, string>) {
  const engineDir = options['engine-dir'] ?? dirname(fileURLToPath(import.meta.url));
  const engine = await loadEngine(engineDir);
  const converterDir = required(options, 'converter');
  const converterSha = git(converterDir, ['rev-parse', 'HEAD']);
  const input = JSON.parse(
    gitShow(converterDir, converterSha, 'liveDescriptions.json')!.toString('utf8'),
  ) as Engine.LegacyInput;
  const manifest = await loadManifest(options['manifest-file']);
  if (!manifest) throw new Error('Bungie manifest fetch failed');
  const identical = engine
    .bungieIdentical(input, manifest.inventoryItem, manifest.sandboxPerk)
    .map(Number);
  const presets: Record<string, string[]> = {};
  for (const built of buildSeven(engine, input, identical)) {
    if (!built.markers) throw new Error(`${built.name}: ${built.error}`);
    presets[built.preset] = built.markers;
  }
  writeFile(
    required(options, 'out'),
    json({ converterSha, manifestVersion: manifest.version, presets }),
  );
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === 'run') return runLegacy(options);
  if (command === 'vocab') return captureVocab(options);
  throw new Error('Usage: legacy-job.mjs run|vocab [--options]');
}
