// Dry-run harness (EXPORT-P2 scope 4): local bare git repositories stand in for
// Live-Clarity-Database (branches converter, live, editor-data, export-pins) and the data generator
// (v2), and a folder stands in for the Pages project. Each "workflow run" clones the branch heads
// the way the workflow's checkouts do (blobless, full history) and runs the same scripts the
// workflows call (.exports/legacy-job.mjs, .exports/build-site.mjs). No network, no Cloudflare.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const packageDir = fileURLToPath(new URL('../../', import.meta.url));
export const fixturesDir = join(packageDir, 'test', 'fixtures');

export const git = (cwd: string, args: string[], input?: string) =>
  execFileSync('git', args, {
    cwd,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'harness',
      GIT_AUTHOR_EMAIL: 'h@example.invalid',
      GIT_COMMITTER_NAME: 'harness',
      GIT_COMMITTER_EMAIL: 'h@example.invalid',
    },
  })
    .toString('utf8')
    .trim();

/** Builds dist/ once per process (the bundles the workflows run). */
let built: Promise<void> | undefined;
export const buildDist = () =>
  (built ??= import(pathToFileURL(join(packageDir, 'build.mjs')).href).then(() => undefined));

export type RunResult = {
  status: number;
  stdout: string;
  stderr: string;
  result?: Record<string, unknown>;
};

export class Harness {
  readonly root = mkdtempSync(join(tmpdir(), 'export-harness-'));
  readonly lcd = join(this.root, 'Live-Clarity-Database.git');
  readonly generator = join(this.root, 'generator.git');
  readonly pages = join(this.root, 'pages');
  /** `.exports/` as installed on `converter`. Tests may swap engine.mjs for a wrapper. */
  readonly exports = join(this.root, 'exports-install');
  generatorSha = '';
  private runs = 0;

  constructor() {
    for (const repo of [this.lcd, this.generator]) {
      mkdirSync(repo);
      git(repo, ['init', '--bare', '--quiet', '--initial-branch=main']);
      // As on GitHub: partial clones and fetching any reachable commit by id.
      git(repo, ['config', 'uploadpack.allowFilter', 'true']);
      git(repo, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    }
    mkdirSync(this.pages);
  }

  /** Commits `files` (path -> content, null deletes) on `branch` of `repo` and returns the SHA. */
  commit(
    branch: string,
    files: Record<string, string | Uint8Array | null>,
    message = `Update ${branch}`,
    repo = this.lcd,
  ) {
    const dir = mkdtempSync(join(this.root, 'w-'));
    const exists = git(repo, ['branch', '--list', branch]) !== '';
    if (exists) git(this.root, ['clone', '--quiet', '--branch', branch, repo, dir]);
    else {
      git(this.root, ['init', '--quiet', dir]);
      git(dir, ['checkout', '--quiet', '--orphan', branch]);
      git(dir, ['remote', 'add', 'origin', repo]);
    }
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, path);
      if (content === null) rmSync(full, { recursive: true, force: true });
      else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
    }
    git(dir, ['add', '-A']);
    git(dir, ['commit', '--quiet', '--allow-empty', '-F', '-'], message);
    git(dir, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
    const sha = git(dir, ['rev-parse', 'HEAD']);
    rmSync(dir, { recursive: true, force: true });
    return sha;
  }

  head(branch: string, repo = this.lcd) {
    return git(repo, ['rev-parse', `refs/heads/${branch}`]);
  }

  show(rev: string, path: string, repo = this.lcd): Buffer | undefined {
    try {
      return execFileSync('git', ['cat-file', 'blob', `${rev}:${path}`], {
        cwd: repo,
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 256 * 1024 * 1024,
      });
    } catch {
      return undefined;
    }
  }

  /** Seeds every branch: converter input, a deployed `live` (old-style deploy commit), pins, configs. */
  async seed({ input, projects = {} }: { input: string; projects?: Record<string, unknown> }) {
    await buildDist();
    const catalog = JSON.parse(
      gunzipSync(readFileSync(join(fixturesDir, 'catalog-c3fed8c.json.gz'))).toString('utf8'),
    );
    this.generatorSha = this.commit(
      'v2',
      {
        'templates/v2/items.json': JSON.stringify(catalog.items),
        'templates/v2/categories.json': JSON.stringify(catalog.categories),
      },
      'Generator',
      this.generator,
    );
    mkdirSync(this.exports, { recursive: true });
    for (const file of ['engine.mjs', 'config.mjs', 'build-site.mjs', 'legacy-job.mjs'])
      cpSync(join(packageDir, 'dist', file), join(this.exports, file));
    writeFileSync(join(this.exports, 'PIN'), 'harness\n');
    writeFileSync(
      join(this.exports, 'config.json'),
      JSON.stringify({ generatorSha: this.generatorSha }),
    );
    // `.exports/` is installed on converter, as INSTALL.md describes.
    const install: Record<string, Uint8Array> = {};
    for (const file of [
      'engine.mjs',
      'config.mjs',
      'build-site.mjs',
      'legacy-job.mjs',
      'PIN',
      'config.json',
    ])
      install[`.exports/${file}`] = readFileSync(join(this.exports, file));
    const converterSha = this.commit(
      'converter',
      { 'liveDescriptions.json': input, ...install },
      'Updated by harness',
    );
    // live as today's deploy action left it: built from that converter commit.
    const engine = await import(pathToFileURL(join(this.exports, 'engine.mjs')).href);
    const parsed = JSON.parse(input);
    const files: Record<string, string | Uint8Array> = {
      'README.md': '# Live\n',
      '.github/workflows/contributors.yml': 'name: Update contributors\n',
      'versions.json': JSON.stringify({ descriptions: 2.0625 }, null, 1),
    };
    for (const preset of engine.deployedLegacyPresets)
      files[`descriptions/${engine.legacyFileName(preset)}`] = engine.buildLegacy(parsed, preset, {
        identical: [],
      });
    this.commit(
      'live',
      files,
      `Deploying to live from @ Database-Clarity/Live-Clarity-Database@${converterSha} 🚀`,
    );
    this.commit('export-pins', { 'README.md': '# export-pins\n' }, 'export-pins');
    const projectFiles: Record<string, string> = { 'README.md': '# editor-data\n' };
    for (const [id, config] of Object.entries(projects))
      projectFiles[`exports/projects/${id}.json`] = JSON.stringify(config, null, 2);
    this.commit('editor-data', projectFiles, 'editor-data');
    return converterSha;
  }

  /** A workflow checkout: the branch head now, blobless with full history (actions/checkout filter). */
  checkout(branch: string, repo = this.lcd) {
    const dir = mkdtempSync(join(this.root, `co-${branch}-`));
    git(this.root, [
      'clone',
      '--quiet',
      '--filter=blob:none',
      '--no-tags',
      '--branch',
      branch,
      pathToFileURL(repo).href,
      dir,
    ]);
    return dir;
  }

  /** Runs a script the way the workflow step does (`script`: a path, or a name in the install). */
  node(script: string, args: string[], env: NodeJS.ProcessEnv = {}): RunResult {
    const path = isAbsolute(script) ? script : join(this.exports, script);
    const run = spawnSync(process.execPath, [path, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: '', ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
  }

  /** The legacy job (build-outputs.yml job `legacy`). `checkouts` lets a test hold an older checkout. */
  legacyRun({
    runId = String(++this.runs),
    attempt = '1',
    manifest = 'ok',
    vocab,
    checkouts,
    editManifest,
  }: {
    runId?: string;
    attempt?: string;
    manifest?: 'ok' | 'fail' | 'changed';
    vocab?: Record<string, string[]>;
    checkouts?: { converter: string; live: string; pins: string };
    /** Changes the written manifest file (`inventoryItem`, `sandboxPerk`) before the run. */
    editManifest?: (manifest: Record<string, Record<string, unknown>>) => void;
  } = {}): RunResult {
    const dirs = checkouts ?? this.legacyCheckouts();
    const manifestFile = join(this.root, `manifest-${manifest}.json`);
    if (manifest !== 'fail') {
      const base = JSON.parse(readFileSync(join(fixturesDir, 'legacy-manifest.json'), 'utf8'));
      if (manifest === 'changed')
        for (const item of Object.values(base.inventoryItem) as {
          displayProperties?: { description?: string };
        }[])
          if (item.displayProperties) item.displayProperties.description = 'changed';
      const written = { inventoryItem: base.inventoryItem };
      editManifest?.(written);
      writeFileSync(
        manifestFile,
        JSON.stringify({ version: manifest === 'changed' ? 'v-changed' : 'v-1', ...written }),
      );
    }
    const args = [
      'run',
      '--converter',
      dirs.converter,
      '--live',
      dirs.live,
      '--pins',
      dirs.pins,
      '--run-id',
      runId,
      '--attempt',
      attempt,
      '--manifest-file',
      manifestFile,
      '--result',
      join(this.root, `legacy-${runId}-${attempt}.json`),
    ];
    if (vocab) {
      const path = join(this.root, `vocab-${runId}.json`);
      writeFileSync(path, JSON.stringify({ presets: vocab }));
      args.push('--vocab', path);
    }
    // As in the workflow: the converter checkout's own `.exports/legacy-job.mjs`.
    const run = this.node(join(dirs.converter, '.exports', 'legacy-job.mjs'), args);
    const resultPath = join(this.root, `legacy-${runId}-${attempt}.json`);
    if (existsSync(resultPath)) run.result = JSON.parse(readFileSync(resultPath, 'utf8'));
    return run;
  }

  legacyCheckouts() {
    return {
      converter: this.checkout('converter'),
      live: this.checkout('live'),
      pins: this.checkout('export-pins'),
    };
  }

  /** The site job: locate, build, then the (simulated) atomic Pages deploy when build says so. */
  siteRun({ extra = [] }: { extra?: string[] } = {}): RunResult & {
    deployed?: string;
    out: string;
  } {
    const n = ++this.runs;
    const state = join(this.root, `state-${n}.json`);
    const out = join(this.root, `site-${n}`);
    const resultPath = join(this.root, `site-${n}.json`);
    // As in the workflow: the converter checkout's `.exports/build-site.mjs` (head); it loads the
    // engine the pin names from converter by SHA.
    const converter = this.checkout('converter');
    const script = join(converter, '.exports', 'build-site.mjs');
    const located = this.node(script, ['locate', '--pages-sim', this.pages, '--out', state]);
    if (located.status !== 0) return { ...located, out };
    const run = this.node(script, [
      'build',
      '--state',
      state,
      '--converter',
      converter,
      '--live',
      this.checkout('live'),
      '--pins',
      this.checkout('export-pins'),
      '--exports',
      join(this.checkout('editor-data'), 'exports'),
      '--generator',
      this.checkout('v2', this.generator),
      '--out',
      out,
      '--result',
      resultPath,
      ...extra,
    ]);
    const result = existsSync(resultPath)
      ? JSON.parse(readFileSync(resultPath, 'utf8'))
      : undefined;
    if (run.status !== 0 || !result?.deploy) return { ...run, result, out };
    return { ...run, result, out, deployed: this.deploy(out) };
  }

  /** Simulated Pages deploy: a new deployment folder, then the served pointer switches (atomic). */
  deploy(out: string) {
    const ids = existsSync(join(this.pages, 'deployments'))
      ? readdirSync(join(this.pages, 'deployments')).map(Number)
      : [];
    const id = String(Math.max(0, ...ids) + 1);
    cpSync(out, join(this.pages, 'deployments', id), { recursive: true });
    writeFileSync(join(this.pages, 'canonical'), id);
    return id;
  }

  /** A file as the served deployment has it. */
  served(path: string): Buffer | undefined {
    if (!existsSync(join(this.pages, 'canonical'))) return undefined;
    const id = readFileSync(join(this.pages, 'canonical'), 'utf8').trim();
    const full = join(this.pages, 'deployments', id, ...path.split('/'));
    return existsSync(full) ? readFileSync(full) : undefined;
  }

  servedJson<T = Record<string, unknown>>(path: string): T {
    const bytes = this.served(path);
    if (!bytes) throw new Error(`${path} is not served`);
    return JSON.parse(bytes.toString('utf8')) as T;
  }

  /**
   * Converter files that install an engine wrapper in `.exports/`: the real engine, except that
   * chosen file ids are slow or hang. Commit them to `converter` (a new engine PIN).
   */
  wrapEngine(
    behaviour: { slowMs?: Record<string, number>; hang?: string[] },
    pin = 'harness-wrapped',
  ): Record<string, string | Uint8Array> {
    return {
      '.exports/real-engine.mjs': readFileSync(join(this.exports, 'engine.mjs')),
      '.exports/PIN': `${pin}
`,
      '.exports/engine.mjs': `import * as real from './real-engine.mjs';
export * from './real-engine.mjs';
const behaviour = ${JSON.stringify(behaviour)};
export function compile(input, file, options) {
  const wait = behaviour.slowMs?.[file.id];
  if (wait) { const end = Date.now() + wait; while (Date.now() < end) {} }
  if (behaviour.hang?.includes(file.id)) for (;;) {}
  return real.compile(input, file, options);
}
`,
    };
  }

  cleanup() {
    rmSync(this.root, { recursive: true, force: true, maxRetries: 5 });
  }
}
