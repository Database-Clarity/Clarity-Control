import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..', '..');
const output = mkdtempSync(join(tmpdir(), 'publisher-startup-'));
const wrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const bundles = {
  harness: join(output, 'harness', 'worker.js'),
  worker: join(output, 'worker', 'index.js'),
};
const subprocess = {
  cwd: root,
  encoding: 'utf8' as const,
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  timeout: 60_000,
};

// A separate VM imports the actual bundle without Vitest's own timers or crypto.
const startupImport = String.raw`
  import assert from 'node:assert/strict';
  import { readFileSync } from 'node:fs';
  import { createContext, runInContext, SourceTextModule } from 'node:vm';
  const calls = [];
  const forbidden = (name) => () => {
    calls.push(name);
    throw new Error('Forbidden during Worker startup: ' + name);
  };
  const context = createContext({
    TextEncoder, TextDecoder, URL, URLSearchParams, Request, Response, Headers,
    atob, btoa, console,
    fetch: forbidden('fetch'),
    setTimeout: forbidden('setTimeout'),
    setInterval: forbidden('setInterval'),
    crypto: {
      randomUUID: forbidden('crypto.randomUUID'),
      getRandomValues: forbidden('crypto.getRandomValues'),
      subtle: new Proxy({}, { get: (_, name) => forbidden('crypto.subtle.' + String(name)) }),
    },
  });
  context.forbiddenRandom = forbidden('Math.random');
  runInContext('Math.random = forbiddenRandom; delete globalThis.forbiddenRandom;', context);
  const module = new SourceTextModule(readFileSync(0, 'utf8'), { context });
  await module.link((specifier) => { throw new Error('Unbundled import: ' + specifier); });
  await module.evaluate({ timeout: 10_000 });
  assert.deepEqual(calls, [], 'Startup effects must fail even if the bundle catches errors');
  assert.equal(typeof module.namespace.default.fetch, 'function');
`;

function importAtStartup(source: string) {
  return execFileSync(
    process.execPath,
    ['--experimental-vm-modules', '--input-type=module', '--eval', startupImport],
    { ...subprocess, input: source, stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

beforeAll(() => {
  execFileSync(
    process.execPath,
    ['scripts/publisher/cpu/prepare.mjs', 'publish', '2511'],
    subprocess,
  );
  for (const [name, config] of [
    ['harness', 'scripts/publisher/cpu/dist/wrangler.json'],
    ['worker', 'apps/worker/wrangler.jsonc'],
  ]) {
    execFileSync(
      process.execPath,
      [wrangler, 'deploy', '--dry-run', '--config', config, '--outdir', join(output, name)],
      subprocess,
    );
  }
}, 120_000);

afterAll(() => {
  rmSync(output, { recursive: true, force: true });
});

it.each(['harness', 'worker'] as const)(
  '%s bundle imports without running handlers or startup-restricted APIs',
  (name) => {
    expect(() => importAtStartup(readFileSync(bundles[name], 'utf8'))).not.toThrow();
  },
);

it.each([
  'crypto.randomUUID()',
  'crypto.getRandomValues(new Uint8Array(1))',
  "crypto.subtle.digest('SHA-256', new Uint8Array())",
  'Math.random()',
  "fetch('https://example.invalid')",
  'setTimeout(() => {}, 0)',
  'setInterval(() => {}, 0)',
])('startup shim rejects %s', (operation) => {
  expect(() => importAtStartup(`${operation}; export default { fetch() {} };`)).toThrow(
    'Forbidden during Worker startup',
  );
});

it('startup shim rejects swallowed startup effects', () => {
  expect(() =>
    importAtStartup('try { crypto.randomUUID(); } catch {} export default { fetch() {} };'),
  ).toThrow('Startup effects must fail');
});

it('harness initializes one UUID on first request and retains isolate invocation metadata', () => {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      String.raw`
        import assert from 'node:assert/strict';
        import { pathToFileURL } from 'node:url';
        const samples = [];
        const crypto = globalThis.crypto;
        let uuids = 0;
        Object.defineProperty(globalThis, 'crypto', {
          value: { randomUUID() { uuids++; return crypto.randomUUID(); } },
          configurable: true,
        });
        globalThis.fetch = () => { throw new Error('Unexpected network I/O'); };
        console.log = (line) => samples.push(JSON.parse(line));
        const url = pathToFileURL(process.argv[1]);
        const { default: worker } = await import(url);
        assert.equal(uuids, 0);
        for (const sample of ['cold', 'warm']) {
          const response = await worker.fetch(new Request('https://cpu.invalid', {
            method: 'OPTIONS', headers: { 'X-CPU-Sample': sample },
          }), {}, {});
          assert.equal(response.status, 204);
        }
        assert.equal(uuids, 1);
        assert.match(samples[0].isolate, /^[0-9a-f-]{36}$/);
        assert.equal(samples[0].isolate, samples[1].isolate);
        assert.deepEqual(samples.map(({ cpuSample, invocation, status }) =>
          ({ cpuSample, invocation, status })), [
          { cpuSample: 'cold', invocation: 1, status: 204 },
          { cpuSample: 'warm', invocation: 2, status: 204 },
        ]);
        const { default: fresh } = await import(url.href + '?fresh');
        assert.equal(uuids, 1);
        await fresh.fetch(new Request('https://cpu.invalid', { method: 'OPTIONS' }), {}, {});
        assert.equal(uuids, 2);
        assert.notEqual(samples[2].isolate, samples[0].isolate);
        assert.equal(samples[2].invocation, 1);
      `,
      bundles.harness,
    ],
    subprocess,
  );
});
