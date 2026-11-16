// Offline workerd CPU proxy for the /globals routes (Globals S5 whole-route gate).
// node apps/worker/test/globalsCpu.bench.ts prepare   (through heavy.py)
// node apps/worker/test/globalsCpu.bench.ts smoke|measure   (decisive runs through bench_lock)
// The real Worker bundle runs in Miniflare with an in-memory upstream that answers every
// GitHub call from a cache after warm-up, so process CPU is the Worker's own (authentication,
// observation, raw transport, schemas, handler) plus runtime/harness work. The 'off' case (503
// before authentication) is the harness floor. Not hosted invocation CPU.
import { execFileSync } from 'node:child_process';
import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const out = resolve('.agents/s5/cpu');
const mode = process.argv[2];
export const cases = ['off', 'me', 'list', 'entry', 'reviews', 'history', 'edit'];

const upstream = `
const cache = new Map();
const sha1 = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const pretty = (value) => JSON.stringify(value, null, 2) + '\\n';
async function raw(path, value) {
  const text = pretty(value);
  const bytes = new TextEncoder().encode(text);
  return { oid: await sha1('blob ' + bytes.byteLength + '\\0' + text), byteSize: bytes.byteLength, isBinary: false, isTruncated: false, text };
}
async function graphql(body) {
  const { files } = globalThis.__globalsCpu;
  const { query, variables } = JSON.parse(body);
  if (query.startsWith('query GlobalsObserve(')) {
    const target = { oid: 'a'.repeat(40) };
    for (const [name, path] of Object.entries(variables)) {
      if (!/^[tbx]\\d+$/.test(name)) continue;
      const value = files.get(path);
      if (name.startsWith('x')) target[name] = value === undefined ? null : { object: await raw(path, value) };
      else if (value !== undefined) target[name] = { type: 'blob', oid: (await raw(path, value)).oid };
      else {
        const inside = [...files.keys()].some((key) => key.startsWith(path + '/'));
        target[name] = inside ? { type: 'tree', oid: await sha1('tree:' + path) } : null;
      }
    }
    return { data: { repository: { ref: { target }, live: { target: { oid: 'b'.repeat(40) } } } } };
  }
  if (query.includes('object(oid:$oid)')) {
    for (const [path, value] of files) {
      const blob = await raw(path, value);
      if (blob.oid === variables.oid) return { data: { repository: { object: blob } } };
    }
    return { data: { repository: { object: null } } };
  }
  const repository = {};
  for (const [name, expression] of Object.entries(variables)) {
    if (!/^e\\d+$/.test(name)) continue;
    const path = expression.slice(expression.indexOf(':') + 1);
    const value = files.get(path);
    repository['o' + name.slice(1)] = value === undefined ? null : await raw(path, value);
  }
  return { data: { repository } };
}
export async function fetch(input, init) {
  globalThis.__globalsCount++;
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const respond = async (key, make, status = 200) => {
    let body = cache.get(key);
    if (body === undefined) cache.set(key, (body = JSON.stringify(await make())));
    return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
  };
  if (url.origin !== 'https://api.github.com') throw new Error('CPU fixture blocked ' + url.href);
  if (url.pathname.endsWith('/access_tokens') && method === 'POST')
    return respond('token', () => ({ token: 'synthetic', expires_at: '2999-01-01T00:00:00Z' }));
  if (url.pathname === '/graphql' && method === 'POST') return respond(init.body, () => graphql(init.body));
  if (url.pathname.includes('/git/ref/heads/') && method === 'GET')
    return respond('head', () => ({ object: { sha: 'a'.repeat(40) } }));
  if (url.pathname.includes('/contents/') && method === 'GET') {
    const path = decodeURIComponent(url.pathname.split('/contents/')[1]);
    const value = globalThis.__globalsCpu.files.get(path);
    if (value === undefined) return new Response('', { status: 404 });
    return respond('contents:' + path, () => ({ sha: 'a'.repeat(40), encoding: 'base64', content: btoa(pretty(value)) }));
  }
  if (url.pathname.endsWith('/commits') && method === 'GET')
    return respond('commits', () => globalThis.__globalsCpu.commits);
  if (url.pathname.endsWith('/git/trees') && method === 'POST') return respond('sha', () => ({ sha: 'c'.repeat(40) }));
  if (url.pathname.endsWith('/git/commits') && method === 'POST') return respond('sha', () => ({ sha: 'c'.repeat(40) }));
  if (url.pathname.includes('/git/commits/') && method === 'GET') return respond('tree', () => ({ tree: { sha: 'c'.repeat(40) } }));
  if (url.pathname.includes('/git/refs/heads/') && method === 'PATCH') return respond('ref', () => ({ object: { sha: 'c'.repeat(40) } }));
  throw new Error('CPU fixture blocked ' + method + ' ' + url.pathname);
}`;

const entry = `
import worker from '../../../apps/worker/src/index.ts';
import { GitHub } from '../../../apps/worker/src/github.ts';
import { globalsSwitch, observeGlobals } from '../../../apps/worker/src/globalsRoute.ts';
import { namePaths } from '../../../apps/worker/src/globals/index.ts';
import data from './data.json';
let ready;
async function setup(env) {
  globalThis.__globalsCpu = { files: new Map(data.files), commits: data.commits };
  globalThis.__globalsCount = 0;
  const { sources } = await observeGlobals(new GitHub(env));
  const proof = { version: 1, complete: true, sources };
  const files = globalThis.__globalsCpu.files;
  const locations = await namePaths('variables', 'Damage');
  files.set(locations.proof, { ...proof, kind: 'variables', name: 'Damage', occupiedBy: data.id, localClash: false, coverage: 'authored-live-upcoming-fallback' });
  files.set(locations.claim, { id: data.id, kind: 'variables', name: 'Damage' });
  files.set('globals/review-pages/' + data.id + '/p0.json', { ...proof, ids: data.rows.map((row) => row.id), nextCursor: null });
  for (const row of data.rows) files.set('globals/reviews/' + row.id + '.json', { ...proof, ...row });
}
export default { async fetch(request, env) {
  const name = new URL(request.url).pathname.slice(1);
  ready ??= setup(env);
  await ready;
  globalsSwitch.enabled = () => name !== 'off';
  const spec = data.specs[name];
  globalThis.__globalsCount = 0;
  const response = await worker.fetch(new Request('https://cpu.invalid' + spec.path, {
    method: spec.method,
    headers: { Authorization: 'Bearer ' + data.token, 'Content-Type': 'application/json' },
    ...(spec.body ? { body: JSON.stringify(spec.body) } : {}),
  }), env, { waitUntil() {} });
  const text = await response.text();
  if (response.status !== spec.status) throw new Error(name + ': ' + response.status + ' ' + text);
  return Response.json({ status: response.status, subrequests: globalThis.__globalsCount, bytes: text.length });
}};`;

function fixtures() {
  const id = 'g_cpufixture01';
  const stamp = '2026-11-01T00:00:00Z';
  // Near-cap but valid sizes: 8 KB bodies, 31 pending causes, 60 users, three 10 KB rows.
  const body = 'Damage +5 against Champions. '.repeat(270).slice(0, 7900);
  const definition = (lang: string) => ({
    body,
    revision: `r-${lang}`,
    updatedAt: stamp,
    updatedBy: 'cpu',
  });
  const entry = (n: number) => ({
    version: 1,
    id: n ? `g_cpufixture0${n + 1}` : id,
    kind: 'variables',
    name: n ? `Damage${n}` : 'Damage',
    revision: 'r1',
    nameHistory: [],
    definitions: { en: definition('en') },
  });
  const causeIds = Array.from({ length: 31 }, (_, i) => `cause-${String(i).padStart(2, '0')}`);
  const users = Object.fromEntries(
    Array.from({ length: 60 }, (_, i) => [
      String(i + 1),
      { login: i ? `user${i}` : 'cpu', role: i ? 'translator' : 'maintainer', languages: ['de'] },
    ]),
  );
  users['1'] = { login: 'cpu', role: 'maintainer' } as never;
  const consumer = { hash: 1000, lang: 'en', destination: 'cpu-live' };
  const causes = [{ globalId: id, beforeRevision: 'r0', afterRevision: 'r1' }];
  const markup = JSON.stringify(
    Array.from({ length: 30 }, () => [{ text: 'Damage +5 against Champions. ' }]),
  ).slice(0, 2800);
  const rows = Array.from({ length: 3 }, (_, i) => ({
    id: `review${i}`,
    projected: false,
    impactDigest: 'a'.repeat(64),
    review: {
      version: 1,
      consumer: { ...consumer, hash: 1000 + i },
      causes,
      contentDigest: 'b'.repeat(64),
      dependencyDigest: 'c'.repeat(64),
    },
    view: {
      consumer: { ...consumer, hash: 1000 + i },
      causes,
      reason: 'variable-read',
      before: null,
      after: null,
      variant: 1000 + i,
      name: `Consumer ${i}`,
      category: 'Weapon Perk',
      line: null,
      path: null,
      direct: null,
      archived: false,
      beforeSource: markup,
      afterSource: markup,
    },
  }));
  const files: [string, unknown][] = [
    ['config/permissions.json', { users }],
    ['config/scheduled.json', { enabled: true }],
    ['tooltips/1000.json', { hash: 1000, text: {}, associated: [] }],
    ['.publisher/PIN', { sourceSha: 'e'.repeat(40), capabilities: ['globalsRelease'] }],
    ['.publisher/config.json', { generatorSha: 'd'.repeat(40), facts: {}, aliases: {} }],
    ['globals/layout.json', { version: 1, aggregates: [] }],
    ['globals/live/cpu-live.json', { version: 1, destination: 'cpu-live', store: {} }],
    [
      'globals/sync.json',
      {
        version: 1,
        status: 'sync-pending',
        causeIds,
        causeEntries: Object.fromEntries(causeIds.map((cause) => [cause, id])),
        lastFailure: null,
      },
    ],
    ['globals/catalog.json', { version: 1, lastPage: 0 }],
    [
      'globals/pages/p0.json',
      { version: 1, ids: [0, 1, 2].map((n) => entry(n).id), nextCursor: null },
    ],
    ...[0, 1, 2].map((n): [string, unknown] => [`globals/entries/${entry(n).id}.json`, entry(n)]),
  ];
  const commits = Array.from({ length: 30 }, (_, i) => ({
    sha: (i + 1).toString(16).padStart(40, '0'),
    commit: { author: { name: 'cpu', date: stamp }, message: `Save global entry ${i}` },
    author: { login: 'cpu' },
  }));
  const head = 'a'.repeat(40);
  const specs = {
    off: { path: '/globals', method: 'GET', status: 503 },
    me: { path: '/me', method: 'GET', status: 200 },
    list: { path: '/globals', method: 'GET', status: 200 },
    entry: { path: `/globals/${id}`, method: 'GET', status: 200 },
    reviews: { path: `/globals/${id}/reviews`, method: 'GET', status: 200 },
    history: { path: `/globals/${id}/history`, method: 'GET', status: 200 },
    edit: {
      path: `/globals/${id}/body`,
      method: 'POST',
      status: 200,
      body: {
        expectedHead: head,
        mutation: { operation: 'edit', id, revision: 'r1', lang: 'en', body: `${body}!` },
      },
    },
  };
  return { id, files, commits, rows, specs };
}

async function prepare() {
  mkdirSync(out, { recursive: true });
  const secret = randomBytes(32).toString('hex');
  const value = Buffer.from(
    JSON.stringify({ id: 1, login: 'cpu', purpose: 'session', exp: 4102444800 }),
  ).toString('base64url');
  const token = `${value}.${createHmac('sha256', secret).update(value).digest('base64url')}`;
  writeFileSync(`${out}/data.json`, JSON.stringify({ ...fixtures(), token }));
  writeFileSync(`${out}/upstream.mjs`, upstream);
  writeFileSync(`${out}/entry.mjs`, entry);
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  writeFileSync(
    `${out}/env.json`,
    JSON.stringify({
      SITE_ORIGIN: 'https://cpu.invalid',
      GITHUB_OWNER: 'cpu',
      GITHUB_REPO: 'fixture',
      DATA_BRANCH: 'cpu-data',
      LIVE_BRANCH: 'cpu-live',
      GENERATOR_OWNER: 'cpu',
      GENERATOR_REPO: 'generator',
      GENERATOR_BRANCH: 'v2',
      GITHUB_APP_ID: '1',
      GITHUB_APP_SLUG: 'cpu',
      GITHUB_INSTALLATION_ID: '1',
      GITHUB_PRIVATE_KEY: pem,
      SESSION_SECRET: secret,
    }),
  );
  await build({
    entryPoints: [`${out}/entry.mjs`],
    outfile: `${out}/worker.mjs`,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    inject: [`${out}/upstream.mjs`],
    logLevel: 'error',
  });
  console.log(`Prepared ${out}/worker.mjs`);
}

async function measure() {
  const { readFileSync } = await import('node:fs');
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: `${out}/worker.mjs`,
      compatibilityDate: '2025-11-01',
      bindings: JSON.parse(readFileSync(`${out}/env.json`, 'utf8')),
      port: 0,
    }),
  );
  const ps = (cmd: string) =>
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  const rows = [];
  try {
    await mf.ready;
    const ids = ps(
      `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${process.pid}" | Where-Object Name -eq 'workerd.exe' | Select-Object -ExpandProperty ProcessId`,
    )
      .split(/\s+/)
      .filter(Boolean);
    if (ids.length !== 1) throw Error('Expected one workerd child, got ' + ids);
    const cpu = () =>
      Number(ps(`(Get-Process -Id ${ids[0]}).TotalProcessorTime.TotalMilliseconds`));
    for (const name of cases) {
      let subrequests = 0;
      let bytes = 0;
      const invoke = async () => {
        const r = await mf.dispatchFetch('http://localhost/' + name);
        const text = await r.text();
        if (r.status !== 200) throw Error(text);
        ({ subrequests, bytes } = JSON.parse(text));
        if (subrequests > 48) throw Error('Subrequest cap exceeded');
      };
      await invoke();
      if (mode !== 'smoke') for (let i = 0; i < 20; i++) await invoke();
      const n = mode === 'smoke' ? 1 : 300;
      const start = cpu();
      for (let i = 0; i < n; i++) await invoke();
      const row = {
        name,
        n,
        subrequests,
        responseBytes: bytes,
        meanWorkerdCpuMs: (cpu() - start) / n,
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
    if (mode !== 'smoke') {
      const floor = rows[0]!.meanWorkerdCpuMs;
      const net = rows.map((row) => ({
        name: row.name,
        netMs: +(row.meanWorkerdCpuMs - floor).toFixed(3),
      }));
      console.log('NET over off-floor', JSON.stringify(net));
      writeFileSync(`${out}/results.json`, JSON.stringify({ rows, net }, null, 2));
    }
  } finally {
    await mf.dispose();
  }
}

if (mode === 'prepare') await prepare();
else if (mode === 'smoke' || mode === 'measure') await measure();
else throw Error('Expected prepare, smoke, or measure');
