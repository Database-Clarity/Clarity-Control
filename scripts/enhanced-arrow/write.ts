// ENHANCED-ARROW data write command line (the gated write of plan.ts). Run with tsx from the
// repository root, on a clone of the editor-data branch checked out with core.autocrlf=false
// (working bytes = blobs):
//
//   plan    --data <clone> --head <sha> --out <dir>
//   backup  --data <clone> --plan <dir>/plan.json --out <dir>
//   write   --data <clone> --head <sha> --plan <dir>/plan.json --plan-sha <sha256> --backup <dir>
//   check   --data <clone> --plan <dir>/plan.json         (working tree = plan after-images)
//   restore --data <clone> --plan <dir>/plan.json --backup <dir>
//
// Same transaction as scripts/mult-write/cli.ts: every command except `check` and `restore`
// refuses unless the clone is clean, on `--head`, and the remote editor-data branch is still
// `--head`; `write` re-checks the remote after writing. `write` re-plans from the clone and refuses
// unless the result is byte-identical to the approved plan (its sha256), then writes only the
// planned files; on any failure it restores the backup and requires a clean tree. The plan holds
// no commit id, so the same tooltips give the same plan bytes on any head. Outputs are created
// exclusively, never replaced. Nothing here commits or pushes.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { sha256 } from '../mult-write/rewrite.js';
import { planBytes, planWrite, summary, type Plan } from './plan.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: 'string' },
    head: { type: 'string' },
    out: { type: 'string' },
    plan: { type: 'string' },
    'plan-sha': { type: 'string' },
    backup: { type: 'string' },
    remote: { type: 'string', default: 'origin' },
    branch: { type: 'string', default: 'editor-data' },
  },
});
const command = positionals[0];
const need = (name: keyof typeof values) => {
  const value = values[name];
  if (typeof value !== 'string' || !value) throw new Error(`Missing --${name}`);
  return value;
};
const data = resolve(need('data'));
const git = (...args: string[]) =>
  execFileSync('git', ['-C', data, ...args], { encoding: 'utf8' }).trim();
const say = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const readData = (path: string) => {
  const file = join(data, path);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
};
/** Every changed or untracked path (NUL-separated porcelain, so no trimming or quoting). */
const status = () =>
  execFileSync('git', ['-C', data, 'status', '--porcelain', '-z', '--untracked-files=all'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      if (!/^.. /.test(entry)) throw new Error(`Unexpected status entry: ${entry}`);
      return entry.slice(3);
    })
    .sort();
/** Tracked tooltip files (`tooltips/<hash>.json`). */
const tooltipPaths = () =>
  execFileSync('git', ['-C', data, 'ls-files', '-z', '--', 'tooltips'], { encoding: 'utf8' })
    .split('\0')
    .filter((path) => /^tooltips\/[^/]+\.json$/.test(path))
    .sort();
const remoteHead = () =>
  git('ls-remote', values.remote!, `refs/heads/${values.branch}`).split(/\s+/)[0] ?? '';

function frozen(head: string, clean = true): void {
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('--head must be a full sha');
  if (git('config', '--get', 'core.autocrlf') !== 'false')
    throw new Error('core.autocrlf must be false');
  if (git('rev-parse', 'HEAD') !== head) throw new Error('Clone HEAD is not --head');
  if (git('rev-parse', '--abbrev-ref', 'HEAD') !== values.branch) throw new Error('Wrong branch');
  if (clean && status().length) throw new Error(`Clone is not clean: ${status().join(', ')}`);
  const remote = remoteHead();
  if (remote !== head)
    throw new Error(`Remote ${values.branch} moved: ${remote} (expected ${head})`);
  say(`frozen: HEAD = remote ${values.branch} = ${head}`);
}

const loadPlan = () => {
  const bytes = readFileSync(need('plan'), 'utf8');
  return { bytes, plan: JSON.parse(bytes) as Plan };
};
const exclusive = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { flag: 'wx' });
};

function restore(plan: Plan, backup: string): void {
  for (const change of plan.changes) {
    const bytes = readFileSync(join(backup, change.path), 'utf8');
    if (sha256(bytes) !== change.beforeSha256) throw new Error(`Backup differs: ${change.path}`);
    writeFileSync(join(data, change.path), bytes);
  }
  if (status().length) throw new Error(`Restore left changes: ${status().join(', ')}`);
  say(`restored ${plan.changes.length} files; clone clean`);
}

if (command === 'plan') {
  const head = need('head');
  frozen(head);
  const plan = planWrite(tooltipPaths(), readData);
  const out = resolve(need('out'));
  const bytes = planBytes(plan);
  exclusive(join(out, 'plan.json'), bytes);
  const report = {
    head,
    planSha256: sha256(bytes),
    ...summary(plan),
    issues: plan.changes
      .filter((change) => change.issuesRemoved.length || change.issuesAdded.length)
      .map(({ hash, issuesRemoved, issuesAdded }) => ({ hash, issuesRemoved, issuesAdded })),
  };
  exclusive(join(out, 'plan-report.json'), `${JSON.stringify(report, null, 1)}\n`);
  frozen(head);
  console.log(JSON.stringify({ ...report, issues: report.issues.length }, null, 1));
} else if (command === 'backup') {
  const { plan } = loadPlan();
  const out = resolve(need('out'));
  const head = git('rev-parse', 'HEAD');
  const sums: string[] = [];
  for (const change of plan.changes) {
    const blob = execFileSync('git', ['-C', data, 'show', `${head}:${change.path}`], {
      encoding: 'utf8',
    });
    const bytes = readData(change.path);
    if (bytes !== change.before || blob !== change.before)
      throw new Error(`Not the planned before: ${change.path}`);
    exclusive(join(out, change.path), bytes);
    sums.push(`${change.beforeSha256}  ${change.path}`);
  }
  exclusive(join(out, 'HEAD'), `${head}\n`);
  exclusive(join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  say(`backup: ${plan.changes.length} files equal HEAD ${head} blobs`);
} else if (command === 'write') {
  const head = need('head');
  const { bytes, plan } = loadPlan();
  if (sha256(bytes) !== need('plan-sha')) throw new Error('Plan is not the approved plan');
  const backup = resolve(need('backup'));
  if (readFileSync(join(backup, 'HEAD'), 'utf8').trim() !== head)
    throw new Error('Backup HEAD differs');
  for (const change of plan.changes) {
    if (sha256(readFileSync(join(backup, change.path), 'utf8')) !== change.beforeSha256)
      throw new Error(`Backup differs: ${change.path}`);
  }
  frozen(head);
  if (planBytes(planWrite(tooltipPaths(), readData)) !== bytes)
    throw new Error('Re-plan differs from the approved plan');
  try {
    for (const change of plan.changes) writeFileSync(join(data, change.path), change.after);
    const wanted = plan.changes.map((change) => change.path).sort();
    if (!isDeepStrictEqual(status(), wanted))
      throw new Error(`Unexpected status: ${status().join(', ')}`);
    for (const change of plan.changes) {
      if (readData(change.path) !== change.after) throw new Error(`Write mismatch: ${change.path}`);
    }
    frozen(head, false);
    say(`wrote ${plan.changes.length} files; status = plan`);
  } catch (error) {
    say(`write failed, restoring: ${String(error)}`);
    restore(plan, backup);
    throw error;
  }
} else if (command === 'check') {
  const { plan } = loadPlan();
  const wanted = plan.changes.map((change) => change.path).sort();
  if (!isDeepStrictEqual(status(), wanted))
    throw new Error(`Unexpected status: ${status().join(', ')}`);
  for (const change of plan.changes) {
    if (readData(change.path) !== change.after)
      throw new Error(`Not the after-image: ${change.path}`);
  }
  say(
    `check: ${wanted.length}/${wanted.length} files equal their after-images; no other path changed`,
  );
} else if (command === 'restore') {
  restore(loadPlan().plan, resolve(need('backup')));
} else {
  throw new Error('Command: plan | backup | write | check | restore');
}
