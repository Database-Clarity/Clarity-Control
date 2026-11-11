import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { baseEnhancedPublishMessage } from '@clarity/core';
import { Fixture, makePrivateKey, tooltip } from './fixture.js';
import { GitHub } from '../src/github.js';
import { publish } from '../src/publish.js';
import { refuseBaseEnhanced } from '../src/baseEnhanced.js';

let key: string;
let f: Fixture;
beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(() => {
  f = new Fixture(key);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
const donor = (text: string, hash = 124) => ({ ...tooltip(text), hash });
const cases = [
  { name: 'direct', text: '{{a}{b}}', files: {} },
  { name: 'unfinished', text: '{{a}{', files: {} },
  {
    name: 'import',
    text: 'import main from 124',
    files: { 'tooltips/124.json': donor('{{a}{b}}') },
  },
  {
    name: 'nested import',
    text: 'import main from 125',
    files: {
      'tooltips/125.json': donor('import main from 124', 125),
      'tooltips/124.json': donor('{{a}{b}}'),
    },
  },
  {
    name: 'named export',
    text: 'import Values from 124',
    files: {
      'tooltips/124.json': donor('export Values (\n{{a}{b}}\n)'),
    },
  },
  {
    name: 'global import',
    text: 'import main from global',
    files: { 'tooltips/1.json': donor('{{a}{b}}', 1) },
  },
  {
    name: 'global variable',
    text: '#X',
    files: { 'tooltips/2.json': donor('var X = {{a}{b}}', 2) },
  },
  {
    name: 'global title',
    text: '<title See [T] />',
    files: { 'tooltips/3.json': donor('title T (\n{{a}{b}}\n)', 3) },
  },
  {
    name: 'alias import',
    text: 'import main from 456',
    files: { 'tooltips/124.json': donor('{{a}{b}}') },
  },
];
it.each(cases)('refuses push-live and publish before any write: $name', async ({ text, files }) => {
  f.aliases[456] = { to: 124, kind: 'sandbox' };
  f.moveData({ ...files, 'tooltips/123.json': tooltip(text) });
  const before = structuredClone(f.live);
  const response = await f.request('/push-live', 'POST', { hashes: [123] });
  expect(response.status).toBe(422);
  expect(JSON.stringify(await response.json())).toContain(baseEnhancedPublishMessage);
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let now = Date.now();
  let id = '';
  for (let i = 0; i < 10; i++) {
    id = alphabet[now % 32] + id;
    now = Math.floor(now / 32);
  }
  const request = new Request('https://api.example/publish', {
    method: 'POST',
    body: JSON.stringify({
      opId: id + '0000000000000000',
      hashes: [123],
      expected: { 123: 'a'.repeat(64) },
    }),
  });
  await expect(publish(request, new GitHub(f.env), { id: 1, login: 'alice' })).rejects.toThrow(
    baseEnhancedPublishMessage,
  );
  expect(f.live).toEqual(before);
  expect(f.writes).toHaveLength(0);
  expect(f.commits).toHaveLength(0);
});
it('scans every language, including stale translations', async () => {
  const value = tooltip('plain');
  value.text.fr = { ...value.text.en!, text: '{{un}{deux}}' };
  f.moveData({ 'tooltips/123.json': value });
  await expect(refuseBaseEnhanced(new GitHub(f.env), f.dataHead, [123], {})).rejects.toThrow(
    baseEnhancedPublishMessage,
  );
});
it('terminates cycles and missing imports without changing pair-free output', async () => {
  f.moveData({
    'tooltips/123.json': tooltip('import main from 124'),
    'tooltips/124.json': donor('import main from 123\nimport main from 999'),
  });
  await expect(
    refuseBaseEnhanced(new GitHub(f.env), f.dataHead, [123], {}),
  ).resolves.toHaveProperty('size', 2);
});
it('checks new data heads again after a live write race', async () => {
  f.beforeLive = () => f.moveData({ 'tooltips/123.json': tooltip('{{a}{b}}') });
  f.liveRaces = 1;
  const response = await f.request('/push-live', 'POST', { hashes: [123] });
  expect(response.status).toBe(422);
  expect(f.writes).toHaveLength(0);
});
it('allows saving native pairs without lowering them', async () => {
  const value = tooltip('{{a}{b}}');
  const response = await f.request('/save', 'POST', {
    changes: [{ hash: 123, base: tooltip(), next: value }],
    message: 'Native markup',
  });
  expect(response.status).toBe(200);
  expect(f.current()['tooltips/123.json']).toMatchObject({ text: { en: { text: '{{a}{b}}' } } });
});

it('preserves recording budget after a wide import graph falls back from GraphQL', async () => {
  f.largeFile = true;
  f.truncateGraphql = true;
  const files: Record<string, unknown> = {};
  const imports: string[] = [];
  for (let index = 0; index < 29; index++) {
    const hash = 1000 + index;
    imports.push(`import main from ${hash}`);
    files[`tooltips/${hash}.json`] = donor(`Donor ${index}`, hash);
  }
  f.moveData({ ...files, 'tooltips/123.json': tooltip(imports.join('\n')) });
  const response = await f.request('/push-live', 'POST', { hashes: [123] });
  expect(response.status).toBe(503);
  expect(f.writes).toHaveLength(0);
  expect(f.commits).toHaveLength(0);
});
