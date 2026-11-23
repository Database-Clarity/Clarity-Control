import { test, expect } from 'vitest';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { startRoleHarness } from './start.mjs';
import { localPath } from '../../apps/web/test/dev-role-web.mjs';
import { checkProduction } from './check-production.mjs';
import worker from '../../apps/worker/src/index.ts';

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

test('loopback role sessions go through Worker auth and cannot sign in on the stock Worker', async () => {
  const port = await freePort();
  const head = 'a'.repeat(40);
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const app = await startRoleHarness({
    port,
    async prepareSandbox({ seedPermissions, directory }) {
      const config = seedPermissions({ users: {} }, ['proof-project']);
      return {
        bindings: {
          GITHUB_OWNER: 'test',
          GITHUB_REPO: 'fixture',
          DATA_BRANCH: 'editor-data',
          GITHUB_APP_ID: '1',
          GITHUB_INSTALLATION_ID: '1',
          GITHUB_PRIVATE_KEY: privateKey,
        },
        async fetch(request) {
          const { pathname } = new URL(request.url);
          if (pathname.endsWith('/access_tokens'))
            return Response.json({ token: 'local-installation' });
          if (pathname.endsWith('/git/ref/heads/editor-data'))
            return Response.json({ object: { sha: head } });
          if (pathname.endsWith('/contents/config/permissions.json')) {
            return Response.json({
              sha: head,
              encoding: 'base64',
              content: Buffer.from(JSON.stringify(config)).toString('base64'),
            });
          }
          if (pathname === '/demo/value') return new Response('local data');
          return new Response('Unexpected fixture request', { status: 404 });
        },
        dataGitDir: directory,
      };
    },
  });
  try {
    const harnessUrl = app.origin + localPath;
    const sessionUrl = harnessUrl + '/session?role=manager-de';
    const choose = (origin, method = 'POST') => fetch(sessionUrl, { method, headers: { origin } });
    expect((await choose('https://example.invalid')).status).toBe(403);
    expect((await choose(app.origin, 'GET')).status).toBe(404);
    expect((await fetch(sessionUrl, { method: 'POST' })).status).toBe(403);
    const result = await choose(app.origin);
    expect(result.status).toBe(200);
    const { token } = await result.json();
    const headers = { authorization: `Bearer ${token}` };
    const me = await fetch(harnessUrl + '/api/me', { headers });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      login: 'local-manager-de',
      role: 'translator',
      languages: ['de'],
      manages: ['de'],
    });
    expect(await fetch(harnessUrl + '/api/me')).toHaveProperty('status', 401);
    expect(await fetch(harnessUrl + '/api/settings', { headers })).toHaveProperty('status', 200);
    expect(
      await fetch(harnessUrl + '/api/settings', {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: '{}',
      }),
    ).toHaveProperty('status', 400);
    expect(
      await fetch(harnessUrl + '/upstream/raw.githubusercontent.com/demo/value').then((r) =>
        r.text(),
      ),
    ).toBe('local data');

    const env = {
      SITE_ORIGIN: 'https://production.example',
      SESSION_SECRET: 'a-different-ephemeral-key-for-the-stock-worker',
      DEV_ROLES: '1',
    };
    const context = { waitUntil() {} };
    expect(
      await worker.fetch(new Request('https://api.example/me', { headers }), env, context),
    ).toHaveProperty('status', 401);
    expect(
      await worker.fetch(
        new Request('https://api.example' + localPath + '/session', {
          method: 'POST',
          headers: { 'x-dev-role': 'maintainer' },
        }),
        env,
        context,
      ),
    ).toHaveProperty('status', 401);

    const output = join(app.directory, 'production-guard-fixture');
    await mkdir(output);
    const file = join(output, 'app.js');
    await writeFile(file, 'export default 42;');
    await expect(checkProduction(output)).resolves.toBeUndefined();
    await writeFile(file, `fetch("${localPath}/session");`);
    await expect(checkProduction(output)).rejects.toThrow('Local role harness found');
  } finally {
    await app.close();
  }
});
