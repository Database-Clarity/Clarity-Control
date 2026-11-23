import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createAdapter } from './sandbox-fetch.mjs';
import { downloadRepo } from './sandbox-git.mjs';
import { startPublisher } from './sandbox-publisher.mjs';

const owner = 'Database-Clarity';
const dataRepo = 'Live-Clarity-Database';
const generatorRepo = 'Description-data-generator';
const compendiumRepo = 'Compendium-data';
const dataBranch = 'editor-data';
const liveBranch = 'converter-v2-test';
const bundleBranch = 'editor-data-bundle';
const draftsBranch = 'editor-drafts';
const legacyCommit = 'ca7d872d64512bc9ecba094dac6e368f65e1fea5';
const refspec = (branch) => `refs/heads/${branch}:refs/heads/${branch}`;

async function downloadSources(directory) {
  if (!isAbsolute(directory) || (await readdir(directory)).length)
    throw new Error('Dev roles requires an empty, absolute scratch directory');

  const paths = ['database.git', 'generator.git', 'compendium.git'].map((name) =>
    join(directory, name),
  );
  await Promise.all(paths.map((path) => mkdir(path)));
  const [data, generator, compendium] = await Promise.all([
    downloadRepo(
      paths[0],
      `${owner}/${dataRepo}`,
      [refspec(dataBranch)],
      [
        ...[liveBranch, bundleBranch, draftsBranch].map(refspec),
        `${legacyCommit}:refs/heads/local-legacy-history`,
      ],
    ),
    downloadRepo(paths[1], `${owner}/${generatorRepo}`, [], [refspec('v2')]),
    downloadRepo(paths[2], `${owner}/${compendiumRepo}`, [], [refspec('main')]),
  ]);
  return { data, generator, compendium };
}

export async function prepareSandbox({ directory, siteOrigin, seedPermissions }) {
  const site = new URL(siteOrigin);
  if (
    !['http:', 'https:'].includes(site.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(site.hostname) ||
    site.origin !== siteOrigin
  )
    throw new Error('Dev roles requires a loopback site origin');
  const { data, generator, compendium } = await downloadSources(directory);
  const revisions = {
    [dataBranch]: data.resolve(dataBranch),
    [liveBranch]: data.resolve(liveBranch),
    [bundleBranch]: data.resolve(bundleBranch),
    [draftsBranch]: data.resolve(draftsBranch),
    legacyHistory: data.resolve(legacyCommit),
    'Description-data-generator/v2': generator.resolve('v2'),
    'Compendium-data/main': compendium.resolve('main'),
  };
  for (const [ref, sha] of Object.entries(revisions)) {
    if (!sha) throw new Error(`Missing required public revision ${ref}`);
  }
  const head = revisions[dataBranch];
  const files = new Map(data.treeEntries(head, true).map((entry) => [entry.name, entry]));
  const projectIds = [...files.keys()].flatMap((path) => {
    const match = /^exports\/projects\/([a-z][a-z0-9-]{1,31})\.json$/.exec(path);
    return match ? [match[1]] : [];
  });
  const path = 'config/permissions.json';
  const original = JSON.parse(data.blob(files.get(path).oid));
  const permissions = seedPermissions(original, projectIds);
  const oid = data.writeBlob(JSON.stringify(permissions, null, 2) + '\n');
  const tree = data.writeTree(head, [{ path, mode: '100644', oid }]);
  const seeded = data.commit(tree, [head], 'Seed disposable dev-role permissions');
  if (!data.updateHead(dataBranch, head, seeded)) throw new Error('Disposable data ref moved');

  const appKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const signingKeys = generateKeyPairSync('ed25519');
  const pem = (key) => key.export({ type: 'pkcs8', format: 'pem' });
  const bindings = {
    GITHUB_OWNER: owner,
    GITHUB_REPO: dataRepo,
    DATA_BRANCH: dataBranch,
    LIVE_BRANCH: liveBranch,
    GENERATOR_OWNER: owner,
    GENERATOR_REPO: generatorRepo,
    GENERATOR_BRANCH: 'v2',
    GITHUB_APP_ID: '1',
    GITHUB_APP_SLUG: 'clarity-editor-backend',
    GITHUB_INSTALLATION_ID: '1',
    GITHUB_PRIVATE_KEY: pem(appKey),
    PUBLISH_SIGNING_KEY: pem(signingKeys.privateKey),
    COMPENDIUM_OWNER: owner,
    COMPENDIUM_REPO: compendiumRepo,
    COMPENDIUM_REF: 'main',
    COMPENDIUM_WORKFLOW: 'compendium.yml',
  };
  const repos = { [dataRepo]: data, [generatorRepo]: generator, [compendiumRepo]: compendium };
  const queuePublisher = await startPublisher({
    directory,
    siteOrigin,
    data,
    repos,
    bindings,
    publicKey: signingKeys.publicKey,
    generatorSha: revisions['Description-data-generator/v2'],
  });
  return {
    fetch: createAdapter({ repos, bindings, siteOrigin, onDataWrite: queuePublisher }),
    bindings,
    revisions,
    dataGitDir: data.directory,
  };
}
