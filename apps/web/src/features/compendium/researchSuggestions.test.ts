import { afterEach, expect, it, vi } from 'vitest';
import { researchSuggestions, warmResearchSuggestions } from './researchSuggestions';
import * as progress from './reviewProgress';
import { suggestionAnchor } from './suggestions';
import hints from './research-hints.json';
import { compendiumDataSchema, type CompendiumData } from '@clarity/core';
import capturedWindow from './fixtures/research-window.json';
const cell = (plain: string) => ({ plain, runs: [{ text: plain }] });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const data: CompendiumData = {
  fetchedAt: '2026-10-31T00:00:00Z',
  tabs: [
    {
      gid: '1662574278',
      name: 'Weapon Perks',
      rows: [],
      grid: [{ row: 300, col: 0, cell: cell('Enhanced Range') }],
    },
  ],
};
it('offers dated human proposals by identity, follows moved anchors and warns on changed evidence', () => {
  const suggestions = researchSuggestions(299264772, data, 'weapon-mod', 'Adept Range');
  expect(suggestions[0]).toMatchObject({
    anchor: { row: 300, col: 0 },
    stale: true,
    observedAt: hints.observedAt,
  });
  expect(suggestions[0].rationale).toContain('confirm scope');
  expect(suggestionAnchor(data.tabs[0], suggestions[0])?.name).toBe('Enhanced Range');
  const moved = structuredClone(data);
  moved.tabs[0].grid![0].row += 10;
  expect(researchSuggestions(299264772, moved, 'weapon-mod', 'Adept Range')[0].anchor?.row).toBe(
    310,
  );
  const duplicate = structuredClone(data);
  duplicate.tabs[0].grid!.push({ row: 301, col: 0, cell: cell('Enhanced Range') });
  expect(researchSuggestions(299264772, duplicate, 'weapon-mod', 'Adept Range')[0]).toMatchObject({
    stale: true,
  });
  expect(
    researchSuggestions(299264772, duplicate, 'weapon-mod', 'Adept Range')[0].anchor,
  ).toBeUndefined();
});
it('keeps unknown component sections unknown and retains description availability as navigation only', () => {
  const result = researchSuggestions(1002206008, data, 'weapon-perk', 'Steady Rounds');
  expect(result[0].section).toBeUndefined();
  expect(result[0].rationale).toContain('component-specific section not located');
  expect(result[0].rationale).toContain('full search');
});
it('invalidates changed item identity and keeps every unresolved research record traceable', () => {
  expect(
    researchSuggestions(299264772, data, 'weapon-mod', 'Different name')[0].observedAt,
  ).toBeUndefined();
  expect(Object.keys(hints.entries)).toHaveLength(523); // 571 minus 48 bounded rules
  for (const e of Object.values(hints.entries))
    for (const index of e.places) expect(hints.places[index]).toBeDefined();
});
import { importContext } from './importContext';
it('exposes missing and cyclic authored imports without changing the text', () => {
  const source = 'import main from 1';
  const tooltip = {
    hash: 1,
    text: {
      en: { text: 'import main from 1', updatedAt: '2026-10-31T00:00:00Z', updatedBy: 'audit' },
    },
    associated: [],
  };
  expect(importContext(source, { '1': tooltip }, {}).join('\n')).toContain('cyclic dependency');
  expect(importContext(source, {}, {})).toEqual(['Import 1:\nMissing English source.']);
  expect(tooltip.text.en.text).toBe(source);
});

it('keeps captured evidence current through schema loading but detects actual text and style changes', () => {
  const raw = capturedWindow as CompendiumData;
  const loaded = compendiumDataSchema.parse(capturedWindow);
  const hint = (value: CompendiumData) =>
    researchSuggestions(299264772, value, 'weapon-mod', 'Adept Range')[0];
  expect(hint(raw).stale).toBe(false);
  expect(hint(loaded).stale).toBe(false);
  const moved = structuredClone(loaded);
  for (const tab of moved.tabs) {
    for (const cell of tab.grid ?? []) cell.row += 3;
    for (const row of tab.rows) {
      row.rowIndex += 3;
      if (row.anchor) row.anchor.row += 3;
    }
  }
  expect(hint(moved).stale).toBe(false);
  const textChange = structuredClone(loaded);
  textChange.tabs[0].grid![0].cell.runs[0].text += ' updated';
  expect(hint(textChange).stale).toBe(true);
  const styleChange = structuredClone(loaded);
  const run = styleChange.tabs[0].grid![0].cell.runs[0];
  if (run.bold) delete run.bold;
  else run.bold = true;
  expect(hint(styleChange).stale).toBe(true);
});

it('reuses source proofs without sharing mutable caller results, and refreshes a new source revision', () => {
  const source = structuredClone(capturedWindow) as CompendiumData;
  const fingerprint = vi.spyOn(progress, 'sourceFingerprint');
  const first = researchSuggestions(299264772, source, 'weapon-mod', 'Adept Range')[0];
  const count = fingerprint.mock.calls.length;
  expect(count).toBeGreaterThan(0);
  first.rationale = 'Caller edit';
  first.anchor!.row += 100;
  const second = researchSuggestions(299264772, source, 'weapon-mod', 'Adept Range')[0];
  expect(second.rationale).not.toBe('Caller edit');
  expect(second.anchor!.row).toBe(first.anchor!.row - 100);
  expect(fingerprint).toHaveBeenCalledTimes(count);
  const changed = structuredClone(source);
  changed.tabs[0].grid![0].cell.runs[0].text += ' changed';
  expect(researchSuggestions(299264772, changed, 'weapon-mod', 'Adept Range')[0].stale).toBe(true);
  expect(fingerprint.mock.calls.length).toBeGreaterThan(count);
});

it('pauses source-proof preparation for input, cancels pending work, and preserves foreground results', () => {
  let serial = 0,
    input = true;
  const pending = new Map<number, IdleRequestCallback>();
  vi.stubGlobal('scheduler', undefined);
  vi.stubGlobal('navigator', { scheduling: { isInputPending: () => input } });
  vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
    pending.set(++serial, callback);
    return serial;
  });
  vi.stubGlobal('cancelIdleCallback', (id: number) => pending.delete(id));
  const source = structuredClone(capturedWindow) as CompendiumData;
  const fingerprint = vi.spyOn(progress, 'sourceFingerprint');
  const tick = () => {
    const [id, callback] = pending.entries().next().value!;
    pending.delete(id);
    callback({ didTimeout: false, timeRemaining: () => 20 });
  };
  const cancel = warmResearchSuggestions(source);
  tick();
  expect(fingerprint).not.toHaveBeenCalled();
  cancel();
  expect(pending.size).toBe(0);
  input = false;
  warmResearchSuggestions(source);
  let ticks = 0;
  while (pending.size && ++ticks < 100) tick();
  expect(pending.size).toBe(0);
  const count = fingerprint.mock.calls.length;
  expect(count).toBeGreaterThan(0);
  expect(researchSuggestions(299264772, source, 'weapon-mod', 'Adept Range')[0].stale).toBe(false);
  expect(fingerprint).toHaveBeenCalledTimes(count);
});
