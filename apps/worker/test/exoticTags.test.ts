import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import publisherConfig from '../../../config/publisher.json';
import { needsLowering } from '../src/elementTags.js';
import { Fixture, makePrivateKey, tooltip } from './fixture.js';

let key: string;
let fixture: Fixture;
const oldPin = {
  sourceSha: 'a'.repeat(40),
  sha256: 'b'.repeat(64),
  capabilities: ['elementTags', 'markupBraces', 'prismaticTags', 'arrowSymbol'],
};
const capable = { ...oldPin, capabilities: [...oldPin.capabilities, 'exoticTags'] };
const german = (text: string, from = tooltip()): Tooltip => ({
  ...from,
  text: {
    ...from.text,
    de: {
      text,
      updatedAt: '2026-10-02T00:00:00Z',
      updatedBy: 'bob',
      sourceUpdatedAt: from.text.en!.updatedAt,
    },
  },
});
const save = (base: Tooltip, next: Tooltip) =>
  fixture.request('/save', 'POST', { changes: [{ hash: 123, base, next }], message: 'Edit' });
beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(() => {
  publisherConfig.enabled = true;
  fixture = new Fixture(key);
});
afterEach(() => {
  publisherConfig.enabled = false;
  vi.unstubAllGlobals();
});

it.each([
  '<exotic Gjallarhorn />',
  '<exotic/>Line',
  '<exo/* keep */tic Gjallarhorn />',
  '<exotic/* keep *//>Line',
])('refuses %s with an old or absent installed publisher PIN', async (text) => {
  const next = tooltip(text);
  expect(needsLowering(next)).toBe(true);
    for (const pin of [undefined, oldPin]) {
      if (pin) fixture.moveData({ '.publisher/PIN': pin });
    const response = await save(tooltip(), next);
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain('exoticTags');
  }
  expect(fixture.commits).toHaveLength(0);
});

it('accepts English and translation Exotic text with a capable installed PIN', async () => {
  fixture.moveData({ '.publisher/PIN': capable });
  const next = german('<exotic Deutsche Wörter />', tooltip('<exotic Gjallarhorn />'));
  const response = await save(tooltip(), next);
  expect(response.status).toBe(200);
  expect((await response.json()).tooltips[0].text.de.text).toBe('<exotic Deutsche Wörter />');
});

it('checks an unchanged head translation carried into the real save merge', async () => {
  fixture.moveData({
    'tooltips/123.json': german('<exo/* keep */tic Wörter />'),
    '.publisher/PIN': oldPin,
  });
  const refused = await save(tooltip(), tooltip('mine'));
  expect(refused.status).toBe(422);
  expect((await refused.json()).error).toContain('exoticTags');
  expect(fixture.commits).toHaveLength(0);
  fixture.moveData({ '.publisher/PIN': capable });
  expect((await save(tooltip(), tooltip('mine'))).status).toBe(200);
});

it('retains yellow alias acceptance with no installed capability', async () => {
  expect(needsLowering(tooltip('<yellow Gjallarhorn />'))).toBe(false);
  expect((await save(tooltip(), tooltip('<yellow Gjallarhorn />'))).status).toBe(200);
});

it('uses the updated Worker exporter when the publisher is disabled', async () => {
  publisherConfig.enabled = false;
  const text = '<exo/* keep */tic Gjallarhorn />';
  expect((await save(tooltip(), tooltip(text))).status).toBe(200);
  expect((await fixture.request('/push-live', 'POST', { hashes: [123] })).status).toBe(200);
  expect(JSON.stringify(fixture.live)).toContain('<yel/* keep */low Gjallarhorn />');
  expect(JSON.stringify(fixture.live)).not.toContain('<exo');
});
