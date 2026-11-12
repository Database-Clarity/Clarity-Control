import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
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
});
