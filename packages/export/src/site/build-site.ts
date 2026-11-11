// build-site (spec section 3): builds data.d2clarity.com from the effective publish pin and the
// project configs, into a folder the workflow then deploys (one atomic Pages deployment).
//
//   build-site.mjs locate --out <state.json> (--pages-project <name> | --pages-sim <dir>)
//   build-site.mjs build  --state <state.json> --converter <dir> --live <dir> --pins <dir>
//                         --exports <dir> --generator <dir> --out <dir> [--result <file>]
//   build-site.mjs child  (internal: one build process of the pool)
//
// Configs are data only: they are read from files by Node and never reach a shell, a workflow
// expression, or an eval. Nothing here commits to any repository.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Engine from '../index.js';
import type * as ConfigModule from '../config.js';
import type { ExportConfig, ExportFile } from '../v1/config.js';
import { locatePages, locateSim, type SiteState } from './pages.js';
import { effectivePin, type Pin } from './pins.js';
import { BuildPool, childMain, type BuildJob, type BuildResult } from './pool.js';
import {
  ensureCommit,
  fetchBytes,
  git,
  gitShow,
  intOption,
  json,
  parseArgs,
  readJson,
  required,
  sha256,
  stepSummary,
  writeFile,
} from './util.js';

/** Limits (spec section 3). */
export const siteLimits = {
  projects: 40,
  maxBytes: 25 * 1024 * 1024,
  fileTimeoutMs: 20_000,
  pool: 2,
  carryAfterMs: 8 * 60_000,
  budgetMs: 10 * 60_000,
  snapshotsCarried: 3,
};

export const manifestVersion = 1;
export type ManifestFile = {
  sha256: string;
  bytes: number;
  /** ISO time the bytes last changed. */
  lastUpdate: string;
  /** ISO time of the last successful build (rotation: least recently built first). */
  lastBuilt?: string;
  outcome: 'built' | 'carried' | 'frozen';
  /** Retained old URL: keeps updating until then. */
  retainUntil?: string;
  /** Vocabulary of the published bytes (spec section 5). */
  markers?: string[];
  /** Retained entries: the vocabulary on the day the URL was retained. */
  baseline?: string[];
};
export type Manifest = {
  manifestVersion: 1;
  buildId: string;
  builtAt: string;
  pinId: string;
  files: Record<string, ManifestFile>;
  snapshots: { buildId: string; files: Record<string, string> }[];
};
export type SiteNotice = {
  project?: string;
  file?: string;
  path?: string;
  kind:
    | 'invalid-config'
    | 'over-limit'
    | 'build-failed'
    | 'carried-forward'
    | 'not-published'
    | 'frozen'
    | 'retained-ends'
    | 'budget'
    | 'compile'
    | 'invalid-changelog';
  message: string;
  /** The engine's own notice (kind `compile`), as index.json lists it. */
  detail?: Record<string, unknown>;
};

const snapshotNames = ['engine.mjs', 'input.json', 'identical.json', 'catalog.json'] as const;

function checkManifest(value: unknown): Manifest {
  const manifest = value as Manifest;
  const ok =
    manifest &&
    manifest.manifestVersion === manifestVersion &&
    typeof manifest.buildId === 'string' &&
    manifest.files &&
    typeof manifest.files === 'object' &&
    Object.entries(manifest.files).every(
      ([path, file]) =>
        safeSitePath(path) &&
        /^[0-9a-f]{64}$/.test(file.sha256) &&
        Number.isSafeInteger(file.bytes) &&
        typeof file.lastUpdate === 'string',
    ) &&
    Array.isArray(manifest.snapshots) &&
    manifest.snapshots.every(
      (snapshot) =>
        /^[0-9a-f]{16}$/.test(snapshot.buildId) &&
        snapshotNames.every((name) => /^[0-9a-f]{64}$/.test(snapshot.files?.[name] ?? '')),
    );
  if (!ok) throw new Error('The current site manifest is malformed');
  return manifest;
}

/** Relative site path with plain segments only (no traversal, no absolute paths). */
export const safeSitePath = (path: string) =>
  /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/.test(path) &&
  !path.split('/').includes('..');

// --- locate ------------------------------------------------------------------------------------

async function locate(options: Record<string, string>) {
  const out = required(options, 'out');
  let state: SiteState;
  if (options['pages-sim']) state = locateSim(options['pages-sim']);
  else {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    if (!token || !account)
      throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required');
    state = await locatePages(account, required(options, 'pages-project'), token);
  }
  writeFile(out, json(state));
  console.log(
    state.zeroDeployments
      ? 'Pages project has zero deployments (bootstrap)'
      : `Served deployment ${state.deployment.id}`,
  );
}

// --- build -------------------------------------------------------------------------------------

type Entry = {
  project: string;
  path: string;
  fileId: string;
  file: ExportFile;
  kind: 'active' | 'retained' | 'expired';
  until?: string;
};

type Outcome = { file: ManifestFile; bytes?: Uint8Array; from?: string };

export async function buildSite(options: Record<string, string>) {
  const started = Date.now();
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('--now must be an ISO time');
  const nowIso = now.toISOString();
  const limits = {
    ...siteLimits,
    maxBytes: intOption(options, 'max-bytes', siteLimits.maxBytes),
    fileTimeoutMs: intOption(options, 'file-timeout', siteLimits.fileTimeoutMs),
    pool: intOption(options, 'pool', siteLimits.pool) || 1,
    carryAfterMs: intOption(options, 'carry-after', siteLimits.carryAfterMs),
    budgetMs: intOption(options, 'budget', siteLimits.budgetMs),
  };
  const engineDir = options['engine-dir'] ?? dirname(fileURLToPath(import.meta.url));
  const script = options.script ?? fileURLToPath(import.meta.url);
  const out = required(options, 'out');
  const resultPath = options.result;
  const notices: SiteNotice[] = [];
  const finish = (result: Record<string, unknown>) => {
    if (resultPath) writeFile(resultPath, json(result));
    const output = process.env.GITHUB_OUTPUT;
    if (output) writeFile(output, `deploy=${result.deploy === true}\n`);
  };

  const state = readJson<SiteState>(required(options, 'state'));
  const liveDir = required(options, 'live');
  const pinsDir = required(options, 'pins');
  const converterDir = required(options, 'converter');
  const generatorDir = required(options, 'generator');
  const exportsDir = required(options, 'exports');

  // 1. The current site manifest, from the served deployment's own URL. Missing or corrupt on a
  //    project that has deployments: nothing deploys (the previous deployment stays).
  let previous: Manifest | undefined;
  const previousUrl = state.zeroDeployments ? undefined : state.deployment.url;
  if (previousUrl) {
    const bytes = await fetchBytes(`${previousUrl}_build/manifest.json`);
    previous = checkManifest(JSON.parse(new TextDecoder().decode(bytes)));
  }

  // 2. The effective pin (read-only). Before the first pin, a site run waits (bootstrap waits).
  const liveHead = git(liveDir, ['rev-parse', 'HEAD']);
  const effective = effectivePin(pinsDir, liveDir, liveHead);
  if (!effective) {
    console.log('No publish pin yet: the site waits for the first legacy run');
    finish({ deploy: false, reason: 'no-pin' });
    return;
  }
  const pin = effective.pin;

  // 3. The pinned input, catalog, manifest list, and engine: one immutable snapshot.
  ensureCommit(converterDir, pin.converterSha);
  const inputBytes = gitShow(converterDir, pin.converterSha, 'liveDescriptions.json');
  if (!inputBytes || sha256(inputBytes) !== pin.inputSha256)
    throw new Error(`liveDescriptions.json at ${pin.converterSha} does not match the pin`);
  ensureCommit(generatorDir, pin.generatorSha);
  const catalogPart = (name: string) => {
    const bytes = gitShow(generatorDir, pin.generatorSha, `templates/v2/${name}`);
    if (!bytes) throw new Error(`templates/v2/${name} is missing at generator ${pin.generatorSha}`);
    return JSON.parse(bytes.toString('utf8')) as unknown;
  };
  const catalog = { items: catalogPart('items.json'), categories: catalogPart('categories.json') };
  const snapshotBytes: Record<(typeof snapshotNames)[number], Uint8Array> = {
    'engine.mjs': readFileSync(join(engineDir, 'engine.mjs')),
    'input.json': inputBytes,
    'identical.json': new TextEncoder().encode(JSON.stringify(pin.hashes)),
    'catalog.json': new TextEncoder().encode(JSON.stringify(catalog)),
  };
  const snapshotShas = Object.fromEntries(
    snapshotNames.map((name) => [name, sha256(snapshotBytes[name])]),
  ) as Record<(typeof snapshotNames)[number], string>;
  const buildId = sha256(snapshotNames.map((name) => snapshotShas[name]).join('\n')).slice(0, 16);
  const enginePin = existsSync(join(engineDir, 'PIN'))
    ? readFileSync(join(engineDir, 'PIN'), 'utf8').trim()
    : 'unpinned';

  const engine = (await import(pathToFileURL(join(engineDir, 'engine.mjs')).href)) as typeof Engine;
  const config = (await import(
    pathToFileURL(join(engineDir, 'config.mjs')).href
  )) as typeof ConfigModule;

  if (existsSync(out) && readdirSync(out).length) throw new Error(`${out} is not empty`);
  mkdirSync(out, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'build-site-'));
  for (const name of snapshotNames) writeFile(join(work, name), snapshotBytes[name]);

  // 4. Projects (configs read as files; invalid ones carry their published files forward).
  const projectsDir = join(exportsDir, 'projects');
  const configFiles = existsSync(projectsDir)
    ? readdirSync(projectsDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : [];
  const configs: ExportConfig[] = [];
  const brokenProjects: string[] = [];
  for (const name of configFiles) {
    const id = name.slice(0, -'.json'.length);
    if (!engine.isValidId(id)) {
      notices.push({
        project: id,
        kind: 'invalid-config',
        message: `${name}: not a valid project id`,
      });
      continue;
    }
    if (configs.length + brokenProjects.length >= limits.projects) {
      notices.push({
        project: id,
        kind: 'over-limit',
        message: `More than ${limits.projects} projects: not built`,
      });
      brokenProjects.push(id);
      continue;
    }
    try {
      const parsed = config.migrateConfig(
        JSON.parse(readFileSync(join(projectsDir, name), 'utf8')),
      );
      if (parsed.id !== id) throw new Error(`id "${parsed.id}" differs from the file name`);
      configs.push(parsed);
      const unknown = config.unknownCategories(
        parsed,
        (catalog.categories as { id: string }[]).map((category) => category.id),
      );
      if (unknown.length)
        notices.push({
          project: id,
          kind: 'compile',
          message: `Categories the pinned catalog lacks: ${unknown.join(', ')}`,
        });
    } catch (error) {
      brokenProjects.push(id);
      notices.push({
        project: id,
        kind: 'invalid-config',
        message: `${name}: ${(error as Error).message.slice(0, 300)}`,
      });
    }
  }

  const entries: Entry[] = [];
  for (const project of configs) {
    for (const file of project.files)
      entries.push({
        project: project.id,
        path: engine.filePath(project.id, file),
        fileId: file.id,
        file,
        kind: 'active',
      });
    for (const entry of project.retained ?? []) {
      const expired = Date.parse(entry.until) <= now.getTime();
      entries.push({
        project: project.id,
        path: entry.path,
        fileId: entry.snapshot.id,
        file: entry.snapshot,
        kind: expired ? 'expired' : 'retained',
        until: entry.until,
      });
      if (!expired)
        notices.push({
          project: project.id,
          file: entry.snapshot.id,
          path: entry.path,
          kind: 'retained-ends',
          message: `Keeps updating until ${entry.until}`,
        });
    }
  }
  for (const entry of entries)
    if (!safeSitePath(entry.path) || !entry.path.startsWith(`${entry.project}/`))
      throw new Error(`Path ${entry.path} is outside project ${entry.project}`);

  const outcomes = new Map<string, Outcome>();
  const legacyByName = new Map(pin.files.map((file) => [file.name, file]));
  const deployed = new Set<string>(engine.deployedLegacyPresets);

  // Carry a published file forward byte for byte, verified; failure stops the deploy.
  const carried = async (path: string): Promise<Uint8Array> => {
    const record = previous!.files[path]!;
    const bytes = await fetchBytes(`${previousUrl}${path}`);
    if (sha256(bytes) !== record.sha256)
      throw new Error(`Carried file ${path} does not match the manifest sha256`);
    return bytes;
  };
  const carryOrDrop = async (
    entry: Pick<Entry, 'project' | 'fileId' | 'path'>,
    kind: SiteNotice['kind'],
    reason: string,
    frozen = false,
  ) => {
    const record = previous?.files[entry.path];
    if (record) {
      const bytes = await carried(entry.path);
      outcomes.set(entry.path, {
        bytes,
        file: { ...record, outcome: frozen ? 'frozen' : 'carried' },
      });
      notices.push({
        project: entry.project,
        file: entry.fileId,
        path: entry.path,
        kind,
        message: `${reason}; the last published file stays`,
      });
    } else {
      notices.push({
        project: entry.project,
        file: entry.fileId,
        path: entry.path,
        kind: 'not-published',
        message: `${reason}; not published yet (404)`,
      });
    }
  };

  // 5a. Broken projects keep every URL they had.
  for (const project of brokenProjects)
    for (const path of Object.keys(previous?.files ?? {}).filter((path) =>
      path.startsWith(`${project}/`),
    ))
      await carryOrDrop(
        {
          project,
          fileId: path
            .split('/')
            .pop()!
            .replace(/\.json$/, ''),
          path,
        },
        'carried-forward',
        'The project config is invalid',
      );

  // 5b. Legacy-preset files are copies of `live` at pin.liveCommit, never rebuilt (spec section 3).
  const builds: Entry[] = [];
  for (const entry of entries) {
    if (entry.kind === 'expired') {
      await carryOrDrop(entry, 'frozen', `Retained until ${entry.until}: frozen`, true);
      continue;
    }
    if (engine.isLegacyFile(entry.file) && deployed.has(entry.file.preset)) {
      const name = engine.legacyFileName(entry.file.preset);
      const bytes = gitShow(liveDir, pin.liveCommit, `descriptions/${name}`);
      const record = legacyByName.get(name);
      if (!bytes || !record || sha256(bytes) !== record.sha256) {
        await carryOrDrop(entry, 'build-failed', `live has no pinned ${name} at ${pin.liveCommit}`);
        continue;
      }
      if (bytes.byteLength > limits.maxBytes) {
        await carryOrDrop(
          entry,
          'build-failed',
          `${name} is over the ${limits.maxBytes}-byte limit`,
        );
        continue;
      }
      const old = previous?.files[entry.path];
      const hash = sha256(bytes);
      outcomes.set(entry.path, {
        bytes,
        file: {
          sha256: hash,
          bytes: bytes.byteLength,
          lastUpdate: old?.sha256 === hash ? old.lastUpdate : nowIso,
          lastBuilt: nowIso,
          outcome: record.outcome,
          ...(entry.until ? { retainUntil: entry.until } : {}),
        },
      });
      if (record.outcome !== 'built')
        notices.push({
          project: entry.project,
          file: entry.fileId,
          path: entry.path,
          kind: record.outcome === 'frozen' ? 'frozen' : 'carried-forward',
          message: `${name} is ${record.outcome} at the old URL; this copy matches it`,
        });
      continue;
    }
    builds.push(entry);
  }

  // 5c. Everything else builds in the pool, least recently built first, within the budget:
  //     nothing new starts after `carryAfterMs`, and at `budgetMs` running builds are killed.
  builds.sort((a, b) => {
    const at = previous?.files[a.path]?.lastBuilt ?? '';
    const bt = previous?.files[b.path]?.lastBuilt ?? '';
    return at === bt ? a.path.localeCompare(b.path) : at < bt ? -1 : 1;
  });
  const pool = new BuildPool(
    script,
    {
      engineDir,
      inputPath: join(work, 'input.json'),
      catalogPath: join(work, 'catalog.json'),
      identicalPath: join(work, 'identical.json'),
    },
    limits.pool,
    limits.fileTimeoutMs,
  );
  const results = new Map<string, BuildResult>();
  const outPaths = new Map<string, string>();
  const skipped: Entry[] = [];
  const queue = [...builds];
  const running = new Map<string, Promise<string>>();
  let budgetHit = false;
  const elapsed = () => Date.now() - started;
  try {
    while (queue.length || running.size) {
      while (queue.length && running.size < limits.pool && elapsed() < limits.carryAfterMs) {
        const entry = queue.shift()!;
        const outPath = join(work, `out-${outPaths.size}.json`);
        outPaths.set(entry.path, outPath);
        const job: BuildJob = {
          key: entry.path,
          projectId: entry.project,
          path: entry.path,
          file: entry.file,
          outPath,
          maxBytes: limits.maxBytes,
        };
        running.set(
          entry.path,
          pool.run(job).then((result) => {
            results.set(entry.path, result);
            return entry.path;
          }),
        );
      }
      if (queue.length && elapsed() >= limits.carryAfterMs) {
        budgetHit = true;
        skipped.push(...queue.splice(0));
      }
      if (!running.size) continue;
      const untilBudget = Math.max(0, limits.budgetMs - elapsed());
      const untilCarry = Math.max(1, limits.carryAfterMs - elapsed());
      const wait = queue.length ? Math.min(untilBudget, untilCarry) : untilBudget;
      let timer: NodeJS.Timeout | undefined;
      const done = await Promise.race([
        ...running.values(),
        new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), wait))),
      ]);
      clearTimeout(timer);
      if (done !== undefined) running.delete(done);
      else if (elapsed() >= limits.budgetMs) {
        budgetHit = true;
        pool.close();
        for (const path of running.keys())
          skipped.push(builds.find((entry) => entry.path === path)!);
        running.clear();
      }
    }
  } finally {
    pool.close();
  }

  for (const entry of skipped) {
    results.delete(entry.path);
    await carryOrDrop(
      entry,
      'budget',
      "Not built within this run's time budget (it builds first next run)",
    );
    const kept = outcomes.get(entry.path);
    // Keep its old build time so the next run starts with it (no starvation).
    if (kept) kept.file = { ...kept.file, lastBuilt: previous?.files[entry.path]?.lastBuilt };
  }
  for (const entry of builds) {
    const result = results.get(entry.path);
    if (!result) continue;
    if (!result.ok) {
      const label =
        result.reason === 'timeout'
          ? 'Timed out'
          : result.reason === 'invalid'
            ? 'Invalid output'
            : result.reason === 'crashed'
              ? 'Build process crashed'
              : 'Build failed';
      await carryOrDrop(entry, 'build-failed', `${label}: ${result.error}`);
      continue;
    }
    const old = previous?.files[entry.path];
    // A retained URL freezes when its vocabulary changes (spec section 5); its baseline is the
    // vocabulary it had on the day it was retained.
    let baseline: string[] | undefined;
    if (entry.kind === 'retained') {
      baseline = old?.baseline ?? old?.markers ?? result.markers;
      const change = engine.markerChange(baseline, result.markers);
      if (change) {
        const list = (items: string[]) => items.slice(0, 5).join(', ') || 'none';
        await carryOrDrop(
          entry,
          'frozen',
          `Breaking change (added ${list(change.added)}; removed ${list(change.removed)})`,
          true,
        );
        const kept = outcomes.get(entry.path);
        if (kept) kept.file = { ...kept.file, baseline };
        continue;
      }
    }
    for (const notice of result.notices as Record<string, unknown>[])
      notices.push({
        project: entry.project,
        file: entry.fileId,
        path: entry.path,
        kind: 'compile',
        message: JSON.stringify(notice).slice(0, 300),
        detail: notice,
      });
    outcomes.set(entry.path, {
      from: outPaths.get(entry.path),
      file: {
        sha256: result.sha256,
        bytes: result.bytes,
        lastUpdate: old?.sha256 === result.sha256 ? old.lastUpdate : nowIso,
        lastBuilt: nowIso,
        outcome: 'built',
        ...(entry.until ? { retainUntil: entry.until } : {}),
        markers: result.markers,
        ...(baseline ? { baseline } : {}),
      },
    });
  }

  // 6. Write the site: files, per-project index.json, changelog, snapshot, status, manifest.
  const files: Record<string, ManifestFile> = {};
  const put = (path: string, bytes: Uint8Array) => writeFile(join(out, ...path.split('/')), bytes);
  for (const [path, outcome] of outcomes) {
    const bytes = outcome.bytes ?? readFileSync(outcome.from!);
    if (sha256(bytes) !== outcome.file.sha256) throw new Error(`${path} changed after its build`);
    put(path, bytes);
    files[path] = outcome.file;
  }
  const encoder = new TextEncoder();
  const record = (path: string, bytes: Uint8Array, outcome: ManifestFile['outcome'] = 'built') => {
    const old = previous?.files[path];
    const hash = sha256(bytes);
    put(path, bytes);
    files[path] = {
      sha256: hash,
      bytes: bytes.byteLength,
      lastUpdate: old?.sha256 === hash ? old.lastUpdate : nowIso,
      outcome,
    };
  };
  const projectNotices = (project: string) =>
    notices.filter((notice) => notice.project === project && notice.file !== undefined);
  for (const project of configs) {
    const built: Record<
      string,
      Omit<Engine.IndexFile, 'id' | 'formatVersion' | 'path' | 'until'>
    > = {};
    for (const [path, file] of Object.entries(files))
      if (path.startsWith(`${project.id}/`))
        built[path] = {
          sha256: file.sha256,
          bytes: file.bytes,
          lastUpdate: file.lastUpdate,
          outcome: file.outcome,
        };
    const index = engine.projectIndex(
      project,
      built,
      projectNotices(project.id).map((notice) =>
        notice.detail
          ? ({ ...notice.detail, file: notice.file! } as Engine.FileNotice)
          : { kind: notice.kind, file: notice.file!, message: notice.message },
      ),
    );
    record(`${project.id}/index.json`, encoder.encode(JSON.stringify(index)));
  }
  for (const project of brokenProjects)
    if (previous?.files[`${project}/index.json`]) {
      const path = `${project}/index.json`;
      put(path, await carried(path));
      files[path] = { ...previous.files[path]!, outcome: 'carried' };
    }

  const changelogPath = join(exportsDir, 'changelog.json');
  const changelog = existsSync(changelogPath)
    ? checkChangelog(readFileSync(changelogPath, 'utf8'))
    : { entries: [] };
  if (changelog) record('changelog.json', encoder.encode(JSON.stringify(changelog)));
  else {
    notices.push({
      kind: 'invalid-changelog',
      message: 'exports/changelog.json is invalid; the published one stays',
    });
    if (previous?.files['changelog.json']) {
      put('changelog.json', await carried('changelog.json'));
      files['changelog.json'] = { ...previous.files['changelog.json'], outcome: 'carried' };
    } else record('changelog.json', encoder.encode(JSON.stringify({ entries: [] })));
  }

  // Content-addressed snapshot for the preview, plus the last three carried (verified).
  const snapshots: Manifest['snapshots'] = [{ buildId, files: snapshotShas }];
  for (const name of snapshotNames) put(`_build/${buildId}/${name}`, snapshotBytes[name]);
  for (const snapshot of previous?.snapshots ?? []) {
    if (snapshots.length > siteLimits.snapshotsCarried) break;
    if (snapshots.some((kept) => kept.buildId === snapshot.buildId)) continue;
    for (const name of snapshotNames) {
      const bytes = await fetchBytes(`${previousUrl}_build/${snapshot.buildId}/${name}`);
      if (sha256(bytes) !== snapshot.files[name])
        throw new Error(`Carried snapshot ${snapshot.buildId}/${name} does not match`);
      put(`_build/${snapshot.buildId}/${name}`, bytes);
    }
    snapshots.push(snapshot);
  }

  const status = {
    buildId,
    builtAt: nowIso,
    files: snapshotShas,
    engine: enginePin,
    converterSha: pin.converterSha,
    generatorSha: pin.generatorSha,
    manifestVersion: pin.manifestVersion,
    pinId: pin.pinId,
    liveCommit: pin.liveCommit,
    legacy: Object.fromEntries(
      pin.files.map((file) => [file.name, { sha256: file.sha256, outcome: file.outcome }]),
    ),
  };
  const manifest: Manifest = {
    manifestVersion,
    buildId,
    builtAt: nowIso,
    pinId: pin.pinId,
    files,
    snapshots,
  };
  put('_build/status.json', encoder.encode(json(status)));
  put('_build/notices.json', encoder.encode(json(notices)));
  put('_build/manifest.json', encoder.encode(json(manifest)));
  put('_headers', encoder.encode(headersFile(snapshots.map((snapshot) => snapshot.buildId))));
  rmSync(work, { recursive: true, force: true });

  const counts = { built: 0, carried: 0, frozen: 0 };
  for (const [path, file] of Object.entries(files))
    if (!path.endsWith('index.json') && path !== 'changelog.json') counts[file.outcome] += 1;
  const result = {
    deploy: true,
    buildId,
    pinId: pin.pinId,
    pinSource: effective.source,
    bootstrap: state.zeroDeployments,
    budgetHit,
    counts,
    notices: notices.length,
    elapsedMs: Date.now() - started,
  };
  finish(result);
  console.log(JSON.stringify(result));
  stepSummary(
    [
      `### data site build ${buildId}`,
      '',
      `Pin ${pin.pinId} (${effective.source}); built ${counts.built}, carried ${counts.carried}, frozen ${counts.frozen}; ${notices.length} notices.`,
      '',
      ...notices
        .slice(0, 50)
        .map(
          (notice) =>
            `- ${notice.kind} ${notice.path ?? notice.project ?? ''}: ${notice.message.replace(/[\r\n|<>`]/g, ' ')}`,
        ),
    ].join('\n'),
  );
}

/** `exports/changelog.json`: `{ entries: [{ date, text }] }`, plain strings, bounded. */
export function checkChangelog(
  text: string,
): { entries: { date: string; text: string }[] } | undefined {
  try {
    const value = JSON.parse(text) as { entries?: unknown };
    const keys = Object.keys(value ?? {});
    if (keys.length !== 1 || !Array.isArray(value.entries) || value.entries.length > 500)
      return undefined;
    for (const entry of value.entries as Record<string, unknown>[]) {
      if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join() !== 'date,text')
        return undefined;
      if (typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date))
        return undefined;
      if (
        typeof entry.text !== 'string' ||
        entry.text.length > 1000 ||
        // Control characters other than a line break.
        [...entry.text].some((char) => {
          const code = char.charCodeAt(0);
          return (code < 32 && code !== 10) || code === 127;
        })
      )
        return undefined;
    }
    return value as { entries: { date: string; text: string }[] };
  } catch {
    return undefined;
  }
}

/**
 * `_headers` (spec section 3, "Hosting"). Pages joins a header set by two matching rules with a
 * comma, so each specific rule first detaches the general Cache-Control (`! Cache-Control`).
 */
export function headersFile(buildIds: readonly string[]) {
  const rule = (path: string, cache: string, detach: boolean) =>
    [path, ...(detach ? ['  ! Cache-Control'] : []), `  Cache-Control: ${cache}`].join('\n');
  return (
    [
      ['/*', '  Access-Control-Allow-Origin: *', '  Cache-Control: public, max-age=300'].join('\n'),
      ...['status.json', 'manifest.json', 'notices.json'].map((name) =>
        rule(`/_build/${name}`, 'no-cache', true),
      ),
      ...buildIds.map((id) => rule(`/_build/${id}/*`, 'public, max-age=31536000, immutable', true)),
    ].join('\n') + '\n'
  );
}
// --- entry -------------------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === 'child') return childMain();
  if (command === 'locate') return locate(options);
  if (command === 'build') return buildSite(options);
  throw new Error('Usage: build-site.mjs locate|build [--options]');
}
export type { Pin };
