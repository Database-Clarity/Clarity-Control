import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import { langSchema } from '../../packages/core/src/languages.js';
import { verifyRuntime } from './pipeline.js';
import { maxBuffer } from './childProcess.mjs';

it('ignores exports, glossary, snippets, and entry marks on editor-data pushes', () => {
  const workflow = readFileSync(
    'scripts/publisher/template/.github/workflows/pipeline.yml',
    'utf8',
  );
  expect(workflow).toContain(
    "paths-ignore: ['exports/**', 'glossary/**', 'snippets/**', 'config/marks.json', 'current-saves/**']",
  );
});

it('gates both production jobs on a confirmed handoff and retains existing reusable callers', () => {
  const caller = readFileSync('scripts/publisher/template/production-job.yml', 'utf8');
  expect(caller).toContain("if: needs.pipeline.outputs.production_push == 'true'");
  expect(caller).toContain('publication: ${{ needs.pipeline.outputs.publication }}');
  expect(caller).toContain('secrets: inherit');
  const workflow = readFileSync(
    'scripts/publisher/template/.github/workflows/build-outputs.yml',
    'utf8',
  );
  expect(workflow).toContain("default: ''");
  expect(workflow).toContain("ref: ${{ needs.handoff.outputs.converter || 'converter' }}");
  expect(workflow).toContain("ref: ${{ needs.handoff.outputs.record || 'editor-data' }}");
  expect(workflow).toContain("ref: ${{ needs.handoff.outputs.generator || 'v2' }}");
  expect(workflow).toContain(
    'node producer/.publisher/verify-publication.mjs converter producer pins live',
  );
  expect(workflow).toContain("(inputs.publication == '' || needs.legacy.result == 'success')");
});

it('ships the reviewed v2 template with a matching integrity pin and documentation', () => {
  const root = 'scripts/publisher/template/.publisher';
  const pin = verifyRuntime(root);
  expect(pin).toEqual({
    sourceSha: 'b1ca6b2ecd38eeb918b38c3df707b06e535419c5',
    sha256: 'b890deab510347cae7da449981ccfb5d4beb3f6d060bfd8eaddb60b5305c8310',
    verifierSha256: 'd960337b7435cb3a8464f03aa8221476c3bc571da341d683ab4dc3e58a2a304f',
    capabilities: [
      'elementTags',
      'sandboxPointers',
      'scheduledBatches',
      'markupBraces',
      'prismaticTags',
      'inactiveMoves',
      'arrowSymbol',
      'numberTokens',
      'aliasGroups',
      'globalsRelease',
      'globalsExportsV1',
      'globalsConfigWithoutMarksV1',
      'scheduledGlobalsV1',
      'schedulePreparationV1',
      'draftBatchStagingV1',
      'scheduledBatchStagingV1',
      'currentSaveStagingV1',
      'exoticTags',
      'aliasGroupRemovals',
      'globalsInPlaceV1',
    ],
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
  // The report section ends at the next bundled module's header (esbuild's `// <path>` line).
  const next = /^\/\/ (?:packages|apps|scripts)\/\S+$/gm;
  next.lastIndex = start + 1;
  const end = next.exec(runtime)?.index ?? -1;
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  // zod and languages are lazily initialised bundle modules since the request union imports the
  // schedule subpath on demand: their init calls are the bundle's own, satisfied by the globals.
  const globals: Record<string, unknown> = {
    external_exports: z,
    langSchema,
    init_zod: () => undefined,
    init_languages: () => undefined,
  };
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
function stepScript(name: string, workflow = 'pipeline.yml') {
  const lines = readFileSync(`scripts/publisher/template/.github/workflows/${workflow}`, 'utf8')
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
  const workflow = readFileSync(
    'scripts/publisher/template/.github/workflows/pipeline.yml',
    'utf8',
  );
  expect(workflow).toContain(
    'group: editor-data-report-items-push-${{ needs.report-items.outputs.head }}',
  );
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

  // (3) A superseded artifact is a successful no-op.
  const carried = Object.fromEntries(names.map((p) => [p, show(refreshed, p) + '\n']));
  const built = build();
  const moved = commit({ ...carried, 'bundle.json': bundleJson(3, ['123', '456']) }, refreshed);
  setBundle(moved);
  const raced = push(built);
  expect(raced.status).toBe(0);
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
  expect(leased.status, leased.stderr).toBe(0);
  expect(leased.stdout).toContain('advanced during the push');
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

  // (6) A push failure without head movement remains a failure.
  writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\nexit 1\n');
  const failed = push(build(), {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hooks.replace(/\\/g, '/'),
  });
  expect(failed.status).not.toBe(0);
  expect(bundleHead()).toBe(racer);
  const latest = push(build());
  expect(latest.status, latest.stderr).toBe(0);
  for (const name of names)
    expect(JSON.parse(show(bundleHead(), name)).sourceCommit).toBe(source(4));
});

it('the pipeline step publishes for real only when the installed config says publishWritesEnabled: true', () => {
  const step = stepScript('Bundle live data and publish (or simulate)', 'publisher-run.yml');
  // The former inline preview step, before extracting it into a reusable workflow.
  expect(createHash('sha256').update(step).digest('hex')).toBe(
    'bf431a7d75f50ce32e9ee29686015b0f6cfaadd06e1de3b2aa30e7da8e316385',
  );
  const cases: [unknown, string][] = [
    [true, '--pipeline-publish'],
    [false, '--pipeline-dry-run'],
    ['true', '--pipeline-dry-run'],
    [undefined, '--pipeline-dry-run'],
  ];
  for (const [value, mode] of cases) {
    const ws = mkdtempSync(join(tmpdir(), 'pipeline-mode-'));
    roots.push(ws);
    mkdirSync(join(ws, '.publisher'));
    writeFileSync(
      join(ws, '.publisher/config.json'),
      JSON.stringify(value === undefined ? {} : { publishWritesEnabled: value }),
    );
    // Stand-in runtime: prints the arguments the workflow gave it.
    writeFileSync(
      join(ws, '.publisher/publisher.mjs'),
      "console.log('ARGS ' + process.argv.slice(2).join(' '));\n",
    );
    const result = spawnSync('bash', ['-c', step], {
      cwd: ws,
      encoding: 'utf8',
      env: { ...process.env, ARTIFACT_DIR: 'out' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`ARGS ${mode} . .publisher/config.json out\n`);
  }
});

describe('install.mjs', () => {
  const identity = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false'];
  /** A clean editor-data checkout whose origin names the data repository (never contacted). */
  function checkout(capabilities?: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'install-checkout-'));
    roots.push(dir);
    const git = (...args: string[]) => execFileSync('git', [...identity, '-C', dir, ...args]);
    git('init', '-q', '-b', 'editor-data');
    writeFileSync(join(dir, 'README.md'), 'data\n');
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    writeFileSync(join(dir, '.github/workflows/bundle.yml'), 'name: bundle\n');
    git('add', '.');
    git('commit', '-q', '-m', 'Seed');
    git('remote', 'add', 'origin', 'https://github.com/Database-Clarity/Live-Clarity-Database.git');
    if (capabilities) {
      mkdirSync(join(dir, '.publisher'));
      writeFileSync(join(dir, '.publisher/PIN'), JSON.stringify({ capabilities }));
      git('add', '.publisher/PIN');
      git('commit', '-q', '-m', 'Install capability floor');
    }
    return dir;
  }
  function install(
    cwd: string,
    publishWritesEnabled: unknown,
    mode = '--plan',
    capabilities?: string[],
    targetArg?: string,
    liveBranch = 'converter-v2-test',
    previousBranch?: string,
  ) {
    const pin = JSON.parse(
      readFileSync(join(cwd, 'scripts/publisher/template/.publisher/PIN'), 'utf8'),
    );
    const example = JSON.parse(
      readFileSync('scripts/publisher/template/.publisher/config.example.json', 'utf8'),
    );
    const config = {
      ...example,
      liveBranch,
      publishWritesEnabled,
      keyEndpoint: 'https://worker.invalid/publish/key',
      keyFingerprint: 'a'.repeat(64),
      publisherSha: pin.sourceSha,
      generatorSha: 'b'.repeat(40),
      facts: { 1: { name: 'Perk é🡅', type: 'Trait' } },
      runUrl: 'https://github.com/Database-Clarity/Live-Clarity-Database/actions',
    };
    const dir = mkdtempSync(join(tmpdir(), 'install-config-'));
    roots.push(dir);
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    const target = checkout(capabilities);
    if (previousBranch) {
      mkdirSync(join(target, '.publisher'), { recursive: true });
      writeFileSync(
        join(target, '.publisher/config.json'),
        JSON.stringify({ liveBranch: previousBranch }),
      );
      execFileSync('git', [...identity, '-C', target, 'add', '.publisher/config.json']);
      execFileSync('git', [...identity, '-C', target, 'commit', '-q', '-m', 'Previous target']);
    }
    const result = spawnSync(
      process.execPath,
      [
        resolve('scripts/publisher/install.mjs'),
        target,
        join(dir, 'config.json'),
        mode,
        ...(targetArg ? [targetArg] : []),
      ],
      { cwd, encoding: 'utf8', maxBuffer },
    );
    return { ...result, target, configPath: join(dir, 'config.json') };
  }

  it('installs publish writes from the enable build, byte-exact and LF', () => {
    const result = install('.', true, '--apply-local');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PUBLISH WRITES ENABLED');
    const installed = readFileSync(join(result.target, '.github/workflows/pipeline.yml'));
    expect(installed.includes('\r')).toBe(false);
    expect(installed.toString('utf8').replace(/\r\n/g, '\n')).toBe(
      readFileSync('scripts/publisher/template/.github/workflows/pipeline.yml', 'utf8').replace(
        /\r\n/g,
        '\n',
      ),
    );
    expect(
      JSON.parse(readFileSync(join(result.target, '.publisher/config.json'), 'utf8'))
        .publishWritesEnabled,
    ).toBe(true);
    const config = readFileSync(join(result.target, '.publisher/config.json'));
    const metadata = readFileSync(join(result.target, '.publisher/installed.json'));
    expect(metadata.includes('\r')).toBe(false);
    expect(metadata.byteLength).toBeLessThan(1024);
    expect(JSON.parse(metadata.toString('utf8'))).toEqual({
      version: 1,
      configOid: execFileSync('git', ['-C', result.target, 'hash-object', '--stdin'], {
        input: config,
        encoding: 'utf8',
      }).trim(),
      generatorSha: JSON.parse(config.toString('utf8')).generatorSha,
    });
  });

  it('keeps a dry-run install possible and refuses a non-boolean switch', () => {
    const dry = install('.', false);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stderr).toContain('Publish transport remains dry-run');
    expect(existsSync(join(dry.target, '.publisher/installed.json'))).toBe(false);
    const loose = install('.', 'true');
    expect(loose.status).not.toBe(0);
    expect(loose.stderr).toContain('publishWritesEnabled must be true or false');
  });
  it.each(['test', 'production'])(
    'prints the exact applicable %s installation diff without changing the checkout',
    (plan) => {
      const live = plan === 'test' ? 'converter-v2-test' : 'converter';
      const result = install('.', true, '--plan', undefined, `--target=${plan}`, live);
      expect(result.status, result.stderr).toBe(0);
      const patch = result.stdout.slice(result.stdout.indexOf('diff --git '));
      expect(patch).toContain('diff --git ');
      expect(
        execFileSync('git', ['-C', result.target, 'status', '--porcelain'], { encoding: 'utf8' }),
      ).toBe('');
      execFileSync(
        'git',
        ['-c', 'core.autocrlf=false', '-C', result.target, 'apply', '--check', '-'],
        { input: patch },
      );
      execFileSync('git', ['-c', 'core.autocrlf=false', '-C', result.target, 'apply', '-'], {
        input: patch,
      });
      const patched = readFileSync(join(result.target, '.publisher/config.json'));
      expect(JSON.parse(patched.toString()).liveBranch).toBe(live);
      const applied = install('.', true, '--apply-local', undefined, `--target=${plan}`, live);
      expect(applied.status, applied.stderr).toBe(0);
      const workflow = readFileSync(
        join(applied.target, '.github/workflows/publisher-run.yml'),
        'utf8',
      );
      const caller = readFileSync(join(applied.target, '.github/workflows/pipeline.yml'), 'utf8');
      const call =
        'uses: Database-Clarity/Live-Clarity-Database/.github/workflows/build-outputs.yml@converter';
      expect(caller).toContain('uses: ./.github/workflows/publisher-run.yml');
      if (plan === 'test') {
        expect(workflow).not.toContain(call);
        expect(caller).not.toContain('secrets: inherit');
      } else {
        expect(workflow).toContain(call);
        expect(workflow).toContain('\n  outputs:\n    needs: pipeline\n');
        expect(caller).toContain('secrets: inherit');
      }
      for (const file of [
        '.publisher/config.json',
        '.publisher/installed.json',
        '.publisher/PIN',
        '.publisher/publisher.mjs',
        '.github/workflows/pipeline.yml',
        '.github/workflows/publisher-run.yml',
      ])
        expect(readFileSync(join(result.target, file))).toEqual(
          readFileSync(join(applied.target, file)),
        );
      expect(existsSync(join(result.target, '.github/workflows/bundle.yml'))).toBe(false);
      const git = (...args: string[]) =>
        execFileSync('git', [...identity, '-C', result.target, ...args], {
          encoding: 'utf8',
        }).trim();
      const before = git('rev-parse', 'HEAD^{tree}');
      git('add', '--all');
      git('commit', '-q', '-m', 'Install publisher workflows');
      const verify = spawnSync(
        process.execPath,
        [
          resolve('scripts/publisher/install.mjs'),
          result.target,
          result.configPath,
          '--verify',
          `--target=${plan}`,
        ],
        { encoding: 'utf8' },
      );
      expect(verify.status, verify.stderr).toBe(0);
      git('revert', '--no-edit', 'HEAD');
      expect(git('rev-parse', 'HEAD^{tree}')).toBe(before);
    },
  );
  it.each([
    ['pipeline.yml', false],
    ['publisher-run.yml', false],
    ['publisher-run.yml', true],
  ] as const)('refuses a committed pair missing %s (inline caller=%s)', (file, inline) => {
    const result = install('.', true, '--apply-local');
    expect(result.status, result.stderr).toBe(0);
    rmSync(join(result.target, '.github/workflows', file));
    if (inline)
      writeFileSync(
        join(result.target, '.github/workflows/pipeline.yml'),
        'on: [workflow_dispatch]\njobs:\n  pipeline: { uses: ./.github/workflows/publisher-run.yml }\n',
      );
    const git = (...args: string[]) =>
      execFileSync('git', [...identity, '-C', result.target, ...args]);
    git('add', '--all');
    git('commit', '-q', '-m', 'Install only half of the workflow pair');
    for (const mode of ['--plan', '--apply-local', '--verify']) {
      const failed = spawnSync(
        process.execPath,
        [resolve('scripts/publisher/install.mjs'), result.target, result.configPath, mode],
        { encoding: 'utf8' },
      );
      expect(failed.status).not.toBe(0);
      expect(failed.stderr).toContain('Incomplete publisher workflow pair at HEAD');
    }
  });
  it('refuses unknown plans, config disagreements, and implicit target rollback', () => {
    for (const [flag, live] of [
      [undefined, 'converter'],
      ['--target=live', 'live'],
      ['--target=test', 'converter'],
      ['production', 'converter'],
    ]) {
      const result = install('.', false, '--plan', undefined, flag, live);
      expect(result.status).not.toBe(0);
    }
    const implicit = install(
      '.',
      false,
      '--plan',
      undefined,
      undefined,
      'converter-v2-test',
      'converter',
    );
    expect(implicit.status).not.toBe(0);
    expect(implicit.stderr).toContain('Target switch requires an explicit --target plan');
    const rollback = install(
      '.',
      false,
      '--plan',
      undefined,
      '--target=test',
      'converter-v2-test',
      'converter',
    );
    expect(rollback.status, rollback.stderr).toBe(0);
  });
  it('preserves installed capability floors and refuses downgrading an unknown capability', () => {
    const compatible = install('.', false, '--plan', ['schedulePreparationV1', 'globalsRelease']);
    expect(compatible.status, compatible.stderr).toBe(0);
    const downgrade = install('.', false, '--plan', ['futureCapability']);
    expect(downgrade.status).not.toBe(0);
    expect(downgrade.stderr).toContain('cannot drop installed capability floors');
  });
  it('produces identical committed-tree plans from LF and CRLF working checkouts', () => {
    const first = install('.', false, '--plan', ['globalsRelease']);
    expect(first.status, first.stderr).toBe(0);
    execFileSync('git', ['-C', first.target, 'config', 'core.autocrlf', 'true']);
    writeFileSync(join(first.target, '.git/info/attributes'), '* text eol=crlf\n');
    for (const file of ['README.md', '.github/workflows/bundle.yml'])
      rmSync(join(first.target, file));
    execFileSync('git', ['-C', first.target, 'checkout-index', '--all', '--force']);
    execFileSync('git', ['-C', first.target, 'add', '--renormalize', '.']);
    execFileSync('git', ['-C', first.target, 'diff', '--cached', '--exit-code']);
    expect(readFileSync(join(first.target, 'README.md'), 'utf8')).toContain('\r\n');
    const status = execFileSync('git', ['-C', first.target, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    expect(status).toBe('');
    const crlf = spawnSync(
      process.execPath,
      [resolve('scripts/publisher/install.mjs'), first.target, first.configPath, '--plan'],
      { encoding: 'utf8', maxBuffer },
    );
    expect(crlf.status, crlf.stderr).toBe(0);
    expect(crlf.stdout).toBe(first.stdout);
    expect(crlf.stdout.startsWith('diff --git ')).toBe(true);
  });
  it.each(['queue: single', 'cancel-in-progress: true', 'queue: [invalid'])(
    'refuses unsupported production workflow policy: %s',
    (replacement) => {
      const root = mkdtempSync(join(tmpdir(), 'install-policy-'));
      roots.push(root);
      cpSync('scripts/publisher/template', join(root, 'scripts/publisher/template'), {
        recursive: true,
      });
      const workflow = join(root, 'scripts/publisher/template/.github/workflows/build-outputs.yml');
      const original = readFileSync(workflow, 'utf8');
      writeFileSync(
        workflow,
        original.replace(
          replacement.startsWith('cancel') ? 'cancel-in-progress: false' : 'queue: max',
          replacement,
        ),
      );
      const result = install(root, false, '--plan', undefined, '--target=production', 'converter');
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('diff --git ');
    },
  );

  it('refuses publish writes for a build whose baked switch is OFF', () => {
    const root = mkdtempSync(join(tmpdir(), 'install-off-'));
    roots.push(root);
    const publisher = join(root, 'scripts/publisher');
    cpSync('scripts/publisher/template', join(publisher, 'template'), { recursive: true });
    for (const file of ['install.mjs', 'childProcess.mjs'])
      cpSync(`scripts/publisher/${file}`, join(publisher, file));
    const runtimePath = join(publisher, 'template/.publisher/publisher.mjs');
    const off = readFileSync(runtimePath, 'utf8').replace(
      /(\/\/ config\/publisher\.json\r?\nvar publisher_default = \{\r?\n {2}enabled: )true/,
      '$1false',
    );
    expect(off).toMatch(/var publisher_default = \{\r?\n {2}enabled: false/);
    writeFileSync(runtimePath, off);
    const pinPath = join(publisher, 'template/.publisher/PIN');
    const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
    pin.sha256 = createHash('sha256').update(off).digest('hex');
    writeFileSync(pinPath, JSON.stringify(pin));
    const refused = install(root, true);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('publishWritesEnabled needs a build');
    const dry = install(root, false);
    expect(dry.status, dry.stderr).toBe(0);
  });
});
