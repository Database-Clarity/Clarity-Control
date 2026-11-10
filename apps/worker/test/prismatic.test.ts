import { afterEach, expect, test, vi } from 'vitest';
import { Fixture, makePrivateKey, tooltip } from './fixture.js';

afterEach(() => vi.unstubAllGlobals());

test('editor validation, Worker save, and push-live preserve prismatic markup', async () => {
  const fixture = new Fixture(await makePrivateKey());
  const base = tooltip();
  const next = tooltip('<prismatic/>Transcendence');
  const changes = [{ hash: 123, base, next }];
  const response = await fixture.request('/save', 'POST', { changes, message: 'Add prismatic' });
  expect(response.status).toBe(200);
  expect(fixture.current()['tooltips/123.json']).toMatchObject(next);
  expect((await fixture.request('/push-live', 'POST', { hashes: [123] })).status).toBe(200);
  expect(fixture.live).toMatchObject({
    perks: {
      123: {
        editor: {
          en: {
            main: '<prismatic/>Transcendence',
            secondary: '<prismatic/>Transcendence',
          },
        },
      },
    },
  });
});
