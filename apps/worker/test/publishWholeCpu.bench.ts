// Offline process-CPU proxy for whole-selection admission (POST /publish, selection 'whole') on
// the real Worker bundle with in-memory GitHub responses, as translationPublishCpu.bench.ts.
// Bundle this file for Node and apps/worker/src/index.ts for a browser with esbuild, then run the
// Node bundle through suite-lock/bench_lock.py with the Worker bundle path as its argument.
// Each request includes auth, the GraphQL snapshot, JSON parsing, the intent digest, signing,
// and the commit body; sizes 1, 148, 500, and the whole-request maximum of 1,000 rows, plus the
// failed-CAS retry path (re-read, re-sign, second write) at each size.
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { wholeSelectionCapability } from '@clarity/core';
import type { Env } from '../src/types.ts';

const bundle = process.argv[2];
if (!bundle) throw new Error('Pass the compiled Worker bundle path');
const { default: worker } = await import(pathToFileURL(resolve(bundle)).href);
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const ed25519 = generateKeyPairSync('ed25519').privateKey;
const env: Partial<Env> = {
  GITHUB_OWNER: 'cpu',
  GITHUB_REPO: 'fixture',
  DATA_BRANCH: 'data',
  LIVE_BRANCH: 'live',
  GITHUB_APP_ID: '1',
  GITHUB_INSTALLATION_ID: '1',
  GITHUB_PRIVATE_KEY: rsa.export({ type: 'pkcs8', format: 'pem' }).toString(),
  PUBLISH_SIGNING_KEY: ed25519.export({ type: 'pkcs8', format: 'pem' }).toString(),
  SESSION_SECRET: 'local-cpu-proxy-session-key-fixture',
};
const oid = 'a'.repeat(40);
// Real-sized permissions (200 accounts) and a full 50-entry account index.
const stored = new Map<string, unknown>([
  [
    'config/permissions.json',
    {
      users: Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [i + 1, { login: `cpu${i + 1}`, role: 'editor' }]),
      ),
    },
  ],
  ['.publisher/PIN', { capabilities: [wholeSelectionCapability] }],
  [
    'publish/accounts/1.json',
    {
      entries: Array.from({ length: 50 }, (_, i) => ({
        opId: `01MBY${String(i).padStart(21, '0')}`,
        createdAt: '2026-11-26T12:00:00.000Z',
        rows: 148,
        globals: 0,
        status: 'done',
        held: 0,
        updatedAt: '2026-11-26T12:00:00.000Z',
      })),
    },
  ],
]);
let subrequests = 0;
let failRefUpdate = false;
let committed = 0;
globalThis.fetch = async (input, init) => {
  subrequests++;
  const url = new URL(String(input));
  if (url.origin !== 'https://api.github.com') throw new Error(`Unexpected host ${url.origin}`);
  if (url.pathname.endsWith('/access_tokens'))
    return Response.json({ token: 'cpu', expires_at: '2999-01-01T00:00:00Z' });
  if (url.pathname === '/graphql') {
    const { variables } = JSON.parse(String(init?.body));
    const target: Record<string, unknown> = { oid, tree: { oid } };
    for (const [name, path] of Object.entries(variables)) {
      if (/^t\d+$/.test(name)) target[name] = null;
      if (!/^p\d+$/.test(name)) continue;
      const value = stored.get(String(path));
      target[`o${name.slice(1)}`] =
        value === undefined
          ? null
          : { object: { oid, text: JSON.stringify(value), isTruncated: false } };
    }
    return Response.json({ data: { repository: { ref: { target } } } });
  }
  if (url.pathname.endsWith('/git/refs/heads/data')) {
    if (failRefUpdate) {
      failRefUpdate = false;
      return Response.json({ message: 'DATA head changed' }, { status: 422 });
    }
    committed++;
    return Response.json({ sha: oid });
  }
  if (/\/git\/(trees|commits)$/.test(url.pathname)) return Response.json({ sha: oid });
  throw new Error(`Unexpected CPU upstream path ${url.pathname}`);
};

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulidPart = (value: number, length: number) => {
  let encoded = '';
  for (let i = 0; i < length; i++) {
    encoded = alphabet[value % 32] + encoded;
    value = Math.floor(value / 32);
  }
  return encoded;
};
const encoded = Buffer.from(
  JSON.stringify({
    id: 1,
    login: 'cpu1',
    purpose: 'session',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
).toString('base64url');
const session = `${encoded}.${createHmac('sha256', env.SESSION_SECRET!).update(encoded).digest('base64url')}`;
let serial = 0;
const newOpId = () => ulidPart(Date.now(), 10) + ulidPart(serial++, 16);
const body = (rows: number, opId: string) => {
  const hashes = Array.from({ length: rows }, (_, i) => 1_000_000_000 + i * 7919);
  return JSON.stringify({
    opId,
    hashes,
    expected: Object.fromEntries(hashes.map((hash, i) => [hash, (i % 16).toString(16).repeat(64)])),
    selection: 'whole',
  });
};
async function invoke(rows: number, retry = false) {
  failRefUpdate = retry;
  const start = subrequests;
  const response: Response = await worker.fetch(
    new Request('https://cpu.invalid/publish', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
      body: body(rows, newOpId()),
    }),
    env,
    { waitUntil() {} },
  );
  if (response.status !== 202) throw new Error(`${response.status} ${await response.text()}`);
  await response.text();
  return subrequests - start;
}

const coldStart = performance.now();
console.log({ coldWallMs: performance.now() - coldStart, coldSubrequests: await invoke(1) });
for (const rows of (process.env.ROWS ?? '1,148,500,1000').split(',').map(Number))
  for (const retry of [false, true]) {
    for (let i = 0; i < 5; i++) await invoke(rows, retry);
    const samples: number[] = [];
    let maxSubrequests = 0;
    for (let sample = 0; sample < 20; sample++) {
      const start = process.cpuUsage();
      for (let i = 0; i < 20; i++)
        maxSubrequests = Math.max(maxSubrequests, await invoke(rows, retry));
      const spent = process.cpuUsage(start);
      samples.push((spent.user + spent.system) / 1000 / 20);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[18]!;
    console.log({
      label: `${rows} rows${retry ? ', failed CAS then retry' : ''}`,
      bodyBytes: body(rows, newOpId()).length,
      p50Ms: samples[9],
      p95Ms: p95,
      maxSubrequests,
    });
    if (p95 > 10 || maxSubrequests > 50) process.exitCode = 1;
  }
console.log({ committed });
