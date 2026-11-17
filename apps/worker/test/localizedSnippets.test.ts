/// <reference types="vite/client" />
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { config, Fixture, makePrivateKey } from './fixture.js';
import { snippetEnglishHash } from '../../../packages/core/src/localizedSnippets.js';
import { snippetsPath } from '../../../packages/core/src/customSnippets.js';
import { apiRequest } from '../../web/src/services/apiAuth';
import {
  getLocalizedSnippets,
  getSnippetTranslations,
  saveSnippetTranslation,
  SnippetConflictError,
} from '../../web/src/services/snippets';
import worker from '../src/index.js';
vi.mock('../../web/src/services/apiAuth', () => ({
  apiRequest: vi.fn(),
  failure: async (r: Response) => {
    throw new Error(await r.text());
  },
}));

let key: string;
let fixture: Fixture;
const source = {
  id: 'team:one',
  label: 'Refills',
  keywords: 'magazine',
  template: '<title {{1:refills}} [G_refill] />',
};
let translation: { label: string; keywords: string; template: string; enHash: string };
beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(async () => {
  fixture = new Fixture(key);
  fixture.moveData({
    [snippetsPath]: { v: 1, snippets: [source] },
    'config/permissions.json': {
      users: {
        ...config.users,
        '6': { login: 'manager', role: 'translator', languages: ['de'], manages: ['de'] },
        '7': { login: 'other', role: 'translator', languages: ['fr'], manages: ['fr'] },
      },
      partners: { '5': { login: 'partner', projects: ['test'] } },
    },
  });
  translation = {
    label: 'Nachladen',
    keywords: 'Magazin',
    template: '<title {{1:lädt nach}} [G_refill] />',
    enHash: await snippetEnglishHash(source.template),
  };
  vi.mocked(apiRequest).mockImplementation((path, init) =>
    fixture.request(
      path,
      init?.method ?? 'GET',
      init?.body ? JSON.parse(String(init.body)) : undefined,
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());
const save = (user = 1, next: unknown = translation, base: unknown = null, id = source.id) =>
  fixture.request('/snippets/local/de', 'PUT', { id, base, next }, user);

it.each([1, 2, 3, 4, 6, 7])(
  'allows editor role %s to read effective English fallback',
  async (user) => {
    const response = await fixture.request('/snippets/local/de', 'GET', undefined, user);
    expect(response.status).toBe(200);
    expect((await response.json()).snippets.at(-1)).toMatchObject({
      ...source,
      hint: 'EN',
      outdated: false,
      language: 'en',
    });
  },
);
it.each([
  [1, 200],
  [6, 200],
  [2, 403],
  [3, 403],
  [4, 403],
  [7, 403],
  [5, 403],
  [99, 403],
])('write role %s -> %s', async (user, status) => {
  expect((await save(user)).status).toBe(status);
});
it.each([5, 99])('denies outsider %s read access', async (user) => {
  expect((await fixture.request('/snippets/local/de', 'GET', undefined, user)).status).toBe(403);
});
it('uses the typed client through real routes, detects CAS conflicts, and deletes', async () => {
  const change = { id: source.id, base: null, next: translation };
  await saveSnippetTranslation('de', change);
  const read = await getLocalizedSnippets('de');
  expect(read.snippets.at(-1)).toMatchObject({ ...translation, hint: null, language: 'de' });
  await expect(saveSnippetTranslation('de', change)).rejects.toBeInstanceOf(SnippetConflictError);
  await saveSnippetTranslation('de', { ...change, base: translation, next: null });
  expect((await getLocalizedSnippets('de')).snippets.at(-1)?.hint).toBe('EN');
});
it('detects outdated English and falls back; exposes outdated ids and stored entries to managers only', async () => {
  expect((await save()).status).toBe(200);
  fixture.moveData({
    [snippetsPath]: { v: 1, snippets: [{ ...source, template: source.template + ' now' }] },
  });
  const result = await getLocalizedSnippets('de');
  expect(result.snippets.at(-1)).toMatchObject({
    hint: 'EN',
    outdated: true,
    template: source.template + ' now',
  });
  expect(result.outdated).toEqual([source.id]);
  expect((await getSnippetTranslations('de')).translations[source.id]).toEqual(translation);
  const reader = await (await fixture.request('/snippets/local/de', 'GET', undefined, 4)).json();
  expect(reader.outdated).toEqual([]);
  expect(reader).not.toHaveProperty('translations');
  expect((await save(1, translation, translation)).status).toBe(409);
});
it('rejects invalid skeletons with a named error, unknown ids, stale hashes, and bounds', async () => {
  const bad = await save(1, {
    ...translation,
    template: translation.template.replace('G_refill', 'G_other'),
  });
  expect(bad.status).toBe(400);
  expect((await bad.json()).details).toEqual({ name: 'SnippetSkeletonError' });
  expect((await save(1, translation, null, 'me:one')).status).toBe(400);
  expect((await save(1, translation, null, 'team:missing')).status).toBe(400);
  expect((await save(1, { ...translation, enHash: 'a'.repeat(64) })).status).toBe(409);
  for (const next of [
    { ...translation, label: 'x'.repeat(41) },
    { ...translation, keywords: 'x'.repeat(2001) },
    { ...translation, template: 'x'.repeat(2001) },
  ])
    expect((await save(1, next)).status).toBe(400);
  expect(fixture.commits).toHaveLength(0);
});
it('localizes built-ins and falls back for a stored current-hash skeleton mismatch', async () => {
  const initial = await getLocalizedSnippets('de');
  const first = initial.snippets[0]!;
  expect(
    (
      await save(
        1,
        { ...translation, enHash: first.enHash, template: first.template },
        null,
        first.id,
      )
    ).status,
  ).toBe(200);
  fixture.moveData({ 'snippets/de.json': { [source.id]: { ...translation, template: 'wrong' } } });
  expect((await getLocalizedSnippets('de')).snippets.at(-1)?.hint).toBe('EN');
});
it('retries disjoint races, rejects competing entry writes, and reauthorizes managers', async () => {
  fixture.patchRaces = 1;
  expect((await save()).status).toBe(200);
  fixture.beforePatch = () =>
    fixture.moveData({ 'snippets/de.json': { [source.id]: { ...translation, label: 'Winner' } } });
  expect((await save(1, { ...translation, label: 'Loser' }, translation)).status).toBe(409);
  fixture.beforePatch = () => fixture.moveData({ 'config/permissions.json': config });
  expect(
    (await save(6, { ...translation, label: 'New' }, { ...translation, label: 'Winner' })).status,
  ).toBe(403);
});
it('preserves a disjoint translation committed during a ref race', async () => {
  const first = (await getLocalizedSnippets('de')).snippets[0]!;
  const other = { ...translation, template: first.template, enHash: first.enHash };
  fixture.beforePatch = () => fixture.moveData({ 'snippets/de.json': { [first.id]: other } });
  expect((await save()).status).toBe(200);
  expect((await getSnippetTranslations('de')).translations).toEqual({
    [first.id]: other,
    [source.id]: translation,
  });
});
it.each([
  [1, 200],
  [6, 200],
  [2, 403],
  [3, 403],
  [4, 403],
  [7, 403],
  [5, 403],
  [99, 403],
])('management read role %s -> %s', async (user, status) => {
  expect(
    (await fixture.request('/snippets/local/de?view=translations', 'GET', undefined, user)).status,
  ).toBe(status);
});
it('checks destinations, languages, oversized requests, and authentication', async () => {
  for (const lang of ['en', 'xx', '..'])
    expect((await fixture.request(`/snippets/local/${lang}`)).status).not.toBe(200);
  const unsigned = await worker.fetch(
    new Request('https://api.example/snippets/local/de'),
    fixture.env,
    { waitUntil() {} },
  );
  expect(unsigned.status).toBe(401);
  expect(
    (await fixture.request('/snippets/local/de', 'PUT', { text: 'x'.repeat(32001) })).status,
  ).toBe(413);
  fixture.env.DATA_BRANCH = 'main';
  expect((await save()).status).toBe(503);
});
it('retains retired built-in ids without blocking reads, unrelated writes, or orphan deletion', async () => {
  fixture.moveData({ 'snippets/de.json': { 'wrap:green': translation } });
  expect((await getLocalizedSnippets('de')).snippets.some((s) => s.id === 'wrap:green')).toBe(
    false,
  );
  expect((await getSnippetTranslations('de')).translations['wrap:green']).toEqual(translation);
  expect((await save()).status).toBe(200);
  expect((await save(6, null, translation, 'wrap:green')).status).toBe(200);
  expect((await getSnippetTranslations('de')).translations['wrap:green']).toBeUndefined();
  expect((await save(6, translation, null, 'wrap:green')).status).toBe(400);
});
it('treats an absent prototype-named id as missing when deleting', async () => {
  expect((await save(1, null, null, 'toString')).status).toBe(200);
  expect((await save(1, translation, null, 'toString')).status).toBe(400);
  expect(fixture.commits).toHaveLength(0);
});
