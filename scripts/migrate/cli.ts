import { parseArgs } from 'node:util';
import { prepareMigration, readJson, readMigration, writeMigration } from './migrate.js';

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
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'npm run migrate -- --output <editor-data checkout> [--intermediate <file> --live <file>] [--owner <identity.json>]',
    );
    return;
  }
  if (!values.output) throw new Error('--output is required; use an isolated editor-data checkout');
  if (Boolean(values.intermediate) !== Boolean(values.live)) {
    throw new Error('--intermediate and --live must be provided together');
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
  const result = await prepareMigration(
    intermediate,
    live,
    { users: { [owner.id]: { login: owner.login, role: 'maintainer' } } },
    existing,
  );
  await writeMigration(values.output, result);
  console.log(
    JSON.stringify(
      {
        intermediate: result.tooltips.length,
        live: result.liveCount,
        pending: result.pending,
        preserved: result.preserved,
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
