// Rehearse ONLY on a disposable local clone, never on the source data checkout.
// DATA PLAN_DIRECTORY NEW_CLONE RESULT_JSON
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { main, git, digest, snapshot } from './cli.mjs';

const [source, planDir, target, resultPath] = process.argv.slice(2);
if (!resultPath || existsSync(target))
  throw new Error('Expected DATA PLAN_DIRECTORY NEW_CLONE RESULT_JSON');
const bytes = readFileSync(join(planDir, 'plan.json'), 'utf8');
const plan = JSON.parse(bytes);
execFileSync(
  'git',
  [
    '-c',
    'core.autocrlf=false',
    'clone',
    '--no-hardlinks',
    '--single-branch',
    '--',
    resolve(source),
    resolve(target),
  ],
  { stdio: 'pipe' },
);
git(target, ['config', 'core.autocrlf', 'false']);
git(target, ['restore', '--source=HEAD', '--staged', '--worktree', '--', '.']);
// A real Git bundle is a durable backup, independent of retained archive blobs.
const backup = resolve(target, '..', `${target.split(/[\\/]/).at(-1)}-backup.bundle`);
git(target, ['bundle', 'create', backup, 'HEAD']);
git(target, ['bundle', 'verify', backup]);
const baseline = snapshot(target, plan.input.head);
await main(['apply', '--data', target, '--plan', planDir, '--sha', digest(bytes)]);
await main(['verify', '--data', target, '--plan', planDir, '--sha', digest(bytes)]);
git(target, ['apply', '--reverse', '--index', '--binary', '-'], { input: plan.patch });
if (
  git(target, ['status', '--porcelain', '--untracked-files=all']).trim() ||
  JSON.stringify(snapshot(target, plan.input.head)) !== JSON.stringify(baseline)
)
  throw new Error('Restore did not return the exact original snapshot');
writeFileSync(
  resultPath,
  JSON.stringify(
    {
      sourceHead: plan.input.head,
      planSha256: digest(bytes),
      backup,
      backupVerified: true,
      applyVerified: true,
      restoredClean: true,
      stagedFiles: plan.changes.length,
      sourceUntouched: git(source, ['status', '--porcelain']).trim() === '',
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log('Backup, exact staging, and byte restore passed on the rehearsal clone');
