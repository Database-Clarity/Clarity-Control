// Opt-in real-data smoke: node scripts/dev-roles/sandbox-smoke.mjs <fresh scratch directory>
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { prepareSandbox } from './sandbox.mjs';
import { SandboxGit } from './sandbox-git.mjs';

const root = resolve(process.argv[2] ?? 'scripts/dev-roles/dist');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, 'sandbox-smoke-'));
const siteOrigin = 'http://127.0.0.1:4177';
const editor = { id: 900001, login: 'dev-smoke-editor' };
const translator = { id: 900002, login: 'dev-smoke-translator' };
const started = Date.now();
console.log('Preparing the disposable repositories and global proofs');
const sandbox = await prepareSandbox({
  directory,
  siteOrigin,
  seedPermissions(config) {
    assert.equal(config.users[editor.id], undefined);
    assert.equal(config.users[translator.id], undefined);
    return {
      ...config,
      users: {
        ...config.users,
        [editor.id]: { login: editor.login, role: 'editor' },
        [translator.id]: { login: translator.login, role: 'translator', languages: ['de'] },
      },
    };
  },
});
console.log('Public revisions', sandbox.revisions);
console.log('Sandbox ready after', Math.round((Date.now() - started) / 1000), 'seconds');
const runtime = join(directory, 'smoke-worker.mjs');
await build({
  absWorkingDir: resolve(import.meta.dirname, '../..'),
  stdin: {
    contents: `
      export { default as worker } from './apps/worker/src/index.ts';
      export { signToken } from './apps/worker/src/crypto.ts';
      export { consumerAliasScope } from './apps/worker/src/sandboxPointers.ts';
      export { GitHub } from './apps/worker/src/github.ts';
      export { inactivePublishableHash, publishMonth } from '@clarity/core';
      export { newOpId } from './apps/web/src/services/publisher/ulid.ts';
    `,
    resolveDir: resolve(import.meta.dirname, '../..'),
  },
  outfile: runtime,
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const {
  worker,
  GitHub,
  consumerAliasScope,
  signToken,
  inactivePublishableHash,
  publishMonth,
  newOpId,
} = await import(pathToFileURL(runtime).href);
const env = {
  ...sandbox.bindings,
  SITE_ORIGIN: siteOrigin,
  SITE_URL: siteOrigin,
  SESSION_SECRET: randomBytes(32).toString('hex'),
};
globalThis.fetch = (input, init) => sandbox.fetch(new Request(input, init));
async function invoke(path, value, user = editor) {
  const session = await signToken(
    { ...user, exp: Math.floor(Date.now() / 1000) + 600, purpose: 'session' },
    env.SESSION_SECRET,
  );
  const response = await worker.fetch(
    new Request(siteOrigin + path, {
      headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
      ...(value ? { method: 'POST', body: JSON.stringify(value) } : {}),
    }),
    env,
    { waitUntil() {} },
  );
  return { status: response.status, data: await response.json() };
}

const git = new SandboxGit(sandbox.dataGitDir);
assert.equal(git.text(['remote']).trim(), '');
const { DATA_BRANCH: dataBranch, LIVE_BRANCH: liveBranch } = env;
const raw = `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
const github = new GitHub(env);
const before = git.resolve(dataBranch);
const liveBefore = git.resolve(liveBranch);
const bundleBefore = git.resolve('editor-data-bundle');
const hash = 935202422;
const path = `tooltips/${hash}.json`;
const { value: base } = await github.requiredFile(path, before);
assert.equal(base.text.de, undefined);
const next = structuredClone(base);
const savedAt = new Date().toISOString();
const illegal = structuredClone(base);
illegal.text.en = {
  text: 'English edit by translator',
  updatedAt: savedAt,
  updatedBy: translator.login,
};
const refused = await invoke(
  '/save',
  {
    changes: [{ hash, base, next: illegal }],
    message: 'Refuse a translator English edit',
  },
  translator,
);
assert.equal(refused.status, 403, JSON.stringify(refused.data));
assert.equal(git.resolve(dataBranch), before);
next.text.de = {
  text: 'Offene Visierung. Ermöglicht peripheres Sehen beim Zielen.',
  updatedAt: savedAt,
  updatedBy: translator.login,
  sourceUpdatedAt: base.text.en.updatedAt,
};
const saved = await invoke(
  '/save',
  {
    changes: [{ hash, base, next }],
    message: 'Disposable role smoke',
  },
  translator,
);
assert.equal(saved.status, 200, JSON.stringify(saved.data));
const commit = saved.data.commit;
const readBack = await sandbox.fetch(new Request(`${raw}/${commit}/${path}`));
assert.equal(readBack.status, 200);
const tooltip = await readBack.json();
assert.deepEqual(tooltip.text.de, next.text.de);
assert.deepEqual(tooltip.text.en, base.text.en);
console.log('Saved the first German translation and refused an English edit', hash, commit);

const [groups, pointers, moves] = await github.files(
  ['config/alias-groups.json', 'config/sandbox-pointers.json', 'config/inactive.json'],
  commit,
);
const scope = await consumerAliasScope(github, groups, pointers, [hash]);
const expected = {
  [hash]: await inactivePublishableHash(tooltip, scope.aliases, moves?.value ?? {}),
};
const bundleURL = `${raw}/editor-data-bundle/bundle.json`;
const proofPath = `globals/proofs/publication/${liveBranch}/${hash}-de.json`;
const synced = (head) => {
  const [proof] = git.treeEntries(head, false, proofPath);
  return proof?.type === 'blob';
};
const syncStarted = Date.now();
const deadline = syncStarted + 600_000;
let bundleHead = before;
while (!synced(bundleHead) && Date.now() < deadline) {
  await delay(2000);
  if (git.resolve('editor-data-bundle') === bundleBefore) continue;
  const bundle = await sandbox.fetch(new Request(bundleURL));
  assert.equal(bundle.status, 200);
  bundleHead = (await bundle.json()).sourceCommit;
}
assert.ok(synced(bundleHead), 'Bundled head has no German publication proof');
console.log(
  'German publication proof bundled after',
  Math.round((Date.now() - syncStarted) / 1000),
  'seconds',
);
const opId = newOpId();
const requested = await invoke('/publish', { opId, hashes: [hash], expected });
assert.equal(requested.status, 202, JSON.stringify(requested.data));
console.log('Queued publish', opId);
let status;
const applyStarted = Date.now();
const applyDeadline = applyStarted + 900_000;
do {
  status = await invoke(`/publish/status?opId=${opId}`);
  assert.equal(status.status, 200, JSON.stringify(status.data));
  if (status.data.operations[0].status !== 'pending') break;
  await delay(2000);
} while (Date.now() < applyDeadline);
const liveAfter = git.resolve(liveBranch);
const log = `publish/log/${publishMonth(opId)}/${opId}.json`;
const record = await sandbox.fetch(new Request(`${raw}/${dataBranch}/${log}`));
assert.equal(record.status, 200);
const receipt = await record.json();
assert.equal(status.data.operations[0].status, 'done', JSON.stringify(receipt));
assert.notEqual(liveAfter, liveBefore);
assert.equal(receipt.candidateCommit, liveAfter);
const applied = await sandbox.fetch(
  new Request(`${raw}/${liveAfter}/.publish/receipts/${publishMonth(opId)}/${opId}.json`),
);
assert.equal(applied.status, 200);
assert.equal((await applied.json()).opId, opId);
const target = await sandbox.fetch(new Request(`${raw}/${liveAfter}/liveDescriptions.json`));
assert.equal(target.status, 200);
assert.equal((await target.json()).perks[hash].editor.de.main, next.text.de.text);
console.log(
  'Publisher applied the local receipt and German live output',
  opId,
  liveAfter,
  `after ${Math.round((Date.now() - applyStarted) / 1000)} seconds`,
);
