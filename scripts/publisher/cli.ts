import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maxBuffer } from './childProcess.mjs';
import { LocalRepository } from './git.js';
import { Publisher, type Options } from './publisher.js';
import { runPipeline, verifyRuntime } from './pipeline.js';
import {
  dryRunGlobalsMigration,
  restoreGlobalsMigration,
  type MigrationInputs,
} from './globalsMigration.js';

// Publication requires the explicit pipeline-publish flag plus both configuration gates.
async function main() {
  const [flag, source, config, output, migrationInput] = process.argv.slice(2);
  if (['--pipeline-dry-run', '--pipeline-publish'].includes(flag) && source && config && output) {
    const pin = verifyRuntime(dirname(fileURLToPath(import.meta.url)));
    const bytes = readFileSync(config);
    const options = JSON.parse(bytes.toString('utf8'));
    if (options.publisherSha !== pin.sourceSha || !/^[0-9a-f]{40}$/.test(options.generatorSha))
      throw new Error('Config requires the publisher source PIN and full generator commit');
    await runPipeline(
      source,
      {
        ...options,
        publisherDigest: pin.sha256,
        verifierDigest: pin.verifierSha256,
        publisherConfigDigest:
          flag === '--pipeline-publish'
            ? createHash('sha256').update(bytes).digest('hex')
            : undefined,
      },
      output,
      flag === '--pipeline-publish',
    );
    return;
  }
  if (
    !['--dry-run', '--globals-migration-dry-run'].includes(flag) ||
    !source ||
    !config ||
    !output ||
    (flag === '--globals-migration-dry-run' && !migrationInput)
  )
    throw new Error(
      'Usage: publisher.mjs --dry-run <local repository> <config.json> <artifact directory>, or --globals-migration-dry-run with an additional migration-inputs.json',
    );
  const local = realpathSync(resolve(source)),
    out = resolve(output);
  const temp = mkdtempSync(join(tmpdir(), 'publisher-dry-run-'));
  try {
    const repo = join(temp, 'simulator.git');
    execFileSync('git', ['clone', '--mirror', '--no-hardlinks', '--', local, repo], {
      stdio: 'pipe',
      maxBuffer,
    });
    execFileSync('git', ['--git-dir', repo, 'remote', 'remove', 'origin'], { maxBuffer });
    execFileSync('git', ['--git-dir', repo, 'config', 'publisher.simulator', 'true'], {
      maxBuffer,
    });
    const git = new LocalRepository(repo);
    const options = JSON.parse(readFileSync(config, 'utf8')) as Omit<Options, 'now' | 'backoff'>;
    const pin = verifyRuntime(dirname(fileURLToPath(import.meta.url)));
    const publisher = new Publisher(git, {
      ...options,
      publisherDigest: pin.sha256,
      verifierDigest: pin.verifierSha256,
      now: Date.now,
    });
    let failure: unknown;
    let migration: Awaited<ReturnType<typeof dryRunGlobalsMigration>> | undefined;
    let restored: boolean | undefined;
    try {
      if (flag === '--globals-migration-dry-run') {
        const originalData = publisher.head(options.dataBranch);
        const originalLive = publisher.head(options.liveBranch);
        const inputs = JSON.parse(readFileSync(migrationInput!, 'utf8')) as MigrationInputs;
        migration = await dryRunGlobalsMigration(publisher, inputs);
        restoreGlobalsMigration(publisher);
        restored =
          publisher.head(options.dataBranch) === originalData &&
          publisher.head(options.liveBranch) === originalLive;
        if (!restored) throw new Error('Migration restore did not recover the original refs.');
        migration = await dryRunGlobalsMigration(publisher, inputs);
        publisher.bundle();
      } else await publisher.run();
    } catch (e) {
      failure = e;
    }
    mkdirSync(out, { recursive: true });
    execFileSync(
      'git',
      ['--git-dir', repo, 'bundle', 'create', join(out, 'would-be-commits.bundle'), '--all'],
      { maxBuffer },
    );
    writeFileSync(
      join(out, 'result.json'),
      JSON.stringify(
        {
          dryRun: true,
          writesEnabled: false,
          dataHead: publisher.head(options.dataBranch),
          liveHead: publisher.head(options.liveBranch),
          ...(migration ? { migration, restored } : {}),
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
