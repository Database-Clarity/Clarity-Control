import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { Fixture, makePrivateKey } from './fixture.js';
import {
  buildLegacy,
  legacyPresets,
  type LegacyInput,
} from '../../../packages/export/src/index.js';
import { fixtureInput } from '../../../packages/export/test/helpers.js';

vi.mock('../../../config/publisher.json', () => ({ default: { enabled: false } }));
let key: string;
beforeAll(async () => {
  key = await makePrivateKey();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('glossary files never affect push-live or any of the eight consumer files', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-14T12:00:00Z'));
  async function push(withGlossary: boolean) {
    const fixture = new Fixture(key);
    const { input } = fixtureInput();
    fixture.live = {
      perks: Object.fromEntries([1, 2, 3].map((hash) => [hash, input.perks[hash]])),
      databaseSettings: {},
    };
    if (withGlossary)
      fixture.moveData({
        'glossary/de.json': {
          v: 1,
          lang: 'de',
          terms: {
            jolt: {
              en: 'Jolt',
              term: 'DO NOT EXPORT THIS',
              updatedBy: 'alice',
              updatedAt: '2026-11-14T00:00:00Z',
            },
          },
        },
      });
    expect((await fixture.request('/push-live', 'POST', { hashes: [123] })).status).toBe(200);
    return fixture.live as LegacyInput;
  }
  const baseline = await push(false);
  const candidate = await push(true);
  expect(candidate).toEqual(baseline);
  for (const preset of legacyPresets) {
    expect(buildLegacy(candidate, preset), preset).toEqual(buildLegacy(baseline, preset));
    expect(new TextDecoder().decode(buildLegacy(candidate, preset))).not.toContain(
      'DO NOT EXPORT THIS',
    );
  }
});
