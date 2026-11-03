import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalRepository } from './git.js';
import { Publisher, type Options } from './publisher.js';

// P1-A has no remote write mode. Clone a local snapshot to a disposable simulator; emit artifacts only.
async function main() {
  const [flag, source, config, output] = process.argv.slice(2);
  if (flag !== '--dry-run' || !source || !config || !output)
    throw new Error(
      'Usage: publisher.mjs --dry-run <local repository> <config.json> <artifact directory>',
    );
  const local = realpathSync(resolve(source)),
    out = resolve(output);
  const temp = mkdtempSync(join(tmpdir(), 'publisher-dry-run-'));
  try {
    const repo = join(temp, 'simulator.git');
    execFileSync('git', ['clone', '--mirror', '--no-hardlinks', '--', local, repo], {
      stdio: 'pipe',
    });
    execFileSync('git', ['--git-dir', repo, 'remote', 'remove', 'origin']);
    execFileSync('git', ['--git-dir', repo, 'config', 'publisher.simulator', 'true']);
    const git = new LocalRepository(repo);
    const options = JSON.parse(readFileSync(config, 'utf8')) as Omit<Options, 'now' | 'backoff'>;
    const publisher = new Publisher(git, { ...options, now: Date.now });
    let failure: unknown;
    try {
      await publisher.run();
    } catch (e) {
      failure = e;
    }
    mkdirSync(out, { recursive: true });
    execFileSync('git', [
      '--git-dir',
      repo,
      'bundle',
      'create',
      join(out, 'would-be-commits.bundle'),
      '--all',
    ]);
    writeFileSync(
      join(out, 'result.json'),
      JSON.stringify(
        {
          dryRun: true,
          writesEnabled: false,
          dataHead: publisher.head(options.dataBranch),
          liveHead: publisher.head(options.liveBranch),
          error: failure ? String(failure) : null,
        },
        null,
        2,
      ) + '\n',
    );
    if (failure) throw failure;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(String(e));
  process.exitCode = 1;
});
