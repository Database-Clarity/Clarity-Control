import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseMarkup, type Tooltip } from '@clarity/core';
import { Fixture, makePrivateKey, tooltip } from './fixture.js';

// The real save route against the local GitHub adapter: element-tagged text is held until both
// exporters lower it, and the decision is made on the merged tooltip.
let key: string;
let fixture: Fixture;
beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(() => {
  fixture = new Fixture(key);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const revision = { updatedAt: '2026-10-02T00:00:00Z', updatedBy: 'bob' };
const save = (base: Tooltip | null, next: Tooltip, user = 1) =>
  fixture.request('/save', 'POST', { changes: [{ hash: 123, base, next }], message: 'Edit' }, user);
const withText = (lang: 'de' | 'fr', text: string, from = tooltip()): Tooltip => ({
  ...from,
  text: { ...from.text, [lang]: { text, ...revision } },
});

describe('save hold for element-tagged text', () => {
  it('refuses a tagged span in English with a clear 422 and writes nothing', async () => {
    const response = await save(tooltip(), tooltip('Gain <solar Scorch /> stacks.'));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: `Tooltip 123 (en) contains element-tagged text "<solar Scorch />", which can't be saved yet: apps would show only the icon. Write "<solar/>Scorch" for now.`,
    });
    expect(fixture.commits).toHaveLength(0);
  });

  it('refuses a tagged span in a translation, from a translator too', async () => {
    const next = withText('de', 'Erhalte <solar Versengen />.');
    const response = await save(tooltip(), next, 4);
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain('Tooltip 123 (de)');
    expect(fixture.commits).toHaveLength(0);
  });

  it('refuses a tag already at the head in a language the change does not edit', async () => {
    const head = withText('fr', 'Gagne <arc Choc />.');
    fixture.moveData({ 'tooltips/123.json': head });
    const response = await save(tooltip(), tooltip('mine'));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain('Tooltip 123 (fr)');
    expect(fixture.commits).toHaveLength(0);
  });

  it('saves when the merge drops the tag the client still had in an unchanged language', async () => {
    // The head removed the French tag; the client's base and next still carry it untouched.
    const base = withText('fr', 'Gagne <arc Choc />.');
    fixture.moveData({ 'tooltips/123.json': withText('fr', 'Gagne <arc/>Choc.') });
    const next = withText('fr', 'Gagne <arc Choc />.', tooltip('mine'));
    const response = await save(base, next);
    expect(response.status).toBe(200);
    expect((await response.json()).tooltips[0].text).toMatchObject({
      en: { text: 'mine' },
      fr: { text: 'Gagne <arc/>Choc.' },
    });
    expect(fixture.commits).toHaveLength(1);
  });

  it('refuses the whole batch when one tooltip carries a tag', async () => {
    const response = await fixture.request('/save', 'POST', {
      changes: [
        { hash: 123, base: tooltip(), next: tooltip('mine') },
        { hash: 124, base: null, next: { ...tooltip('<void Void Breach />'), hash: 124 } },
      ],
      message: 'Edit',
    });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain('Tooltip 124 (en)');
    expect(fixture.commits).toHaveLength(0);
  });

  it('saves untagged text, lowered pairs, standalone icons, and invalid forms as before', async () => {
    const text = 'Gain <solar/>Scorch, <solar /> and <solar  /> stacks, <solar a [b] />.';
    const response = await save(tooltip(), tooltip(text));
    expect(response.status).toBe(200);
    expect((await response.json()).tooltips[0].text.en.text).toBe(text);
    expect(fixture.commits).toHaveLength(1);
  });

  // Output review repros: preparation assembles '<solar Scorch />' from pieces. No document holds
  // a tagged span, so the hold has nothing to refuse, and the editor draws exactly what consumers
  // draw today (the bare icon): what is saved never renders tagged.
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

describe('export hold for element-tagged text (push-live)', () => {
  // Tags can only reach the data outside /save (which refuses them); push refuses to export them,
  // from the pushed tooltip or any document its text reads, using documents it already loaded.
  const donor = (text: string, hash: number) => ({ ...tooltip(text), hash });
  const cases: { name: string; text: string; files: Record<string, unknown> }[] = [
    { name: 'pushed tooltip', text: 'Gain <solar Scorch />.', files: {} },
    {
      name: 'import',
      text: 'import Main from 124',
      files: { 'tooltips/124.json': donor('export Main (\n<solar Scorch />\n)', 124) },
    },
    {
      name: 'nested import',
      text: 'import main from 125',
      files: {
        'tooltips/125.json': donor('import main from 124', 125),
        'tooltips/124.json': donor('<arc Jolt />', 124),
      },
    },
    {
      name: 'alias import',
      text: 'import main from 456',
      files: { 'tooltips/124.json': donor('<void Volatile />', 124) },
    },
    {
      name: 'global import',
      text: 'import main from global',
      files: { 'tooltips/1.json': donor('<strand Sever />', 1) },
    },
    {
      name: 'global variable',
      text: '#X',
      files: { 'tooltips/2.json': donor('var X = <stasis Slow />', 2) },
    },
    {
      name: 'global title',
      text: '<title See [T] />',
      files: { 'tooltips/3.json': donor('title T (\n<kinetic Kinetic />\n)', 3) },
    },
    { name: 'preview marker', text: 'Gain \uE000Scorch\uE001.', files: {} },
  ];
  it.each(cases)('refuses before any write: $name', async ({ text, files }) => {
    fixture.aliases[456] = { to: 124, kind: 'sandbox' };
    fixture.moveData({ ...files, 'tooltips/123.json': tooltip(text) });
    const before = structuredClone(fixture.live);
    const response = await fixture.request('/push-live', 'POST', { hashes: [123] });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatch(/element-tagged text|U\+E000/);
    expect(fixture.live).toEqual(before);
    expect(fixture.writes).toHaveLength(0);
    expect(fixture.commits).toHaveLength(0);
  });

  it('a German-only imported tag is refused too', async () => {
    const source = donor('export Main (\nplain\n)', 124);
    source.text.de = { text: 'export Main (\n<solar Versengen />\n)', ...revision };
    fixture.moveData({
      'tooltips/124.json': source,
      'tooltips/123.json': tooltip('import Main from 124'),
    });
    const response = await fixture.request('/push-live', 'POST', { hashes: [123] });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain('Tooltip 124 (de)');
  });

  it('pushes untagged text with imports and lowered pairs as before, with the same reads', async () => {
    const files = {
      'tooltips/124.json': donor('export Main (\n<solar/>Scorch\n)', 124),
      'tooltips/123.json': tooltip('import Main from 124\nGain <arc/>Jolt and <solar />.'),
    };
    fixture.moveData(files);
    const response = await fixture.request('/push-live', 'POST', { hashes: [123] });
    expect(response.status).toBe(200);
    expect(fixture.commits).toHaveLength(1);
  });
});
