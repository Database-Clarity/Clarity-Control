import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { generateKeyPairSync, randomBytes, createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { maxBuffer } from '../childProcess.mjs';
const [mode, countArg] = process.argv.slice(2);
const count = Number(countArg);
if (
  !['publish', 'pending', 'terminal', 'kick'].includes(mode) ||
  ![1, 50, 100, 2511].includes(count)
)
  throw new Error(
    'Usage: node scripts/publisher/cpu/prepare.mjs publish|pending|terminal|kick 1|50|100|2511',
  );
const out = process.env.CPU_OUT ?? 'scripts/publisher/cpu/dist';
mkdirSync(out, { recursive: true });
const pem = (type) =>
  generateKeyPairSync(type, type === 'rsa' ? { modulusLength: 2048 } : {})
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
const secret = randomBytes(32).toString('hex');
// Unique per prepared bundle; echoed by entry.mjs so a stale deployment is detectable.
const buildStamp = randomBytes(8).toString('hex');
const hashes = Array.from({ length: count }, (_, i) => 1000000000 + i);
const expected = Object.fromEntries(hashes.map((h) => [h, 'a'.repeat(64)]));
const envelope = {
  payload: JSON.stringify({
    hashes,
    expected,
    opId: '01K95H00000000000000000001',
    kind: 'push',
    repo: 'cpu/fixture',
    dataBranch: 'cpu-data',
    liveBranch: 'cpu-live',
    requester: { id: 1, login: 'cpu' },
    createdAt: new Date().toISOString(),
    intentDigest: 'a'.repeat(64),
  }),
  sig: 'a'.repeat(88),
};
const log = {
  request: envelope,
  intentDigest: 'a'.repeat(64),
  result: {
    status: 'done',
    outcomes: hashes.map((hash) => ({ hash, status: 'published', digest: 'a'.repeat(64) })),
  },
};
writeFileSync(`${out}/fixture.json`, JSON.stringify({ mode, envelope, log }));
await build({
  entryPoints: ['scripts/publisher/cpu/entry.mjs'],
  outfile: `${out}/worker.mjs`,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  inject: ['scripts/publisher/cpu/upstream.mjs'],
  plugins: [
    {
      name: 'enable-preview-only',
      setup(b) {
        b.onResolve({ filter: /^\.\/dist\/fixture\.json$/ }, () => ({
          path: resolve(out, 'fixture.json'),
        }));
        if (process.env.CPU_BASELINE === '1')
          b.onLoad({ filter: /(?:crypto|publish|publishRequest)\.ts$/ }, (args) => ({
            contents: execFileSync(
              'git',
              ['show', `30c0a5a:${relative(process.cwd(), args.path).replaceAll('\\', '/')}`],
              { encoding: 'utf8', maxBuffer },
            ),
            loader: 'ts',
          }));
        b.onLoad({ filter: /config[\\/]publisher.json$/ }, () => ({
          contents: '{"enabled":true}',
          loader: 'json',
        }));
      },
    },
  ],
});
writeFileSync(
  `${out}/wrangler.json`,
  JSON.stringify(
    {
      name: 'clarity-publisher-cpu-preview',
      main: 'worker.mjs',
      compatibility_date: '2025-11-01',
      workers_dev: false,
      preview_urls: true,
      observability: { enabled: true, head_sampling_rate: 1 },
      vars: {
        SITE_ORIGIN: 'https://cpu.invalid',
        GITHUB_OWNER: 'cpu',
        GITHUB_REPO: 'fixture',
        DATA_BRANCH: 'cpu-data',
        LIVE_BRANCH: 'cpu-live',
        GITHUB_APP_ID: '1',
        GITHUB_INSTALLATION_ID: '1',
        GITHUB_PRIVATE_KEY: pem('rsa'),
        PUBLISH_SIGNING_KEY: pem('ed25519'),
        SESSION_SECRET: secret,
        CPU_BUILD: buildStamp,
      },
    },
    null,
    2,
  ),
);
const value = Buffer.from(
  JSON.stringify({
    id: 1,
    login: 'cpu',
    purpose: 'session',
    exp: Math.floor(Date.now() / 1000) + 86400,
  }),
).toString('base64url');
const token = `${value}.${createHmac('sha256', secret).update(value).digest('base64url')}`;
writeFileSync(
  `${out}/client.json`,
  JSON.stringify({ mode, count, hashes, expected, token, build: buildStamp }),
);
console.log('Prepared synthetic preview only; no upload performed.');
