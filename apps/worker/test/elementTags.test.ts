import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseMarkup, type Tooltip } from '@clarity/core';
import publisherConfig from '../../../config/publisher.json';
import { Fixture, makePrivateKey, tooltip } from './fixture.js';

// The real save and push routes against the local GitHub adapter: element-tagged text saves while
// the live exporter lowers it, push-live exports it lowered, and every decision is made on the
// merged tooltip.
let key: string;
let fixture: Fixture;
beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(() => {
  fixture = new Fixture(key);
});
afterEach(() => {
  publisherConfig.enabled = false;
  vi.unstubAllGlobals();
});

const revision = { updatedAt: '2026-10-02T00:00:00Z', updatedBy: 'bob' };
const save = (base: Tooltip | null, next: Tooltip, user = 1) =>
  fixture.request('/save', 'POST', { changes: [{ hash: 123, base, next }], message: 'Edit' }, user);
const withText = (lang: 'de' | 'fr', text: string, from = tooltip()): Tooltip => ({
  ...from,
  text: { ...from.text, [lang]: { text, ...revision } },
});
const pin = { sourceSha: 'a'.repeat(40), sha256: 'b'.repeat(64) };
const capable = { ...pin, capabilities: ['elementTags'] };

describe('save guard for element-tagged text', () => {
  // While the publisher switch is off, the live exporter is push-live, which lowers tagged text
  // (core exportLegacy): tags save. Once the publisher exports, its build at the data head must
  // declare the elementTags capability in .publisher/PIN.
  it('saves a tagged span in English while push-live exports, exactly as written', async () => {
    const text = 'Gain <solar Scorch /> stacks.';
    const response = await save(tooltip(), tooltip(text));
    expect(response.status).toBe(200);
    expect((await response.json()).tooltips[0].text.en.text).toBe(text);
    expect(fixture.commits).toHaveLength(1);
  });

  it('saves a tagged span in a translation, from a translator too', async () => {
    const response = await save(tooltip(), withText('de', 'Erhalte <solar Versengen />.'), 4);
    expect(response.status).toBe(200);
    expect(fixture.commits).toHaveLength(1);
  });

  it('still refuses authored preview markers (U+E000, U+E001) in any language', async () => {
    const response = await save(tooltip(), withText('fr', 'Gagne \uE000Choc\uE001.'));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain('Tooltip 123 (fr)');
    expect(fixture.commits).toHaveLength(0);
  });

  it('publisher on: refuses tags when the PIN at the data head lacks the capability', async () => {
    publisherConfig.enabled = true;
    fixture.moveData({ '.publisher/PIN': pin });
    const response = await save(tooltip(), tooltip('Gain <solar Scorch /> stacks.'));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe(
      `Tooltip 123 (en) contains element-tagged text "<solar Scorch />", which can't be saved: the publisher installed in the data branch does not lower it yet (.publisher/PIN lacks the "elementTags" capability). Write "<solar/>Scorch" for now.`,
    );
    expect(fixture.commits).toHaveLength(0);
  });

  it('publisher on: refuses tags when there is no PIN at all', async () => {
    publisherConfig.enabled = true;
    const response = await save(tooltip(), withText('de', 'Erhalte <solar Versengen />.'));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain('Tooltip 123 (de)');
    expect(fixture.commits).toHaveLength(0);
  });

  it('publisher on: saves tags when the PIN declares elementTags, with no extra read', async () => {
    publisherConfig.enabled = true;
    fixture.moveData({ '.publisher/PIN': capable });
    const plainStart = fixture.graphqlCalls;
    expect((await save(tooltip(), tooltip('plain'))).status).toBe(200);
    const plain = fixture.graphqlCalls - plainStart;
    fixture.moveData({ 'tooltips/123.json': tooltip('plain') });
    const taggedStart = fixture.graphqlCalls;
    const response = await save(tooltip('plain'), tooltip('Gain <solar Scorch /> stacks.'));
    expect(response.status).toBe(200);
    // The PIN rides in the batched tooltip read: a tagged save costs what an untagged one does.
    expect(fixture.graphqlCalls - taggedStart).toBe(plain);
  });

  it('publisher on: a tag already at the head in an unchanged language needs the capability', async () => {
    publisherConfig.enabled = true;
    fixture.moveData({
      'tooltips/123.json': withText('fr', 'Gagne <arc Choc />.'),
      '.publisher/PIN': pin,
    });
    const refused = await save(tooltip(), tooltip('mine'));
    expect(refused.status).toBe(422);
    expect((await refused.json()).error).toContain('Tooltip 123 (fr)');
    fixture.moveData({ '.publisher/PIN': capable });
    expect((await save(tooltip(), tooltip('mine'))).status).toBe(200);
  });

  it('publisher on: untagged saves never depend on the PIN', async () => {
    publisherConfig.enabled = true;
    expect((await save(tooltip(), tooltip('Gain <solar/>Scorch.'))).status).toBe(200);
  });

  it('saves untagged text, lowered pairs, standalone icons, and invalid forms as before', async () => {
    const text = 'Gain <solar/>Scorch, <solar /> and <solar  /> stacks, <solar a [b] />.';
    const response = await save(tooltip(), tooltip(text));
    expect(response.status).toBe(200);
    expect((await response.json()).tooltips[0].text.en.text).toBe(text);
    expect(fixture.commits).toHaveLength(1);
  });

  // Output review repros (part 1): preparation assembles '<solar Scorch />' from pieces. No
  // document holds a tagged span, and the editor draws exactly what consumers draw today (the bare
  // icon): what is saved never renders tagged.
  it.each([
    'var open = <solar\n#open Scorch />',
    '<so\rlar Scorch />',
    '<so/* comment */lar Scorch />',
    '<so<pve/>lar Scorch />',
  ])('saves %j, which renders as today and never tagged', async (text) => {
    const response = await save(tooltip(), tooltip(text));
    expect(response.status).toBe(200);
    const saved: string = (await response.json()).tooltips[0].text.en.text;
    expect(saved).toBe(text);
    expect(JSON.stringify(parseMarkup(saved).lines)).not.toContain('elementText');
  });
});

describe('push-live lowers element-tagged text (hold lifted)', () => {
  // exportLegacy lowers every tagged span to today's `<solar/>Scorch`: the live entry is exactly
  // what the lowered form, written by hand, exports.
  const donor = (text: string, hash: number) => ({ ...tooltip(text), hash });
  type Live = {
    perks: Record<string, { editor: Record<string, { main: string; secondary: string }> }>;
  };
  const exported = (hash: number, lang = 'en') => (fixture.live as Live).perks[hash]!.editor[lang]!;
  const unlowered = /<(?:kinetic|arc|solar|void|stasis|strand) [^<>]*\/>|[\uE000\uE001]/;

  it.each([
    ['Gain <solar Scorch />.', 'Gain <solar/>Scorch.'],
    ['<arc Jolt /> and <void Volatile Rounds />', '<arc/>Jolt and <void/>Volatile Rounds'],
    ['Gain <kinetic  Kinetic  />', 'Gain <kinetic/> Kinetic '],
    ['<pve/>Applies <stasis Slow />.', '<pve/>Applies <stasis/>Slow.'],
  ])('pushes %j as %j', async (text, lowered) => {
    fixture.moveData({ 'tooltips/123.json': tooltip(text) });
    const response = await fixture.request('/push-live', 'POST', { hashes: [123] });
    expect(response.status).toBe(200);
    expect(exported(123)).toEqual({ main: lowered, secondary: lowered });
    expect(JSON.stringify(fixture.live)).not.toMatch(unlowered);
  });

  it('pushes a tagged import and the tooltip that imports it, both lowered', async () => {
    fixture.moveData({
      'tooltips/124.json': donor('export Main (\n<solar Scorch />\n)', 124),
      'tooltips/123.json': tooltip('import Main from 124'),
    });
    fixture.extraItems = { 124: { hash: 124, name: 'Donor', categoryId: 'perk', itemHash: 222 } };
    expect((await fixture.request('/push-live', 'POST', { hashes: [124, 123] })).status).toBe(200);
    expect(exported(124).main).toBe('export Main (\n<solar/>Scorch\n)');
    expect(JSON.stringify(fixture.live)).not.toMatch(unlowered);
  });

  it('a German-only tag is lowered in German and English stays as written', async () => {
    const source = tooltip('Gain <solar/>Scorch.');
    source.text.de = { text: 'Erhalte <solar Versengen />.', ...revision };
    fixture.moveData({ 'tooltips/123.json': source });
    expect((await fixture.request('/push-live', 'POST', { hashes: [123] })).status).toBe(200);
    expect(exported(123, 'de').main).toBe('Erhalte <solar/>Versengen.');
    expect(exported(123).main).toBe('Gain <solar/>Scorch.');
  });

  it('still refuses a preview marker in the pushed text before any write', async () => {
    fixture.moveData({ 'tooltips/123.json': tooltip('Gain \uE000Scorch\uE001.') });
    const before = structuredClone(fixture.live);
    const response = await fixture.request('/push-live', 'POST', { hashes: [123] });
    expect(response.status).toBe(422);
    expect(fixture.live).toEqual(before);
    expect(fixture.writes).toHaveLength(0);
    expect(fixture.commits).toHaveLength(0);
  });

  it('pushes untagged text with imports and lowered pairs as before', async () => {
    fixture.moveData({
      'tooltips/124.json': donor('export Main (\n<solar/>Scorch\n)', 124),
      'tooltips/123.json': tooltip('import Main from 124\nGain <arc/>Jolt and <solar />.'),
    });
    const response = await fixture.request('/push-live', 'POST', { hashes: [123] });
    expect(response.status).toBe(200);
    expect(fixture.commits).toHaveLength(1);
  });
});
