import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { gitEnvironment } from './sandbox-git.mjs';

const run = promisify(execFile);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const template = new URL('../publisher/template/.publisher/', import.meta.url);

export async function startPublisher({
  directory,
  siteOrigin,
  data,
  repos,
  bindings,
  publicKey,
  generatorSha,
}) {
  // Bundle our own code. Never execute a script from a downloaded Git object.
  const script = join(directory, 'publisher.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('./sandbox-publisher-entry.ts', import.meta.url))],
    outfile: script,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
  });
  const runtime = await readFile(script);
  const verifier = await readFile(new URL('verify-publication.mjs', template));
  const pin = {
    ...JSON.parse(await readFile(new URL('PIN', template), 'utf8')),
    sha256: sha256(runtime),
    verifierSha256: sha256(verifier),
  };
  const head = data.resolve(bindings.DATA_BRANCH);
  const tree = data.writeTree(
    head,
    [
      ['.publisher/PIN', JSON.stringify(pin, null, 2) + '\n'],
      ['.publisher/publisher.mjs', runtime],
      ['.publisher/verify-publication.mjs', verifier],
    ].map(([path, bytes]) => ({ path, mode: '100644', oid: data.writeBlob(bytes) })),
  );
  if (
    !data.updateHead(
      bindings.DATA_BRANCH,
      head,
      data.commit(tree, [head], 'Install disposable publisher'),
    )
  )
    throw new Error('Disposable data ref moved');

  const config = join(directory, 'publisher-config.json');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  await writeFile(
    config,
    JSON.stringify({
      repoDirs: Object.fromEntries(
        Object.entries(repos).map(([name, git]) => [name, git.directory]),
      ),
      // Only public values are passed to the subprocess and persisted to the disposable directory.
      bindings: {
        GITHUB_OWNER: bindings.GITHUB_OWNER,
        GITHUB_REPO: bindings.GITHUB_REPO,
        DATA_BRANCH: bindings.DATA_BRANCH,
        LIVE_BRANCH: bindings.LIVE_BRANCH,
        GENERATOR_OWNER: bindings.GENERATOR_OWNER,
        GENERATOR_REPO: bindings.GENERATOR_REPO,
        GENERATOR_BRANCH: bindings.GENERATOR_BRANCH,
      },
      pin,
      generatorSha,
      publicKeyPem,
      keyFingerprint: sha256(publicKey.export({ type: 'spki', format: 'der' })),
      siteOrigin,
    }),
  );
  const invoke = () =>
    run(process.execPath, [script, config], {
      cwd: directory,
      env: gitEnvironment(directory),
      windowsHide: true,
      timeout: 1_200_000,
    });
  // The seeded permissions and local PIN change the source fence. Materialize
  // the real publication certificates before exposing the sandbox.
  await invoke();

  let active = false;
  let pending = false;
  return function queue() {
    pending = true;
    if (active) return;
    active = true;
    void (async () => {
      try {
        while (pending) {
          pending = false;
          try {
            await invoke();
          } catch (error) {
            console.error('Disposable publisher failed:', error.stderr?.trim() || error.message);
          }
        }
      } finally {
        active = false;
      }
    })();
  };
}
