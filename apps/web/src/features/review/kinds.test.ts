import { describe, expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { compareDiffOutput } from '../history/renderedDiff';
import goldenTricorn from '../history/fixtures/golden-tricorn.json';
import type { EditorData } from '../../stores/data';
import {
  changedLines,
  classifyRows,
  kindCounts,
  kindOf,
  localKind,
  publishedKind,
  textLanguages,
  useKinds,
} from './kinds';
import type { PendingTooltip } from './model';

const globals = { variables: '', titles: '' };
const tooltip = (en: string, extra: Partial<Tooltip> = {}): Tooltip => ({
  hash: 7,
  text: { en: { text: en, updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'fixture' } },
  associated: [],
  ...extra,
});
const entry = (saved: Tooltip, extra: Partial<PendingTooltip> = {}): PendingTooltip => ({
  tooltip: saved,
  name: 'Golden Tricorn',
  category: 'Weapon Perks',
  categoryId: 'weapon-perks',
  categoryOrder: 0,
  markerOnly: false,
  isNew: false,
  pushed: 'marker',
  ...extra,
});
/** The real rendered check for each changed language, as the worker answers it. */
const outputs = (before: Tooltip, after: Tooltip) =>
  textLanguages(before, after).map((lang) =>
    compareDiffOutput(before.text[lang]?.text ?? '', after.text[lang]?.text ?? '', globals),
  );
const kind = (before: Tooltip | null, after: Tooltip) =>
  publishedKind(before, after, before ? outputs(before, after) : []);

describe('row words known without the published text', () => {
  it('names removals, restores, holds, leftovers, and new tooltips at once', () => {
    const saved = tooltip('Text');
    expect(localKind(entry(saved, { inactiveChange: 'remove' }))?.kind).toBe('Removed');
    expect(localKind(entry(saved, { inactiveChange: 'restore' }))?.kind).toBe('Restored');
    expect(localKind(entry(saved, { unpublishable: 'Set bonuses wait.' }))?.kind).toBe('On hold');
    expect(localKind(entry(saved, { markerOnly: true }))?.kind).toBe('Leftover');
    expect(localKind(entry(saved, { isNew: true, pushed: undefined }))?.kind).toBe('New');
    // A published change waits for its published text: never a guess.
    expect(localKind(entry(saved))).toBeUndefined();
    expect(kindOf(entry(saved), undefined, {})).toBeUndefined();
    expect(kindOf(entry(saved), { status: 'loading' }, {})).toBeUndefined();
    expect(kindOf(entry(saved), { status: 'error', error: 'x' }, {})).toBeUndefined();
    expect(kindOf(entry(saved), { status: 'missing' }, {})).toBeUndefined();
    // The server has no published version: new.
    expect(kindOf(entry(saved), { status: 'ready', tooltip: null }, {})?.kind).toBe('New');
  });
});

describe('row words from the published text (real renderer)', () => {
  const before = tooltip(goldenTricorn.before);
  const after = tooltip(goldenTricorn.after);

  it('reads a markup-only migration as no visible change, with its changed lines', () => {
    const result = kind(before, after);
    expect(result).toMatchObject({ kind: 'No visible change' });
    expect(result?.markupLines).toBe(changedLines(goldenTricorn.before, goldenTricorn.after));
    expect(result?.markupLines).toBeGreaterThan(0);
  });

  it('names which perk a text change reaches', () => {
    const enhancedOnly = tooltip(goldenTricorn.after.replace('8 seconds', '9 seconds'));
    expect(kind(after, enhancedOnly)).toMatchObject({
      kind: 'Text changed',
      scope: 'enhanced',
      variants: true,
      languages: ['en'],
    });
    const baseOnly = tooltip(
      goldenTricorn.after.replace(
        'var refresh = refresh the buff duration.',
        'var refresh = renew the buff duration.',
      ),
    );
    expect(kind(after, baseOnly)).toMatchObject({ kind: 'Text changed', scope: 'base' });
    // A text with one form: just "Text changed".
    expect(kind(tooltip('Lasts 2 seconds.'), tooltip('Lasts 3 seconds.'))).toEqual({
      kind: 'Text changed',
      languages: ['en'],
      variants: false,
    });
  });

  it('lists the languages whose rendered text changed', () => {
    const base = tooltip('Same', {
      text: {
        en: { text: 'Same', updatedAt: '', updatedBy: '' },
        de: { text: 'Alt', updatedAt: '', updatedBy: '' },
      },
    });
    const german = structuredClone(base);
    german.text.de!.text = 'Neu';
    expect(kind(base, german)).toMatchObject({ kind: 'Text changed', languages: ['de'] });
  });

  it('reads links-only and comment-only edits, and lets a text change win', () => {
    const saved = tooltip('Same');
    expect(kind(saved, { ...saved, associated: [1596513538] })?.kind).toBe('Links changed');
    expect(kind(saved, { ...saved, custom: { categoryId: 'effects' } } as Tooltip)?.kind).toBe(
      'Links changed',
    );
    expect(kind(tooltip('Same\n// old'), tooltip('Same\n// new'))).toMatchObject({
      kind: 'No visible change',
      markupLines: 1,
    });
    expect(kind(saved, tooltip('Different', { associated: [1] }))?.kind).toBe('Text changed');
    expect(kind(null, saved)?.kind).toBe('New');
  });

  it('leaves the row without a word when the rendered check failed', () => {
    expect(publishedKind(tooltip('a'), tooltip('b'), [undefined])).toBeUndefined();
  });

  it('classifies in the background and keeps the result for exactly that text', async () => {
    const saved = tooltip(goldenTricorn.after);
    const row = entry(saved);
    const published = { status: 'ready' as const, tooltip: before };
    const data = {
      bundle: { tooltips: { 7: saved } },
      items: {},
      aliases: {},
      categories: [],
    } as unknown as EditorData;
    useKinds.setState({ byHash: {} });
    classifyRows([{ entry: row, published }], data);
    await expect
      .poll(() => kindOf(row, published, useKinds.getState().byHash)?.kind)
      .toBe('No visible change');
    // A newer saved text is not the classified one: unknown until it is checked again.
    const newer = entry(tooltip(goldenTricorn.after + '\nMore'));
    expect(kindOf(newer, published, useKinds.getState().byHash)).toBeUndefined();
  });
});

it('keeps the answer for the latest imports when they change during a running check', async () => {
  // Code review 1 finding 1: hash 7 shows hash 8's text; hash 8 changes while 7 is checked.
  const published = { status: 'ready' as const, tooltip: tooltip('Old') };
  const saved = tooltip('import main from 8');
  const row = entry(saved);
  const snapshot = (text: string) =>
    ({
      bundle: { tooltips: { 7: saved, 8: { ...tooltip(text), hash: 8 } } },
      items: {},
      aliases: {},
      categories: [],
    }) as unknown as EditorData;
  useKinds.setState({ byHash: {} });
  classifyRows([{ entry: row, published }], snapshot('Old'));
  classifyRows([{ entry: row, published }], snapshot('New'));
  await expect
    .poll(() => kindOf(row, published, useKinds.getState().byHash)?.kind)
    .toBe('Text changed');
  // The older check finished too, and never replaced the newer answer.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(kindOf(row, published, useKinds.getState().byHash)?.kind).toBe('Text changed');
});

it('counts a publish by kind, with the Oxford comma', () => {
  expect(kindCounts(['New', 'New', 'No visible change'])).toBe(
    '2 new tooltips and 1 with no visible change',
  );
  expect(kindCounts(['Text changed', 'New', 'Removed'])).toBe(
    '1 new tooltip, 1 with changed text, and 1 removed',
  );
  expect(kindCounts(['Text changed', 'Text changed'])).toBe('2 tooltips with changed text');
  expect(kindCounts(['New'])).toBe('1 new tooltip');
  expect(kindCounts([undefined, undefined])).toBe('2 tooltips not checked yet');
});
