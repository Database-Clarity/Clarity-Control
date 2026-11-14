// Hold until cut-over (owner 2026-11-11): set bonuses are saved but never pushed live.
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { setBonusHoldMessage, type Tooltip } from '@clarity/core';
import { Fixture, makePrivateKey, tooltip } from './fixture.js';
import { GitHub } from '../src/github.js';
import { publish } from '../src/publish.js';

// The legacy /push-live exporter (switch OFF) under test; the checked-in switch is ON since
// PUB-ENABLE, and these paths stay for the publisher rollback.
vi.mock('../../../config/publisher.json', () => ({ default: { enabled: false } }));

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

const custom: Tooltip = {
  ...tooltip('Set-bonus text'),
  custom: { name: 'Example Set (2 pc): Bonus', categoryId: 'armor-set-bonus' },
};
/** A generator set bonus: item 123 in the `armor-set-bonus` category (no legacy type). */
const generator = () => {
  f.canonicalFacts = { categoryId: 'armor-set-bonus', name: 'Example Set (2 pc): Bonus' };
  f.extraCategories = [{ id: 'armor-set-bonus' }];
};
const publishRequest = (hashes: number[]) => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let now = Date.now();
  let id = '';
  for (let i = 0; i < 10; i++) {
    id = alphabet[now % 32] + id;
    now = Math.floor(now / 32);
  }
  return new Request('https://api.example/publish', {
    method: 'POST',
    body: JSON.stringify({
      opId: id + '0000000000000000',
      hashes,
      expected: Object.fromEntries(hashes.map((hash) => [hash, 'a'.repeat(64)])),
    }),
  });
};

it.each([
  { name: 'generator category', setup: generator, value: tooltip('Set-bonus text') },
  {
    name: 'generator legacy type',
    setup: () => {
      f.canonicalFacts = { categoryId: 'armor-set-bonus' };
      f.extraCategories = [{ id: 'armor-set-bonus', legacyType: 'Armor Set Bonus' }];
    },
    value: tooltip('Set-bonus text'),
  },
  { name: 'custom category', setup: () => {}, value: { ...custom, hash: 900 } },
])('push-live refuses a set bonus before any write: $name', async ({ setup, value }) => {
  setup();
  f.moveData({
    [`tooltips/${value.hash}.json`]: value,
    'tooltips/123.json': value.hash === 123 ? value : tooltip(),
  });
  const before = structuredClone(f.live);
  const response = await f.request('/push-live', 'POST', {
    hashes: [...new Set([123, value.hash])],
  });
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ error: setBonusHoldMessage });
  expect(f.live).toEqual(before);
  expect(f.writes).toHaveLength(0);
  expect(f.commits).toHaveLength(0);
});

it('publish refuses a custom set bonus before signing or writing', async () => {
  f.moveData({ 'tooltips/900.json': { ...custom, hash: 900 } });
  await expect(
    publish(publishRequest([900]), new GitHub(f.env), { id: 1, login: 'alice' }),
  ).rejects.toThrow(setBonusHoldMessage);
  expect(f.writes).toHaveLength(0);
  expect(f.commits).toHaveLength(0);
});

it('other tooltips still push, and importing a set bonus is not a set bonus', async () => {
  f.moveData({
    'tooltips/900.json': { ...custom, hash: 900 },
    'tooltips/123.json': tooltip('import main from 900'),
  });
  const response = await f.request('/push-live', 'POST', { hashes: [123] });
  expect(response.status).toBe(200);
});

it('editors still save set bonuses', async () => {
  generator();
  const response = await f.request('/save', 'POST', {
    changes: [{ hash: 123, base: tooltip(), next: tooltip('Set-bonus text') }],
    message: 'Write set bonus',
  });
  expect(response.status).toBe(200);
  expect(f.current()['tooltips/123.json']).toMatchObject({
    text: { en: { text: 'Set-bonus text' } },
  });
});
