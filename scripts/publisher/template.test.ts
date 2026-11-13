import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import * as z from 'zod';
import { langSchema } from '../../packages/core/src/languages.js';
import { verifyRuntime } from './pipeline.js';

it('ships the reviewed v2 template with a matching integrity pin and documentation', () => {
  const root = 'scripts/publisher/template/.publisher';
  const pin = verifyRuntime(root);
  expect(pin).toEqual({
    sourceSha: 'eefb3ede788d3ae1a4f582135c33e0204db6a847',
    sha256: '631780bbe5e8d5efe9573435f412b43012399a8e4fee309a4bf5b10331893a5e',
    capabilities: ['elementTags', 'sandboxPointers'],
  });
  expect(
    createHash('sha256')
      .update(readFileSync(`${root}/publisher.mjs`))
      .digest('hex'),
  ).toBe(pin.sha256);
  for (const file of ['README.md', 'E2-RUNBOOK.md']) {
    const doc = readFileSync(`scripts/publisher/${file}`, 'utf8');
    expect(doc).toContain(pin.sourceSha);
    expect(doc).toContain(pin.sha256);
  }
});

it('initializes bundled report schemas without reading globals or performing I/O', () => {
  const runtime = readFileSync('scripts/publisher/template/.publisher/publisher.mjs', 'utf8');
  const start = runtime.indexOf('// packages/core/src/reports/schemas.ts\n');
  const end = runtime.indexOf('// apps/worker/src/stamp.ts\n', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const globals: Record<string, unknown> = { external_exports: z, langSchema };
  const context = new Proxy(globals, {
    get(target, key) {
      if (typeof key === 'string' && Object.hasOwn(target, key)) return target[key];
      throw new Error(`Unexpected global read: ${String(key)}`);
    },
  });
  // Only the report section is executed; the CLI entrypoint is deliberately excluded.
  expect(() =>
    runInNewContext(runtime.slice(start, end), context, { timeout: 1000 }),
  ).not.toThrow();
});

// Git subprocess fixtures exceed 20 seconds on Windows.
vi.setConfig({ testTimeout: 300_000 });

/** The `run:` script of the named template pipeline step, dedented the way YAML does it. */
function stepScript(name: string) {
  const lines = readFileSync('scripts/publisher/template/.github/workflows/pipeline.yml', 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  expect(start).toBeGreaterThan(0);
  const run = lines.findIndex((l, i) => i > start && l.trim() === 'run: |');
  const indent = lines[run + 1].search(/\S/);
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  // Workflow expressions stay in env blocks, never interpolated into a script.
  expect(body.join('\n')).not.toContain('${{');
  return body.join('\n') + '\n';
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

it('report-items jobs rebuild both catalogs for the published bundle, leased and fast-forward only', () => {
  const root = mkdtempSync(join(tmpdir(), 'report-items-'));
  roots.push(root);
  const identity = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false'];
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', [...identity, '-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  const origin = join(root, 'origin.git'),
    seed = join(root, 'seed'),
    ref = 'refs/heads/editor-data-bundle';
  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  mkdirSync(join(seed, 'scripts'), { recursive: true });
  git(seed, 'init');
  // Stand-in for editor-data's scripts/build-report-items.mjs: same arguments and output shape.
  writeFileSync(
    join(seed, 'scripts/build-report-items.mjs'),
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      'const out = process.argv[2];',
      "const bundle = JSON.parse(readFileSync(out + '/bundle.json', 'utf8'));",
      'const generatorCommit = process.env.REPORTS_GENERATOR_COMMIT;',
      "if (!/^[a-f0-9]{40}$/.test(generatorCommit ?? '')) throw new Error('generator');",
      "for (const name of ['report-items.worker', 'report-items']) {",
      '  const items = { [name]: Object.keys(bundle.tooltips) };',
      '  const catalog = { v: 1, sourceCommit: bundle.sourceCommit, generatorCommit, items };',
      "  writeFileSync(`${out}/${name}.json`, JSON.stringify(catalog) + '\\n');",
      '}',
      '',
    ].join('\n'),
  );
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'Seed data');
  git(seed, 'push', origin, 'HEAD:refs/heads/editor-data');
  const commit = (files: Record<string, string>, parent?: string) => {
    const env = { ...process.env, GIT_INDEX_FILE: join(root, `index-${Math.random()}`) };
    const run = (args: string[], input?: string) =>
      execFileSync('git', [...identity, '--git-dir', origin, ...args], {
        env,
        input,
        encoding: 'utf8',
      }).trim();
    run(['read-tree', '--empty']);
    for (const [p, bytes] of Object.entries(files)) {
      const oid = run(['hash-object', '-w', '--stdin'], bytes);
      run(['update-index', '--add', '--cacheinfo', `100644,${oid},${p}`]);
    }
    const tree = run(['write-tree']);
    return run(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Bundle']);
  };
  const bundleHead = () => git(origin, 'rev-parse', ref);
  const setBundle = (c: string) => git(origin, 'update-ref', ref, c);
  const show = (c: string, p: string) => git(origin, 'show', `${c}:${p}`);
  const tree = (c: string) =>
    Object.fromEntries(
      git(origin, 'ls-tree', c)
        .split('\n')
        .map((l) => [l.split('\t')[1], l.split('\t')[0].split(' ')[2]]),
    );
  const source = (n: number) => String(n).repeat(40);
  const bundleJson = (n: number, hashes = ['123']) =>
    JSON.stringify({
      sourceCommit: source(n),
      tooltips: Object.fromEntries(hashes.map((h) => [h, {}])),
    });
  const catalog = (n: number) =>
    `{"v":1,"sourceCommit":"${source(n)}","generatorCommit":"${'e'.repeat(40)}","items":{}}\n`;
  // The publisher's push: a new bundle.json with the previous bundle's catalogs carried forward.
  setBundle(
    commit({
      'bundle.json': bundleJson(2),
      'report-items.json': catalog(1),
      'report-items.worker.json': catalog(1),
    }),
  );
  // Stand-ins for npm and the pinned editor's esbuild (which here only copies the script).
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'npm'), 0o755);
  let jobs = 0;
  function job(name: string, env: Record<string, string>, ...steps: string[]) {
    const ws = join(root, `${name}-${++jobs}`),
      temp = join(root, `temp-${jobs}`),
      output = join(temp, 'github-output');
    git(root, 'clone', '-q', '--branch', 'editor-data', origin, ws);
    mkdirSync(temp);
    writeFileSync(output, '');
    if (name === 'report-items') {
      const generator = join(ws, '.report-generator');
      mkdirSync(generator);
      git(generator, 'init', '-q');
      // A fixed date keeps the pinned generator's commit identical across jobs.
      execFileSync(
        'git',
        [...identity, '-C', generator, 'commit', '-q', '--allow-empty', '-m', 'Generator'],
        {
          env: {
            ...process.env,
            GIT_AUTHOR_DATE: '2026-11-12T00:00:00Z',
            GIT_COMMITTER_DATE: '2026-11-12T00:00:00Z',
          },
        },
      );
      const esbuild = join(ws, '.report-source/node_modules/.bin/esbuild');
      mkdirSync(join(esbuild, '..'), { recursive: true });
      writeFileSync(
        esbuild,
        '#!/bin/sh\nfor a; do case "$a" in --outfile=*) out="${a#--outfile=}";; esac; done\ncp "$1" "$out"\n',
      );
      chmodSync(esbuild, 0o755);
    }
    let result: { status: number | null; stdout: string; stderr: string } = {
      status: 0,
      stdout: '',
      stderr: '',
    };
    for (const step of steps) {
      result = spawnSync('bash', ['-c', stepScript(step)], {
        cwd: ws,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: bin + delimiter + process.env.PATH,
          RUNNER_TEMP: temp,
          GITHUB_OUTPUT: output,
          ...env,
        },
      });
      if (result.status !== 0) break;
    }
    return { ...result, temp, output: readFileSync(output, 'utf8') };
  }
  const build = () => {
    const r = job('report-items', {}, 'Read the published bundle', 'Build both report catalogs');
    expect(r.status, r.stderr).toBe(0);
    return {
      head: /^head=([0-9a-f]{40})$/m.exec(r.output)![1],
      catalogs: join(r.temp, 'report-items'),
    };
  };
  const push = (built: { head: string; catalogs: string }, env: Record<string, string> = {}) => {
    // The artifact hop: the push job runs on its own runner with a downloaded copy.
    const catalogs = join(root, `artifact-${jobs}`);
    cpSync(built.catalogs, catalogs, { recursive: true });
    return job(
      'report-items-push',
      { BUNDLE_HEAD: built.head, CATALOGS: catalogs, ...env },
      'Validate and push the report catalogs',
    );
  };
  const names = ['report-items.json', 'report-items.worker.json'];

  // (1) Carried-forward catalogs: one fast-forward commit on the head it read, for its source.
  const published = bundleHead();
  const first = push(build());
  expect(first.status, first.stderr).toBe(0);
  const refreshed = bundleHead();
  expect(git(origin, 'rev-parse', `${refreshed}^`)).toBe(published);
  expect(Object.keys(tree(refreshed)).sort()).toEqual(['bundle.json', ...names]);
  expect(tree(refreshed)['bundle.json']).toBe(tree(published)['bundle.json']);
  for (const name of names) {
    const c = JSON.parse(show(refreshed, name));
    expect(c.sourceCommit).toBe(source(2));
    expect(c.generatorCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(c.items).not.toEqual({});
  }
  expect(git(origin, 'log', '-1', '--format=%s', refreshed)).toBe(
    `Report catalogs for ${source(2)}`,
  );

  // (2) Unchanged bundle: a no-op, no commit.
  const again = push(build());
  expect(again.status, again.stderr).toBe(0);
  expect(again.stdout).toContain('already current');
  expect(bundleHead()).toBe(refreshed);

  // (3) The head moves after the build: fail closed before writing anything.
  const carried = Object.fromEntries(names.map((p) => [p, show(refreshed, p) + '\n']));
  const built = build();
  const moved = commit({ ...carried, 'bundle.json': bundleJson(3, ['123', '456']) }, refreshed);
  setBundle(moved);
  const raced = push(built);
  expect(raced.status).not.toBe(0);
  expect(raced.stdout + raced.stderr).toContain('moved after the catalogs were built');
  expect(bundleHead()).toBe(moved);

  // (4) The head moves between the push job's read and its push: the lease rejects it.
  const racer = commit({ ...carried, 'bundle.json': bundleJson(4) }, moved);
  const hooks = join(root, 'hooks');
  mkdirSync(hooks);
  writeFileSync(
    join(hooks, 'pre-push'),
    `#!/bin/sh\ngit --git-dir "$RACE_ORIGIN" update-ref ${ref} ${racer}\n`,
  );
  chmodSync(join(hooks, 'pre-push'), 0o755);
  const leased = push(build(), {
    RACE_ORIGIN: origin,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hooks.replace(/\\/g, '/'),
  });
  expect(leased.status).not.toBe(0);
  expect(leased.stderr).toMatch(/stale info|rejected|failed to push/);
  expect(bundleHead()).toBe(racer);

  // (5) A catalog for another source, or an extra file, never lands.
  for (const tamper of [
    (dir: string) => writeFileSync(join(dir, 'report-items.json'), catalog(9)),
    (dir: string) => writeFileSync(join(dir, 'extra.json'), '{}\n'),
  ]) {
    const bad = build();
    tamper(bad.catalogs);
    const rejected = push(bad);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toMatch(/not a catalog for this bundle|Unexpected catalog files/);
    expect(bundleHead()).toBe(racer);
  }
});
