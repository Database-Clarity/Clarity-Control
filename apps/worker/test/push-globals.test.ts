import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { Fixture, makePrivateKey } from './fixture.js';

vi.mock('../../../config/publisher.json', () => ({ default: { enabled: false } }));
let key: string;
beforeAll(async () => {
  key = await makePrivateKey();
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  'globals/sync.json',
  'globals/layout.json',
  'globals/entries/g_partial000.json',
  'globals/live/converter-v2-test.json',
])(
  'refuses the non-atomic fallback writer when %s exists, including partial bootstrap',
  async (path) => {
    const f = new Fixture(key);
    const original = structuredClone(f.live);
    f.moveData({ [path]: { invalid: true } });
    const response = await f.request('/push-live', 'POST', { hashes: [123] });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('dependency-safe publisher');
    expect(f.live).toEqual(original);
    expect(f.writes).toHaveLength(0);
  },
);
it('retains the legacy export when no global metadata is installed', async () => {
  const f = new Fixture(key);
  expect((await f.request('/push-live', 'POST', { hashes: [123] })).status).toBe(200);
  expect(f.live).toMatchObject({ perks: { 123: { editor: { en: { main: 'original' } } } } });
});
