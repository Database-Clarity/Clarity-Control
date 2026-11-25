// Offline process-CPU proxy for the real Worker route with an in-memory GitHub response.
// Bundle this file for Node and the Worker for a browser with esbuild, then run the
// Node bundle through suite-lock/bench_lock.py with the Worker bundle path as its argument.
// Each batch includes browser-sized HTTP requests,
// Worker auth, GitHub query construction, JSON parsing, digests, and signing.
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  globalsInPlaceCapability,
  globalsInPlacePath,
  translationBeforeDigest,
  translationEnglishDigest,
  translationExpectedDigest,
  translationPublishCapability,
  translationPublishContract,
  type TranslationPublishRow,
} from '@clarity/core';
import { translationPartRows } from '../src/translationPublish.js';
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
  TRANSLATION_PUBLISH: '1',
};
const timestamp = new Date().toISOString();
const oid = 'a'.repeat(40);
const selectionSize = translationPartRows * 10;
const entries = Array.from({ length: selectionSize }, (_, i) => {
  const hash = 1000000000 + i;
  const en = {
    text: `English tooltip ${hash}\n`.repeat(30),
    updatedAt: timestamp,
    updatedBy: 'cpu',
  };
  const de = {
    ...en,
    text: `Deutsche Beschreibung ${hash}\n`.repeat(30),
    sourceUpdatedAt: timestamp,
  };
  return {
    hash,
    saved: { hash, text: { en, de }, associated: [] },
    live: { hash, text: { en }, associated: [] },
  };
});
const rows: TranslationPublishRow[] = await Promise.all(
  entries.map(async ({ hash, saved, live }) => ({
    kind: 'tooltip',
    hash,
    lang: 'de',
    expected: await translationExpectedDigest(saved.text.de),
    english: await translationEnglishDigest(live.text.en),
    before: await translationBeforeDigest(undefined),
    effects: 'a'.repeat(64),
  })),
);
const stored = new Map<string, unknown>([
  [
    'config/permissions.json',
    {
      users: Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [
          i + 1,
          { login: `cpu${i + 1}`, role: 'translator', languages: ['de'] },
        ]),
      ),
    },
  ],
  ['.publisher/PIN', { capabilities: [globalsInPlaceCapability, translationPublishCapability] }],
  [
    globalsInPlacePath,
    { state: 'active', destination: 'live', legacyLive: oid, legacyData: oid, migratedLive: oid },
  ],
  [
    'live/translation-roots.json',
    {
      destination: 'live',
      liveCommit: oid,
      roots: Object.fromEntries(Array.from({ length: 2511 }, (_, i) => [1000000000 + i, oid])),
    },
  ],
]);
for (const { hash, saved, live } of entries) {
  stored.set(`tooltips/${hash}.json`, saved);
  stored.set(`live/tooltips/${hash}.json`, live);
}
const cached = new Map<string, string>();
let subrequests = 0;
let failRefUpdate = false;
globalThis.fetch = async (input, init) => {
  subrequests++;
  const url = new URL(String(input));
  if (url.origin !== 'https://api.github.com') throw new Error(`Unexpected host ${url.origin}`);
  if (url.pathname.endsWith('/access_tokens'))
    return Response.json({ token: 'cpu', expires_at: '2999-01-01T00:00:00Z' });
  if (url.pathname === '/graphql') {
    const { variables } = JSON.parse(String(init?.body));
    // The request and log paths vary by operation. Both are absent in this admission probe.
    const paths = Object.values(variables).filter(
      (path): path is string =>
        typeof path === 'string' &&
        (path.startsWith('tooltips/') || path.startsWith('live/tooltips/')),
    );
    const key = paths.join(',');
    let response = cached.get(key);
    if (!response) {
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
      response = JSON.stringify({ data: { repository: { ref: { target } } } });
      cached.set(key, response);
    }
    return new Response(response);
  }
  if (url.pathname.endsWith('/git/refs/heads/data') && failRefUpdate) {
    failRefUpdate = false;
    return Response.json({ message: 'DATA head changed' }, { status: 422 });
  }
  if (/\/git\/(trees|commits|refs\/heads\/data)$/.test(url.pathname))
    return Response.json({ sha: oid });
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
function newOpId() {
  return ulidPart(Date.now(), 10) + ulidPart(serial++, 16);
}
async function invoke(part: TranslationPublishRow[], retry = false, opId = newOpId()) {
  failRefUpdate = retry;
  const start = subrequests;
  const response: Response = await worker.fetch(
    new Request(`https://cpu.invalid/publish?contract=${translationPublishContract}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ opId, scope: 'translations', rows: part }),
    }),
    env,
    { waitUntil() {} },
  );
  if (response.status !== (retry ? 503 : 202)) throw new Error(await response.text());
  await response.text();
  return subrequests - start;
}

const coldStart = performance.now();
const coldSubrequests = await invoke(rows.slice(0, 1));
console.log({ coldWallMs: performance.now() - coldStart, coldSubrequests });
const parts = Array.from({ length: 10 }, (_, i) =>
  rows.slice(i * translationPartRows, (i + 1) * translationPartRows),
);
const retryId = newOpId();
await invoke(parts[0]!, true, retryId);
await invoke(parts[0]!, false, retryId);
for (const [label, requestParts, retry] of [
  ['one row', [rows.slice(0, 1)], false],
  [`${selectionSize} rows in automatic parts`, parts, false],
  [`${selectionSize} rows, failed CAS and reconciliation per request`, parts, true],
] as const) {
  for (const part of requestParts) await invoke(part, retry);
  const samples = [];
  let maxSubrequests = 0;
  for (let sample = 0; sample < 20; sample++) {
    const start = process.cpuUsage();
    for (let i = 0; i < 20; i++) {
      const count = await invoke(requestParts[i % requestParts.length]!, retry);
      maxSubrequests = Math.max(maxSubrequests, count);
    }
    const spent = process.cpuUsage(start);
    samples.push((spent.user + spent.system) / 1000 / 20);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[18]!;
  console.log({ label, p50Ms: samples[9], p95Ms: p95, maxSubrequests });
  if (p95 > 10 || maxSubrequests > 50) process.exitCode = 1;
}
