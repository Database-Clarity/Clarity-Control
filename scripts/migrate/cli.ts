import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { aliasesSchema } from '@clarity/core';
import { z } from 'zod';
import { planMigration, prepareMigration, readJson, readMigration } from './migrate.js';
import { deletedHashes, excludedDeletions } from './deletions.js';
import { foldFrames } from './foldFrames.js';
import { planFold } from './foldWrite.js';
import { commitFiles, dataDiff } from './transaction.js';

const repository = 'https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database';

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
  });
  if (!response.ok) throw new Error(`GET ${url}: ${response.status} ${response.statusText}`);
  return response.json();
}

async function main() {
  const { values } = parseArgs({
    options: {
      output: { type: 'string' },
      intermediate: { type: 'string' },
      live: { type: 'string' },
      owner: { type: 'string' },
      deletions: { type: 'string' },
      reimport: { type: 'string', multiple: true },
      aliases: { type: 'string' },
      items: { type: 'string' },
      conflicts: { type: 'string' },
      diff: { type: 'string' },
      approve: { type: 'string' },
      write: { type: 'boolean', default: false },
      'allow-authored-overwrite': { type: 'boolean', default: false },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'npm run migrate -- --output <checkout> [--intermediate <file> --live <file> --owner <file>] [--deletions <json> --reimport <hash>] [--aliases <json> --items <json> --conflicts <file-in-checkout>] [--diff <new-json>] [--write --approve <reviewed-diff.json> | --write --allow-authored-overwrite]',
    );
    return;
  }
  if (!values.output) throw new Error('--output is required; use an isolated editor-data checkout');
  if (Boolean(values.intermediate) !== Boolean(values.live)) {
    throw new Error('--intermediate and --live must be provided together');
  }
  if (
    [values.aliases, values.items, values.conflicts].some(Boolean) &&
    ![values.aliases, values.items, values.conflicts].every(Boolean)
  ) {
    throw new Error('--aliases, --items and --conflicts must be supplied together');
  }
  const [intermediate, live, owner, existing] = await Promise.all([
    values.intermediate
      ? readJson(values.intermediate)
      : fetchJson(`${repository}/intermediate/intermediateDescriptions.json`),
    values.live
      ? readJson(values.live)
      : fetchJson(`${repository}/converter/liveDescriptions.json`),
    values.owner ? readJson(values.owner) : fetchJson('https://api.github.com/users/StardustD2'),
    readMigration(values.output),
  ]);
  if (
    typeof owner !== 'object' ||
    owner === null ||
    !('id' in owner) ||
    !Number.isSafeInteger(owner.id) ||
    typeof owner.id !== 'number' ||
    owner.id <= 0 ||
    !('login' in owner) ||
    owner.login !== 'StardustD2'
  ) {
    throw new Error('GitHub returned an invalid StardustD2 identity');
  }
  const history = existing
    ? await deletedHashes(values.output, values.deletions)
    : values.deletions
      ? await deletedHashes(values.output, values.deletions)
      : [];
  const excluded = excludedDeletions(history, values.reimport);
  const result = await prepareMigration(
    intermediate,
    live,
    { users: { [owner.id]: { login: owner.login, role: 'maintainer' } } },
    existing,
    excluded,
  );
  let changes = await planMigration(values.output, result);
  let folded;
  if (values.aliases && values.items && values.conflicts) {
    folded = foldFrames(
      result.tooltips,
      aliasesSchema.parse(await readJson(values.aliases)),
      result.pushed,
      z.record(z.string(), z.object({ name: z.string() })).parse(await readJson(values.items)),
    );
    const foldChanges = await planFold(values.output, result, folded, values.conflicts, excluded);
    // Re-plan the final result against the original checkout, not an intermediate write.
    changes = await planMigration(values.output, {
      ...result,
      tooltips: folded.tooltips,
      pushed: folded.pushed,
    });
    changes.push(
      ...foldChanges.filter(({ path }) => !changes.some((change) => change.path === path)),
    );
    changes.sort((a, b) => a.path.localeCompare(b.path));
  }
  const diff = dataDiff(changes);
  console.log(JSON.stringify({ diff }, null, 2));
  if (values.diff) {
    if (values.approve && resolve(values.diff) === resolve(values.approve))
      throw new Error('--diff must not overwrite the approval');
    await writeFile(values.diff, `${JSON.stringify(diff, null, 2)}\n`, { flag: 'wx' });
  }
  if (values.write) {
    await commitFiles(values.output, changes, {
      approvedPlan: values.approve ? await readJson(values.approve) : undefined,
      allowAuthoredOverwrite: values['allow-authored-overwrite'],
    });
  }
  console.log(
    JSON.stringify(
      {
        intermediate: result.tooltips.length,
        live: result.liveCount,
        pending: result.pending,
        preserved: result.preserved,
        mode: values.write ? 'write' : 'dry run',
        excluded: result.excluded,
        reviewedReimports: values.reimport ?? [],
        folded: folded?.folded ?? [],
        after: folded?.tooltips.length ?? result.tooltips.length,
        permissions: existing
          ? 'preserved editor-data assignments'
          : `${owner.login} (${owner.id})`,
        output: values.output,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error('Migration failed:', error);
  process.exitCode = 1;
});
