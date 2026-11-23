import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAdapter } from './sandbox-fetch.mjs';
import { SandboxGit } from './sandbox-git.mjs';

const owner = 'Database-Clarity';
const data = 'Live-Clarity-Database';
const generator = 'Description-data-generator';
const compendium = 'Compendium-data';
const siteOrigin = 'http://127.0.0.1:4177';
const api = 'https://api.github.com';
const raw = `https://raw.githubusercontent.com/${owner}`;
const repo = `${api}/repos/${owner}/${data}`;
const textPath = 'tooltips/7.json';
const bytes = Buffer.from('\uFEFF{ "text": "ő" }\r\n');
const huge = Buffer.from(`"${'x'.repeat(1_000_001)}"\n`);
const permissions = '{"users":{"801":{"login":"Dev-Permission","role":"editor"}}}\n';
const bindings = {
  GITHUB_OWNER: owner,
  GITHUB_REPO: data,
  GITHUB_INSTALLATION_ID: '1',
  GENERATOR_REPO: generator,
  COMPENDIUM_REPO: compendium,
  COMPENDIUM_WORKFLOW: 'compendium.yml',
  COMPENDIUM_REF: 'main',
  DATA_BRANCH: 'editor-data',
  LIVE_BRANCH: 'converter-v2-test',
};
const opts = (method, body) => ({ method, body: JSON.stringify(body) });
const run = async (fetch, url, status, options) => {
  const response = await fetch(new Request(url, options));
  assert.equal(response.status, status, `${options?.method ?? 'GET'} ${url}`);
  return response;
};
const parsed = async (...args) => (await run(...args)).json();

function setup() {
  const scratch = new URL('./dist/', import.meta.url);
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(fileURLToPath(new URL('adapter-', scratch)));
  const repos = {};
  for (const slug of [data, generator, compendium]) {
    const directory = join(root, slug);
    mkdirSync(directory);
    const git = new SandboxGit(directory);
    git.git(['init', '--bare', '--template=']);
    repos[slug] = git;
  }
  const git = repos[data];
  const tree = (repo, files) =>
    repo.writeTree(
      undefined,
      Object.entries(files).map(([path, content]) => ({
        path,
        mode: '100644',
        oid: repo.writeBlob(content),
      })),
    );
  const baseline = tree(git, {
    [textPath]: bytes,
    'tooltips/huge.json': huge,
    'tooltips/binary.json': Buffer.from('a\0b'),
    'config/permissions.json': permissions,
    'exports/projects/alpha.json': '{"id":"alpha"}\n',
    'schedule/batches/b1/tooltips/7.json': '{}\n',
    'liveDescriptions.json': '{"perks":{}}\n',
  });
  const initial = git.commit(baseline, [], 'Initial data');
  const oldLive = git.commit(baseline, [], 'Initial live');
  git.updateHead(bindings.DATA_BRANCH, undefined, initial);
  git.updateHead(bindings.LIVE_BRANCH, undefined, oldLive);
  for (const [slug, ref, path] of [
    [generator, 'v2', 'templates/v2/items.json'],
    [compendium, 'main', 'compendium.json'],
  ]) {
    const git = repos[slug];
    const sha = git.commit(tree(git, { [path]: '[]\n' }), [], 'Fixture input');
    git.updateHead(ref, undefined, sha);
  }
  let writes = 0;
  const fetch = createAdapter({ repos, bindings, siteOrigin, onDataWrite: () => writes++ });
  return { git, repos, fetch, initial, baseline, oldLive, writes: () => writes };
}

test('serves scoped App tokens, pinned generator and raw inputs, accounts, Compendium, and Turnstile', async () => {
  const { fetch, initial, repos } = setup();
  const tokenURL = `${api}/app/installations/1/access_tokens`;
  const grant = { repositories: [data], permissions: { contents: 'write' } };
  assert.equal(
    (await parsed(fetch, tokenURL, 201, opts('POST', grant))).token,
    'clarity-disposable-installation',
  );
  await run(fetch, tokenURL, 422, opts('POST', { ...grant, repositories: ['another-repo'] }));
  await run(fetch, tokenURL, 422, opts('POST', { ...grant, permissions: { secrets: 'read' } }));

  const sha = repos[generator].resolve('v2');
  assert.deepEqual(await parsed(fetch, `${api}/repos/${owner}/${generator}/commits/v2`, 200), {
    sha,
  });
  for (const ref of ['v2', sha])
    assert.deepEqual(
      await parsed(fetch, `${raw}/${generator}/${ref}/templates/v2/items.json`, 200),
      [],
    );
  assert.deepEqual(await parsed(fetch, `${raw}/${compendium}/main/compendium.json`, 200), []);
  const url = `${raw}/${data}/${initial}/${textPath}`;
  assert.deepEqual(Buffer.from(await (await run(fetch, url, 200)).arrayBuffer()), bytes);
  const head = await run(fetch, url, 200, { method: 'HEAD' });
  assert.equal(head.headers.get('Content-Length'), String(bytes.length));
  assert.equal(await head.text(), '');
  await run(fetch, url, 404, opts('POST', {}));
  await run(fetch, `${raw}/other/${data}/${initial}/${textPath}`, 404);
  await run(fetch, `${raw}/${data}/${'f'.repeat(40)}/${textPath}`, 404);

  assert.deepEqual(await parsed(fetch, `${api}/users/dev-permission`, 200), {
    id: 801,
    login: 'Dev-Permission',
    type: 'User',
  });
  const local = await parsed(fetch, `${api}/users/dev-partner`, 200);
  assert.equal(local.type, 'User');
  assert.deepEqual(await parsed(fetch, `${api}/users/DEV-PARTNER`, 200), local);
  await run(fetch, `${api}/users/nonexistent`, 404);
  await run(fetch, `${api}/user`, 404);
  await run(fetch, 'https://github.com/login/oauth/access_token', 404, opts('POST', {}));
  await run(fetch, 'https://docs.google.com/spreadsheets/d/id/export', 404);

  const workflow = `${api}/repos/${owner}/${compendium}/actions/workflows/compendium.yml`;
  const runs = `${workflow}/runs?branch=main&per_page=1`;
  assert.deepEqual(await parsed(fetch, runs, 200), { workflow_runs: [] });
  await run(fetch, `${workflow}/dispatches`, 404, opts('POST', { ref: 'unknown' }));
  await run(fetch, `${workflow}/dispatches`, 204, opts('POST', { ref: 'main' }));
  const [result] = (await parsed(fetch, runs, 200)).workflow_runs;
  assert.equal(result.html_url, siteOrigin);
  assert.equal(result.conclusion, 'success');
  const verify = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
  for (const [response, success] of [
    ['clarity-local-turnstile', true],
    ['impostor', false],
  ])
    assert.deepEqual(
      await parsed(fetch, verify, 200, {
        method: 'POST',
        body: new URLSearchParams({ response }),
      }),
      { success },
    );
});

test('reads real Git refs, commits, history, comparisons, raw blobs, and contents listings', async () => {
  const { git, fetch, initial, baseline } = setup();
  const { oid } = git.treeEntries(initial, false, textPath)[0];
  assert.deepEqual(await parsed(fetch, `${repo}/git/ref/heads/editor-data`, 200), {
    object: { sha: initial },
  });
  assert.deepEqual((await parsed(fetch, `${repo}/git/commits/${initial}`, 200)).tree, {
    sha: baseline,
  });
  const blobURL = `${repo}/git/blobs/${oid}`;
  assert.equal((await parsed(fetch, blobURL, 200)).content, bytes.toString('base64'));
  const response = await run(fetch, blobURL, 200, {
    headers: { Accept: 'application/vnd.github.raw+json' },
  });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal((await parsed(fetch, `${repo}/contents/${textPath}?ref=${initial}`, 200)).sha, oid);
  assert.equal(
    (await parsed(fetch, `${repo}/contents/tooltips/huge.json?ref=${initial}`, 200)).encoding,
    'none',
  );
  const listing = await parsed(fetch, `${repo}/contents/schedule/batches/b1?ref=${initial}`, 200);
  assert.equal(listing[0].type, 'dir');
  assert.equal(
    listing[0].sha,
    git.treeEntries(initial, false, 'schedule/batches/b1/tooltips')[0].oid,
  );
  await run(fetch, `${repo}/contents/missing?ref=${initial}`, 404);
  await run(fetch, `${repo}/git/ref/heads/missing`, 404);
  await run(fetch, `${repo}/git/blobs/${initial}`, 404);

  const later = git.commit(baseline, [initial], 'Unrelated commit');
  git.updateHead(bindings.DATA_BRANCH, initial, later);
  const compare = await parsed(fetch, `${repo}/compare/${later}...${initial}?per_page=1`, 200);
  assert.deepEqual(compare, { status: 'behind', ahead_by: 0, behind_by: 1 });
  const history = `${repo}/commits?sha=${later}&path=${textPath}&per_page=1`;
  assert.equal((await parsed(fetch, history, 200))[0].sha, initial);
  assert.deepEqual(await parsed(fetch, `${history}&page=2`, 200), []);
});

test('serves every Worker GraphQL shape with real object IDs and missing file envelopes', async () => {
  const { git, fetch, initial, baseline, oldLive } = setup();
  const fileOid = git.treeEntries(initial, false, textPath)[0].oid;
  const query = async (query, variables) =>
    parsed(
      fetch,
      `${api}/graphql`,
      200,
      opts('POST', {
        query,
        variables: { owner, name: data, ...variables },
      }),
    );
  const objects = 'o0:object(expression:$e0) o1:object(expression:$e1) o2:object(expression:$e2)';
  const variables = {
    e0: `${initial}:${textPath}`,
    e1: `${initial}:tooltips/huge.json`,
    e2: `${initial}:absent`,
  };
  const { o0, o1, o2 } = (await query(objects, variables)).data.repository;
  assert.deepEqual(o0, { oid: fileOid, text: bytes.toString(), isTruncated: false });
  assert.equal(o1.isTruncated, true);
  assert.equal(o1.text, null);
  assert.equal(o2, null);
  const fallback = await parsed(fetch, `${repo}/git/blobs/${o1.oid}`, 200);
  assert.deepEqual(Buffer.from(fallback.content, 'base64'), huge);
  const rawBlob = (
    await query(objects + ' fragment R on Blob', {
      ...variables,
      e2: `${initial}:tooltips/binary.json`,
    })
  ).data.repository;
  assert.equal(rawBlob.o0.byteSize, bytes.length);
  assert.equal(rawBlob.o0.isBinary, false);
  assert.equal(rawBlob.o2.isBinary, true);
  assert.equal(rawBlob.o2.text, null);
  const tree = git.treeEntries(initial, false, 'tooltips')[0].oid;
  assert.deepEqual(
    (
      await query('object(expression:$e){oid}', {
        e: `${initial}:tooltips`,
      })
    ).data.repository.object,
    { oid: tree },
  );
  assert.deepEqual(
    (await query('object(oid:$oid)', { oid: fileOid })).data.repository.object,
    rawBlob.o0,
  );

  const branch = 'refs/heads/editor-data';
  const live = 'refs/heads/converter-v2-test';
  const observed = (
    await query(
      'query GlobalsObserve{ref(qualifiedName:$branch){' +
        't0:file(path:$t0){type oid object{... on Tree{entries{nameRaw mode oid}}}} ' +
        'b0:file(path:$b0){type oid} x0:file(path:$x0){object{... on Blob{oid byteSize isBinary isTruncated text}}}} ' +
        'live:ref(qualifiedName:$live){target{oid}}}',
      { branch, live, t0: 'config', b0: textPath, x0: textPath },
    )
  ).data.repository;
  assert.equal(observed.ref.target.oid, initial);
  assert.deepEqual(observed.ref.target.b0, { type: 'blob', oid: fileOid });
  assert.deepEqual(observed.ref.target.x0.object, rawBlob.o0);
  assert.deepEqual(observed.ref.target.t0.object.entries, [
    {
      nameRaw: Buffer.from('permissions.json').toString('base64'),
      mode: 0o100644,
      oid: git.treeEntries(initial, false, 'config/permissions.json')[0].oid,
    },
  ]);
  assert.equal(observed.live.target.oid, oldLive);

  const publish = await query(
    'ref(qualifiedName:$branch){oid tree{oid} o0:file(path:$p0){object{... on Blob{oid}}} ' +
      'o1:file(path:$p1){object{... on Blob{oid isTruncated text}}} ' +
      't0:file(path:$t0){object{... on Tree{entries{name object{... on Tree{entries{name}}}}}}}}',
    { branch, p0: textPath, p1: 'missing.json', t0: 'schedule/batches/b1' },
  );
  const target = publish.data.repository.ref.target;
  assert.deepEqual(target.tree, { oid: baseline });
  assert.deepEqual(target.o0, { object: { oid: fileOid } });
  assert.equal(target.o1, null);
  assert.deepEqual(publish.errors, [
    { type: 'NOT_FOUND', path: ['repository', 'ref', 'target', 'o1'] },
  ]);
  assert.deepEqual(target.t0.object.entries, [
    { name: 'tooltips', object: { entries: [{ name: '7.json' }] } },
  ]);

  for (const fields of ['name', 'name object{... on Blob{oid isTruncated text}}']) {
    const exports = await query(
      'ref(qualifiedName:$branch){oid tree{oid} perm:file(path:$perm){object{... on Blob{oid isTruncated text}}} ' +
        'config:file(path:$config){object{... on Blob{oid isTruncated text}}} last:history(first:1,path:$config){nodes{committedDate}} ' +
        `dir:file(path:$dir){object{... on Tree{entries{${fields}}}}}}`,
      {
        branch,
        perm: 'config/permissions.json',
        config: 'exports/projects/alpha.json',
        dir: 'exports/projects',
      },
    );
    const target = exports.data.repository.ref.target;
    assert.equal(target.perm.object.text, permissions);
    assert.equal(target.config.object.text, '{"id":"alpha"}\n');
    assert.equal(target.dir.object.entries[0].name, 'alpha.json');
    assert.equal(
      target.dir.object.entries[0].object?.text,
      fields === 'name' ? undefined : target.config.object.text,
    );
    assert.ok(Number.isFinite(Date.parse(target.last.nodes[0].committedDate)));
  }
});

test('writes exact blobs via tree, commit, ref and contents APIs, and rejects stale or duplicate updates', async () => {
  const { git, fetch, initial, baseline, oldLive, writes } = setup();
  const post = (path, body, status = 201) =>
    parsed(fetch, `${repo}/${path}`, status, opts('POST', body));
  const file = 'publish/requests/request.json';
  const mode = '100644';
  const type = 'blob';
  const originalOid = git.treeEntries(initial, false, textPath)[0].oid;
  const { sha } = await post('git/trees', {
    base_tree: baseline,
    tree: [
      { path: file, mode, type, content: bytes.toString() },
      { path: textPath, mode, type, sha: null },
      { path: 'existing.json', mode, type, sha: originalOid },
    ],
  });
  assert.deepEqual(git.blob(git.treeEntries(sha, false, file)[0].oid), bytes);
  assert.equal(git.treeEntries(sha, false, textPath).length, 0);
  assert.equal(git.treeEntries(sha, false, 'existing.json')[0].oid, originalOid);
  await post('git/trees', { base_tree: originalOid, tree: [] }, 422);
  await post('git/trees', { tree: [{ path: '../escape', mode, type, content: '{}' }] }, 422);
  const author = {
    name: 'dev-local',
    email: '123+dev-local@users.noreply.github.com',
    date: '2026-11-23T00:10:00Z',
  };
  const next = (
    await post('git/commits', { tree: sha, parents: [initial], message: 'Saved', author })
  ).sha;
  const sibling = (await post('git/commits', { tree: sha, parents: [initial], message: 'Race' }))
    .sha;
  assert.match(
    git.text(['cat-file', 'commit', next]),
    /author dev-local <123\+dev-local@users\.noreply\.github\.com>/,
  );
  const branch = `${repo}/git/refs/heads/editor-data`;
  await run(fetch, branch, 200, opts('PATCH', { sha: next, force: false }));
  await run(fetch, branch, 422, opts('PATCH', { sha: sibling, force: false }));
  await run(fetch, branch, 422, opts('PATCH', { sha: sibling, force: true }));
  assert.equal(writes(), 1);
  assert.equal(git.resolve('editor-data'), next);

  const ref = 'refs/heads/editor-settings';
  await post('git/refs', { ref, sha: next });
  await post('git/refs', { ref, sha: sibling }, 422);
  assert.equal(git.resolve(ref), next);

  const kick = {
    branch: 'editor-data',
    message: 'Due batch kick',
    content: bytes.toString('base64'),
  };
  const kickPath = 'publish/kicks/batch-local.json';
  const kickURL = `${repo}/contents/${kickPath}`;
  await run(fetch, kickURL, 201, opts('PUT', kick));
  await run(fetch, kickURL, 422, opts('PUT', kick));
  assert.equal(writes(), 2);
  assert.deepEqual(
    Buffer.from(
      await (await run(fetch, `${raw}/${data}/editor-data/${kickPath}`, 200)).arrayBuffer(),
    ),
    bytes,
  );
  const liveURL = `${repo}/contents/liveDescriptions.json`;
  const liveOid = git.treeEntries(oldLive, false, 'liveDescriptions.json')[0].oid;
  const live = { ...kick, branch: 'converter-v2-test', sha: liveOid };
  const updated = await parsed(fetch, liveURL, 200, opts('PUT', live));
  assert.equal(git.resolve('converter-v2-test'), updated.commit.sha);
  await run(fetch, liveURL, 422, opts('PUT', live));
  assert.equal(writes(), 2);

  const old = git.resolve('editor-data');
  const winner = git.commit(sha, [old], 'Concurrent publisher record');
  const loser = git.commit(sha, [old], 'Concurrent API write');
  const updateHead = git.updateHead.bind(git);
  git.updateHead = (branch, expected, next) => {
    assert.equal(next, loser);
    assert.equal(updateHead(branch, expected, winner), true);
    return updateHead(branch, expected, next);
  };
  await run(fetch, branch, 409, opts('PATCH', { sha: loser, force: false }));
  assert.equal(git.resolve('editor-data'), winner);
  assert.equal(writes(), 2);
});
