import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import publisherConfig from '../../../config/publisher.json';
import { Fixture, makePrivateKey, tooltip } from './fixture.js';

// Delimited variables (`#{d}`) and the arrow symbol (`<enhanced/>`) on the real save and push
// routes: accepted on save while the live exporter lowers them (core braces.ts), push-live exports
// today's `#d` and `#e`, and once the publisher exports, its PIN must declare `markupBraces`.
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
const pin = { sourceSha: 'a'.repeat(40), sha256: 'b'.repeat(64) };
const capable = { ...pin, capabilities: ['elementTags', 'markupBraces'] };

describe('save guard for #{name} and <enhanced/>', () => {
  it('saves both forms while push-live exports, exactly as written', async () => {
    const text = 'var d = 5\nDeals #{d}x damage.\nenhanced (\n<enhanced/> Faster.\n)';
    const response = await save(tooltip(), tooltip(text));
    expect(response.status).toBe(200);
    expect((await response.json()).tooltips[0].text.en.text).toBe(text);
    expect(fixture.commits).toHaveLength(1);
  });

  it('saves a merged plain reference with a warning, never a block', async () => {
    const response = await save(tooltip(), tooltip('var d = 5\nDeals #dx damage.'));
    expect(response.status).toBe(200);
  });

  it('refuses holder-shaped variable names whatever the exporter (code review MUST-1)', async () => {
    for (const enabled of [false, true]) {
      publisherConfig.enabled = enabled;
      fixture.moveData({ '.publisher/PIN': capable });
      const response = await save(tooltip(), tooltip('var Zb1wx = ORIGINAL\nDeals #Zb1wx.'));
      expect(response.status).toBe(422);
      expect(((await response.json()) as { error: string }).error).toBe(
        'Tooltip 123 (en): #Zb1wx is a reserved name (braces generate names starting Zb<number>w): rename it.',
      );
    }
    expect((await save(tooltip(), tooltip('var Zoom = 2\n#Zoom'))).status).toBe(200);
  });

  it('publisher on: refuses them when the PIN lacks markupBraces', async () => {
    publisherConfig.enabled = true;
    fixture.moveData({ '.publisher/PIN': { ...pin, capabilities: ['elementTags'] } });
    const response = await save(tooltip(), tooltip('var d = 5\nDeals #{d}x.'));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe(
      `Tooltip 123 (en) contains "#{d}", which can't be saved: the publisher installed in the data branch does not lower it yet (.publisher/PIN lacks the "markupBraces" capability). Write #name or #e for now.`,
    );
    const arrow = await save(tooltip(), {
      ...tooltip(),
      text: { ...tooltip().text, de: { text: '<enhanced/> Schneller.', ...revision } },
    });
    expect(arrow.status).toBe(422);
    expect((await arrow.json()).error).toContain('Tooltip 123 (de) contains "<enhanced/>"');
    expect(fixture.commits).toHaveLength(0);
  });

  it('publisher on: saves them when the PIN declares markupBraces', async () => {
    publisherConfig.enabled = true;
    fixture.moveData({ '.publisher/PIN': capable });
    expect((await save(tooltip(), tooltip('var d = 5\n<enhanced/>#{d}x'))).status).toBe(200);
  });

  it('publisher on: the legacy forms never depend on the PIN', async () => {
    publisherConfig.enabled = true;
    expect((await save(tooltip(), tooltip('var d = 5\n#e #d x'))).status).toBe(200);
  });
});

describe('push-live lowers #{name} and <enhanced/>', () => {
  type Live = {
    perks: Record<string, { editor: Record<string, { main: string; secondary: string }> }>;
  };
  const exported = (hash: number) => (fixture.live as Live).perks[hash]!.editor.en!;

  it.each([
    ['Deals #{d} damage.', 'Deals #d damage.'],
    ['enhanced (\n<enhanced/> Faster.\n)', 'enhanced (\n#e Faster.\n)'],
    ['Lasts <enhanced/>${5+#{d}} s.', 'Lasts #e${5+#d} s.'],
    ['var d = 5\nDeals #{d}x.', 'var d = 5\nDeals #d#Zb1wx.\nvar Zb1wx = x'],
  ])('pushes %j as %j', async (text, lowered) => {
    fixture.moveData({ 'tooltips/123.json': tooltip(text) });
    const response = await fixture.request('/push-live', 'POST', { hashes: [123] });
    expect(response.status).toBe(200);
    expect(exported(123)).toEqual({ main: lowered, secondary: lowered });
    expect(JSON.stringify(fixture.live)).not.toMatch(/#\{[a-zA-Z0-9]+\}|<enhanced\/>/);
  });
});
