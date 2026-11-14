import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { config, Fixture, makePrivateKey, sha, tooltip } from './fixture.js';
import worker from '../src/index.js';
import { maxGlossaryTerms, maxGlossaryBytes } from '../../../packages/core/src/glossary/schema.js';

let key: string;
let fixture: Fixture;
const entry = { en: 'Jolt', term: 'Aufschrecken' };
const add = { ops: [{ key: 'jolt', base: null, next: entry }] };
beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(() => {
  fixture = new Fixture(key);
});
afterEach(() => vi.unstubAllGlobals());
it.each([1, 2, 3, 4])('member %s may read a missing glossary', async (id) => {
  const response = await fixture.request('/glossary/de', 'GET', undefined, id);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    revision: null,
    glossary: { v: 1, lang: 'de', terms: {} },
  });
});
it.each([
  [1, 'de', 200],
  [1, 'fr', 200],
  [4, 'de', 200],
  [4, 'fr', 403],
  [2, 'de', 403],
  [3, 'de', 403],
  [99, 'de', 403],
] as const)('role matrix: %s, %s -> %s', async (id, lang, status) => {
  const response = await fixture.request(`/glossary/${lang}`, 'POST', add, id);
  expect(response.status).toBe(status);
  expect(fixture.commits).toHaveLength(status === 200 ? 1 : 0);
});
it('denies signed-out access, unsafe destinations, malformed languages, and unknown members', async () => {
  expect(
    (
      await worker.fetch(new Request('https://api.example/glossary/de'), fixture.env, {
        waitUntil() {},
      })
    ).status,
  ).toBe(401);
  expect((await fixture.request('/glossary/de', 'GET', undefined, 99)).status).toBe(403);
  for (const lang of ['en', 'xx', '..'])
    expect((await fixture.request(`/glossary/${lang}`, 'POST', add)).status).not.toBe(200);
  fixture.env.DATA_BRANCH = 'main';
  expect((await fixture.request('/glossary/de', 'POST', add)).status).toBe(503);
});
it('stamps user and date, returns the real blob revision, and commits only the glossary path', async () => {
  const result = await fixture.request(
    '/glossary/de',
    'POST',
    { ops: [{ ...add.ops[0], next: { ...entry, updatedBy: 'forged', updatedAt: 'forged' } }] },
    4,
  );
  expect(result.status).toBe(200);
  const saved = await result.json();
  expect(saved.glossary.terms.jolt).toMatchObject({ ...entry, updatedBy: 'dan' });
  expect(Date.parse(saved.glossary.terms.jolt.updatedAt)).toBeGreaterThan(0);
  expect((await (await fixture.request('/glossary/de')).json()).revision).toBe(saved.revision);
  expect(fixture.writes).toHaveLength(0);
});
it('merges disjoint entry saves, rejects same-entry conflicts atomically, and supports remove', async () => {
  const first = await (await fixture.request('/glossary/de', 'POST', add)).json();
  expect(
    (
      await fixture.request('/glossary/de', 'POST', {
        ops: [{ key: 'stun', base: null, next: { en: 'Stun', term: 'Betäuben' } }],
      })
    ).status,
  ).toBe(200);
  const head = fixture.dataHead;
  const conflict = await fixture.request('/glossary/de', 'POST', {
    ops: [...add.ops, { key: 'new', base: null, next: { en: 'New', term: 'Neu' } }],
  });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({
    conflicts: [{ key: 'jolt', head: first.glossary.terms.jolt }],
  });
  expect(fixture.dataHead).toBe(head);
  expect(
    (
      await fixture.request('/glossary/de', 'POST', {
        ops: [{ key: 'jolt', base: first.glossary.terms.jolt, next: null }],
      })
    ).status,
  ).toBe(200);
});
it('retries ref races, but fails after three attempts, and rechecks revoked permissions', async () => {
  fixture.patchRaces = 1;
  expect((await fixture.request('/glossary/de', 'POST', add)).status).toBe(200);
  fixture = new Fixture(key);
  fixture.patchRaces = 3;
  expect((await fixture.request('/glossary/de', 'POST', add)).status).toBe(409);
  expect(fixture.dataHead).toBe(sha(1));
  fixture = new Fixture(key);
  fixture.beforePatch = () => {
    fixture.moveData({
      'config/permissions.json': {
        users: { ...config.users, '4': { login: 'dan', role: 'translator', languages: ['fr'] } },
      },
      'tooltips/123.json': tooltip(),
    });
  };
  expect((await fixture.request('/glossary/de', 'POST', add, 4)).status).toBe(403);
});
it('rejects invalid input and oversized bodies before writing', async () => {
  for (const input of [
    { ops: [] },
    { ops: add.ops, extra: true },
    { ops: [{ ...add.ops[0], key: 'wrong' }] },
    { ops: [{ ...add.ops[0], next: { ...entry, note: 'x'.repeat(241) } }] },
  ])
    expect((await fixture.request('/glossary/de', 'POST', input)).status).toBe(400);
  expect((await fixture.request('/glossary/de', 'POST', { note: 'x'.repeat(100001) })).status).toBe(
    413,
  );
  expect(fixture.commits).toHaveLength(0);
});
it('refuses growth beyond the language cap, while allowing an atomic remove and add', async () => {
  const terms = Object.fromEntries(
    Array.from({ length: maxGlossaryTerms }, (_, index) => [
      `term ${index}`,
      {
        en: `Term ${index}`,
        term: `Begriff ${index}`,
        updatedAt: '2026-11-14T00:00:00Z',
        updatedBy: 'alice',
      },
    ]),
  );
  fixture.moveData({ 'glossary/de.json': { v: 1, lang: 'de', terms } });
  const head = fixture.dataHead;
  const refused = await fixture.request('/glossary/de', 'POST', add);
  expect(refused.status).toBe(400);
  expect((await refused.json()).error).toContain(`limited to ${maxGlossaryTerms}`);
  expect(fixture.dataHead).toBe(head);
  expect(
    (
      await fixture.request('/glossary/de', 'POST', {
        ops: [{ key: 'term 0', base: terms['term 0'], next: null }, ...add.ops],
      })
    ).status,
  ).toBe(200);
});
it('refuses oversized UTF-8 growth but permits shrinking a file already over the byte cap', async () => {
  const terms = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [
      `wide ${index}`,
      {
        en: `Wide ${index}`,
        term: '界'.repeat(80),
        note: '界'.repeat(240),
        also: Array(8).fill('界'.repeat(60)),
        forms: Array(8).fill('界'.repeat(60)),
        updatedAt: '2026-11-14T00:00:00Z',
        updatedBy: 'alice',
      },
    ]),
  );
  const glossary = { v: 1, lang: 'de', terms };
  // Fixture serves compact JSON; the shrink remains smaller even after canonical formatting.
  const beforeSize = new TextEncoder().encode(JSON.stringify(glossary)).byteLength;
  expect(beforeSize).toBeGreaterThan(maxGlossaryBytes);
  fixture.moveData({ 'glossary/de.json': glossary });
  const head = fixture.dataHead;
  const refused = await fixture.request('/glossary/de', 'POST', add);
  expect(refused.status).toBe(400);
  expect((await refused.json()).error).toContain('256 KiB');
  expect(fixture.dataHead).toBe(head);
  const result = await fixture.request('/glossary/de', 'POST', {
    ops: Array.from({ length: 10 }, (_, index) => ({
      key: `wide ${index}`,
      base: terms[`wide ${index}`],
      next: null,
    })),
  });
  expect(result.status).toBe(200);
  const remote = await result.json();
  expect(Object.keys(remote.glossary.terms)).toHaveLength(90);
  const afterSize = new TextEncoder().encode(
    `${JSON.stringify(remote.glossary, null, 2)}\n`,
  ).byteLength;
  expect(afterSize).toBeLessThan(beforeSize);
  expect(afterSize).toBeGreaterThan(maxGlossaryBytes);
  expect((await (await fixture.request('/glossary/de')).json()).revision).toBe(remote.revision);
});
