// Offline adoption: node scripts/alias-groups/cli.mjs plan|apply|verify
// plan --data CLONE --input selections.json --out NEW_DIRECTORY
// apply|verify --data CLONE --plan DIRECTORY --sha SHA256_OF_plan.json
// Input: {head, at, actor:{id,login}, facts:{items,aliases,sandboxConflicts,categories},
//         groups:[{canonical,members,acknowledgeConflicts?:true}]}
// Facts and approval are embedded in the sealed plan; apply reruns S2 and compares
// the exact binary diff. It stages only, never commits or pushes. Backup is the
// immutable HEAD plus the reverse-applicable binary patch; no archive is discarded.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
export const git = (data, args, options = {}) =>
  execFileSync('git', ['-C', data, ...args], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    ...options,
  });
export function frozen(data, head, clean = true) {
  if (!/^[0-9a-f]{40}$/.test(head) || git(data, ['rev-parse', 'HEAD']).trim() !== head)
    throw new Error('Stale data HEAD');
  if (git(data, ['config', '--get', 'core.autocrlf']).trim() !== 'false')
    throw new Error('Set core.autocrlf=false on the private clone');
  if (clean && git(data, ['status', '--porcelain', '--untracked-files=all']).trim())
    throw new Error('Data clone must be clean');
}
export function snapshot(data, head) {
  const paths = git(data, ['ls-tree', '-rz', '--name-only', head]).split('\0').filter(Boolean);
  // Only the JSON documents needed by S2. The installed runtime is verified separately.
  const selected = paths.filter((p) =>
    /^(tooltips\/\d+\.json|config\/.*\.json|\.publisher\/PIN|migration-archives\/alias-groups\/.*\.json)$/.test(
      p,
    ),
  );
  const batch = git(data, ['cat-file', '--batch'], {
    encoding: null,
    input: selected.map((p) => `${head}:${p}\n`).join(''),
  });
  let offset = 0;
  return Object.fromEntries(
    selected.map((p) => {
      const end = batch.indexOf(10, offset);
      const header = batch.subarray(offset, end).toString('ascii');
      if (!/^[0-9a-f]{40} blob \d+$/.test(header)) throw new Error(`Bad snapshot blob ${p}`);
      const size = Number(header.split(' ')[2]);
      offset = end + 1;
      const blob = batch.subarray(offset, offset + size);
      const raw = blob.toString('utf8');
      if (!Buffer.from(raw, 'utf8').equals(blob))
        throw new Error(`Refusing non-UTF-8 snapshot blob ${p}`);
      offset += size + 1;
      return [p, raw];
    }),
  );
}
let adapter;
export async function validator() {
  if (adapter) return adapter;
  const target = resolve(`node_modules/.cache/groups-adopt/adapter-${process.pid}.mjs`);
  await build({
    entryPoints: [resolve(import.meta.dirname, 'adapter.ts')],
    outfile: target,
    bundle: true,
    platform: 'node',
    format: 'esm',
  });
  adapter = await import(pathToFileURL(target));
  return adapter;
}
export async function makePlan(data, input, out) {
  frozen(data, input.head);
  if (!/^[0-9a-f]{40}$/.test(input.generatorHead))
    throw new Error('Explicit pinned generatorHead required');
  if (
    !input.groups?.length ||
    input.groups.some(
      (g) =>
        !Object.hasOwn(g, 'canonical') ||
        Object.keys(g).some((k) => !['canonical', 'members', 'acknowledgeConflicts'].includes(k)),
    )
  )
    throw new Error('Every group requires an explicit canonical');
  if (!Number.isFinite(Date.parse(input.at))) throw new Error('Explicit audit timestamp required');
  const before = snapshot(data, input.head);
  for (const [path, raw] of Object.entries(before)) {
    if (!readFileSync(join(data, path)).equals(Buffer.from(raw, 'utf8')))
      throw new Error(`Working bytes differ from the pinned Git blob: ${path}`);
  }
  const account = JSON.parse(before['config/permissions.json']).users[String(input.actor?.id)];
  if (account?.role !== 'maintainer' || account.login !== input.actor?.login)
    throw new Error('Planned actor must match a pinned maintainer');
  const { files: after, responses } = await (
    await validator()
  ).validate(before, input.head, input.facts, input.groups, input.actor, input.at);
  const changes = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((p) => before[p] !== after[p])
    .map((path) => ({ path, before: before[path] ?? null, after: after[path] ?? null }));
  mkdirSync(out, { recursive: true });
  const index = join(resolve(out), 'temporary-index');
  if (existsSync(index)) throw new Error('Temporary index already exists');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  let patch;
  try {
    git(data, ['read-tree', input.head], { env });
    for (const change of changes) {
      if (change.after === null)
        git(data, ['update-index', '--force-remove', '--', change.path], { env });
      else {
        const sha = git(data, ['hash-object', '-w', '--stdin'], { input: change.after }).trim();
        git(data, ['update-index', '--add', '--cacheinfo', '100644', sha, change.path], { env });
      }
    }
    patch = git(
      data,
      [
        'diff',
        '--cached',
        '--binary',
        '--full-index',
        '--no-ext-diff',
        '--no-textconv',
        input.head,
      ],
      { env },
    );
  } finally {
    if (existsSync(index)) unlinkSync(index);
  }
  frozen(data, input.head);
  return {
    version: 1,
    input,
    changes,
    responses,
    patch,
    manifest: changes.map((c) => ({
      path: c.path,
      before: c.before === null ? null : digest(c.before),
      after: c.after === null ? null : digest(c.after),
    })),
  };
}

export async function main(args = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      data: { type: 'string' },
      input: { type: 'string' },
      out: { type: 'string' },
      plan: { type: 'string' },
      sha: { type: 'string' },
    },
  });
  const command = positionals[0];
  if (!values.data) throw new Error('Missing --data');
  const data = resolve(values.data);
  if (command === 'plan') {
    if (!values.out || !values.input || existsSync(resolve(values.out)))
      throw new Error('plan requires --input and a new --out directory');
    const plan = await makePlan(data, JSON.parse(readFileSync(values.input, 'utf8')), values.out);
    const bytes = json(plan);
    writeFileSync(join(values.out, 'plan.json'), bytes, { flag: 'wx' });
    writeFileSync(join(values.out, 'staged.diff'), plan.patch, { flag: 'wx' });
    writeFileSync(
      join(values.out, 'manifest.json'),
      json({ planSha256: digest(bytes), head: plan.input.head, changes: plan.manifest }),
      { flag: 'wx' },
    );
    console.log(digest(bytes));
    return;
  }
  if (!values.plan || !values.sha) throw new Error('Missing --plan or --sha');
  const bytes = readFileSync(join(values.plan, 'plan.json'), 'utf8');
  if (digest(bytes) !== values.sha) throw new Error('Plan digest mismatch');
  const plan = JSON.parse(bytes);
  if (!['apply', 'verify'].includes(command)) throw new Error('Use plan, apply, or verify');
  frozen(data, plan.input.head, command === 'apply');
  if (command === 'apply') {
    const regenerated = await makePlan(data, plan.input, values.plan);
    if (json(regenerated) !== bytes) throw new Error('Plan no longer reproduces exactly');
    // git apply checks every preimage and stages under Git's index lock.
    git(data, ['apply', '--check', '--index', '--binary', '-'], { input: plan.patch });
    git(data, ['apply', '--index', '--binary', '-'], { input: plan.patch });
    try {
      frozen(data, plan.input.head, false);
    } catch (error) {
      // A race after staging never leaves our changes accepted. Git checks the
      // exact postimages before reversing, preserving unrelated concurrent work.
      git(data, ['apply', '--reverse', '--index', '--binary', '-'], { input: plan.patch });
      throw error;
    }
  }
  frozen(data, plan.input.head, false);
  if (
    git(data, [
      'diff',
      '--binary',
      '--full-index',
      '--cached',
      '--no-ext-diff',
      '--no-textconv',
      plan.input.head,
    ]) !== plan.patch ||
    git(data, ['diff', '--name-only']).trim() ||
    git(data, ['ls-files', '--others', '--exclude-standard']).trim()
  )
    throw new Error('Staged or working bytes differ from the approved plan');
  console.log(`${command}: exact staged diff verified; no commit or push`);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename))
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
