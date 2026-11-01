import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Fixture, makePrivateKey, sha } from './fixture.js';

let key: string;
let fixture: Fixture;
const endpoint = '/compendium/agent-guidance';
const document = { version: 1, scope: 'test', baseline: '', categories: {} };
beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(() => {
  fixture = new Fixture(key);
  fixture.env.GITHUB_OWNER = 'Database-Clarity';
  fixture.env.GITHUB_REPO = 'Live-Clarity-Database';
  fixture.env.DATA_BRANCH = 'editor-data';
});
afterEach(() => vi.unstubAllGlobals());
it('allows maintainers to send only the fixed path and detects stale revisions', async () => {
  expect((await fixture.request(endpoint)).status).toBe(200);
  const response = await fixture.request(endpoint, 'POST', { document, revision: null });
  expect(response.status).toBe(200);
  expect(fixture.snapshots.get(fixture.dataHead)?.['agent-guidance/compendium.json']).toEqual(
    document,
  );
  expect((await fixture.request(endpoint, 'POST', { document, revision: null })).status).toBe(409);
});
it('denies non-maintainers, malformed requests and unsafe destinations', async () => {
  expect((await fixture.request(endpoint, 'POST', { document, revision: null }, 2)).status).toBe(
    403,
  );
  expect(
    (await fixture.request(endpoint, 'POST', { document, revision: null, path: 'other' })).status,
  ).toBe(400);
  expect(
    (
      await fixture.request(endpoint, 'POST', {
        document: { ...document, version: 2 },
        revision: null,
      })
    ).status,
  ).toBe(400);
  fixture.env.DATA_BRANCH = 'main';
  expect((await fixture.request(endpoint)).status).toBe(503);
  expect(fixture.commits).toHaveLength(0);
});
it('rejects oversized input and branch races', async () => {
  expect(
    (
      await fixture.request(endpoint, 'POST', {
        document: { ...document, scope: 'x'.repeat(2_000_001) },
        revision: null,
      })
    ).status,
  ).toBe(413);
  fixture.patchRaces = 1;
  expect((await fixture.request(endpoint, 'POST', { document, revision: null })).status).toBe(409);
  expect(fixture.dataHead).toBe(sha(1));
});
