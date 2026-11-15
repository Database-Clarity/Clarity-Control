// CPU of GET and PUT /sandbox-pointers on real data sizes, in Node (a local proxy for the Workers
// FREE plan's 10 ms CPU limit; real Workers CPU is verified after deploy). Not part of the suite:
//   SANDBOX_DATA=<dir with aliases.json, sandboxConflicts.json, bundle.json> \
//   npx vitest run --config <a config including this file>
// The GitHub/generator mock pre-serializes every body and resolves at once, so a request's wall
// time is its CPU time; the mock's own time is measured and subtracted. performance.now(), not
// process.cpuUsage (Windows reports that in ~15.6 ms steps). Cold = the first request of each
// route in this process (includes JIT warm-up); warm = the next 10 of each kind.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import {
  resolveAlias,
  hasTooltipText,
  type Aliases,
  type SandboxConflicts,
  type Tooltip,
} from '@clarity/core';
import worker from '../src/index.js';
import { signToken } from '../src/crypto.js';
import { blobOid, makePrivateKey } from './fixture.js';

const dir = process.env.SANDBOX_DATA!;
const read = (name: string) => readFileSync(join(dir, name), 'utf8');

it('measures sandbox picks route CPU', { timeout: 600_000 }, async () => {
  const aliasesText = read('aliases.json');
  const conflictsText = read('sandboxConflicts.json');
  const aliases = JSON.parse(aliasesText) as Aliases;
  const conflicts = JSON.parse(conflictsText) as SandboxConflicts;
  const bundle = JSON.parse(read('bundle.json')) as {
    tooltips: Record<string, Tooltip>;
    permissions: unknown;
  };
  // Worst case: a pick for every shared perk that has a valid target (the bulk accept is ~150).
  const picks: Record<string, { to: number }> = {};
  for (const [hash, candidates] of Object.entries(conflicts)) {
    if (aliases[hash] || bundle.tooltips[hash]) continue;
    const to = candidates
      .map((candidate) => resolveAlias(candidate, aliases))
      .find(
        (target) =>
          !aliases[target] &&
          !conflicts[target] &&
          bundle.tooltips[target] &&
          hasTooltipText(bundle.tooltips[target]!),
      );
    if (to !== undefined) picks[hash] = { to };
  }
  const env = {
    SITE_ORIGIN: 'https://editor.example',
    SITE_URL: 'https://editor.example/app/',
    GITHUB_OWNER: 'o',
    GITHUB_REPO: 'r',
    DATA_BRANCH: 'editor-data',
    LIVE_BRANCH: 'live',
    GENERATOR_OWNER: 'g',
    GENERATOR_REPO: 'gen',
    GENERATOR_BRANCH: 'v2',
    GITHUB_APP_ID: '99',
    GITHUB_APP_SLUG: 'clarity-test',
    GITHUB_INSTALLATION_ID: '100',
    GITHUB_CLIENT_ID: 'c',
    GITHUB_CLIENT_SECRET: 's',
    GITHUB_PRIVATE_KEY: await makePrivateKey(),
    SESSION_SECRET: '0123456789abcdef0123456789abcdef',
    OAUTH_CALLBACK_URL: 'https://api.example/auth/callback',
  };
  const head = 'a'.repeat(40);
  // Every repository file the routes read, pre-serialized once.
  const files = new Map<string, string>();
  files.set('config/permissions.json', JSON.stringify(bundle.permissions));
  for (const [hash, tooltip] of Object.entries(bundle.tooltips))
    files.set(`tooltips/${hash}.json`, JSON.stringify(tooltip));
  let stored: string | undefined;
  const oids = new Map<string, string>();
  const oid = (text: string) => {
    let value = oids.get(text);
    if (!value) oids.set(text, (value = blobOid(JSON.parse(text))));
    return value;
  };
  for (const text of files.values()) oid(text);
  let mockCpu = 0;
  const json = (text: string, status = 200) => new Response(text, { status });
  const handle = (input: RequestInfo | URL, init?: RequestInit): Response => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    if (url.hostname === 'raw.githubusercontent.com') {
      if (url.pathname.endsWith('/aliases.json')) return json(aliasesText);
      if (url.pathname.endsWith('/sandboxConflicts.json')) return json(conflictsText);
    }
    if (url.pathname === '/app/installations/100/access_tokens')
      return json('{"token":"installation-token"}');
    if (url.pathname.startsWith('/repos/o/r/git/ref/heads/'))
      return json(`{"object":{"sha":"${head}"}}`);
    if (url.pathname === '/graphql') {
      const body = JSON.parse(String(init!.body)) as { variables: Record<string, string> };
      const parts: string[] = [];
      for (const [name, expression] of Object.entries(body.variables)) {
        if (!/^e\d+$/.test(name)) continue;
        const path = expression.slice(expression.indexOf(':') + 1);
        const text = path === 'config/sandbox-pointers.json' ? stored : files.get(path);
        parts.push(
          `"o${name.slice(1)}":${
            text === undefined
              ? 'null'
              : `{"oid":"${oid(text)}","isTruncated":false,"text":${JSON.stringify(text)}}`
          }`,
        );
      }
      return json(`{"data":{"repository":{${parts.join(',')}}}}`);
    }
    if (url.pathname.startsWith('/repos/o/r/contents/')) {
      const text = files.get(decodeURIComponent(url.pathname.slice('/repos/o/r/contents/'.length)));
      if (text === undefined) return json('{"message":"Not Found"}', 404);
      return json(
        `{"sha":"${oid(text)}","encoding":"base64","content":"${Buffer.from(text).toString('base64')}"}`,
      );
    }
    if (url.pathname.startsWith('/repos/o/r/git/commits/') && method === 'GET')
      return json(`{"tree":{"sha":"${head}"}}`);
    if (url.pathname === '/repos/o/r/git/trees') {
      const body = JSON.parse(String(init!.body)) as { tree: { content: string }[] };
      stored = body.tree[0]!.content;
      return json(`{"sha":"${'b'.repeat(40)}"}`);
    }
    if (url.pathname === '/repos/o/r/git/commits') return json(`{"sha":"${'c'.repeat(40)}"}`);
    if (url.pathname.startsWith('/repos/o/r/git/refs/heads/'))
      return json(`{"object":{"sha":"${'c'.repeat(40)}"}}`);
    throw new Error(`Unexpected ${method} ${url.href}`);
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const before = performance.now();
    const response = handle(input, init);
    mockCpu += performance.now() - before;
    return response;
  }) as typeof fetch;
  (globalThis as { caches?: unknown }).caches = {
    open: async () => ({ match: async () => undefined, put: async () => undefined }),
  };
  const token = await signToken(
    { id: 1, login: 'alice', purpose: 'session', exp: Math.floor(Date.now() / 1000) + 3600 },
    env.SESSION_SECRET,
  );
  // The bundle's permissions name the real maintainers; make the measured id one of them.
  const permissions = bundle.permissions as { users: Record<string, { role: string }> };
  const maintainer = Object.entries(permissions.users).find(
    ([, user]) => user.role === 'maintainer',
  );
  permissions.users['1'] = { ...maintainer![1], role: 'maintainer' };
  files.set('config/permissions.json', JSON.stringify(permissions));
  const call = async (method: string, body?: unknown, path = '/sandbox-pointers') => {
    mockCpu = 0;
    const before = performance.now();
    const response = await worker.fetch(
      new Request(`https://api.example${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Origin: env.SITE_ORIGIN },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
      { waitUntil() {} },
    );
    const text = await response.text();
    const used = performance.now() - before;
    if (response.status !== 200) throw new Error(`${method} ${response.status}: ${text}`);
    return Math.round((used - mockCpu) * 100) / 100;
  };
  const results: Record<string, unknown> = { picks: Object.keys(picks).length };
  results.getCold = await call('GET');
  const revision = () =>
    stored === undefined ? null : oid(stored.trimEnd().replace(/\r\n/g, '\n'));
  results.putCold = await call('PUT', { revision: null, picks });
  // Baseline: an existing maintainer route (head + permissions read + schema), unchanged here.
  results.permissionsCold = await call('GET', undefined, '/permissions');
  const warm = {
    get: [] as number[],
    put: [] as number[],
    putAll: [] as number[],
    permissions: [] as number[],
  };
  for (let i = 0; i < 10; i++) {
    warm.permissions.push(await call('GET', undefined, '/permissions'));
    warm.get.push(await call('GET'));
    // One changed pick (a row-by-row save).
    const next = { ...picks };
    if (i % 2 === 0) delete next[Object.keys(next)[0]!];
    warm.put.push(await call('PUT', { revision: revision(), picks: next }));
  }
  for (let i = 0; i < 10; i++) {
    // Every pick new (the worst bulk save: all targets validated), then cleared again.
    await call('PUT', { revision: revision(), picks: {} });
    warm.putAll.push(await call('PUT', { revision: revision(), picks }));
  }
  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) };
  };
  results.getWarm = stats(warm.get);
  results.putWarm = stats(warm.put);
  results.putAllWarm = stats(warm.putAll);
  results.permissionsWarm = stats(warm.permissions);
  console.log(`SANDBOX_CPU ${JSON.stringify(results)}`);
  if (process.env.SANDBOX_CPU_OUT)
    (await import('node:fs')).writeFileSync(process.env.SANDBOX_CPU_OUT, JSON.stringify(results));
});
