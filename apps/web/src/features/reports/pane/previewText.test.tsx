// @vitest-environment jsdom
import { displayRevision, displayText, type MarkupGlobals } from '@clarity/core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkupSnippet } from '../../preview/TooltipPreview';
import type { PaneReport } from './api';
import { mapRenderedText, rangeFor, resolveNote } from './previewText';

let host: HTMLDivElement;
let root: Root;
const globals: MarkupGlobals = {
  variables: '',
  titles: '<title Scorch [Burn damage over time.] />',
};

function renderText(text: string) {
  act(() => root.render(<MarkupSnippet text={text} lang="en" globals={globals} />));
  return host.firstElementChild!;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const samples = [
  'Collecting Elemental Pickups or destroying a <strand/>Tangle grants Energy.\n• <arc/>Ionic Traces: <yellow 7.5% Light />',
  '<solar/>🡅 <bold Café /> stacks x3\n\nAfter a gap',
  'Deals <title Scorch /> damage',
  '< table >\n| Stat | Value\n| Range | 10\n<$>\nAfter the table',
];

describe('rendered preview text map', () => {
  it.each(samples)('reads the same display text as core displayText: %s', (text) => {
    const element = renderText(text);
    expect(mapRenderedText(element).text).toBe(displayText(text, globals));
  });

  it('places a quote range on the rendered nodes, across spans and icons', async () => {
    const text = samples[0]!;
    const element = renderText(text);
    const map = mapRenderedText(element);
    const exact = 'Ionic Traces: 7.5% Light';
    const start = map.text.indexOf(exact);
    const range = rangeFor(map, start, start + exact.length)!;
    expect(range.toString()).toBe(exact);
    // Out of bounds or empty: nothing.
    expect(rangeFor(map, 5, 5)).toBeNull();
    expect(rangeFor(map, 0, map.text.length + 3)).toBeNull();
  });

  it('resolves notes exactly, moved after an edit, stale when the words are gone', async () => {
    const before = displayText(samples[0]!, globals);
    const rev = await displayRevision(before);
    const exact = '7.5% Light';
    const start = before.indexOf(exact);
    const note = {
      n: 1,
      category: 'wrong-value',
      text: 'Is 10%',
      exact,
      prefix: before.slice(Math.max(0, start - 32), start),
      suffix: before.slice(start + exact.length, start + exact.length + 32),
      start,
      end: start + exact.length,
      line: 1,
      whole: 0,
      rev,
    };
    const report = { rev } as PaneReport;
    expect(resolveNote(before, rev, report, note)).toEqual({
      kind: 'exact',
      start,
      end: start + exact.length,
    });
    const edited = `New first line\n${before}`;
    const movedRev = await displayRevision(edited);
    expect(resolveNote(edited, movedRev, report, note)).toMatchObject({ kind: 'moved' });
    const changed = before.replace(exact, '10% Light');
    expect(resolveNote(changed, await displayRevision(changed), report, note)).toEqual({
      kind: 'stale',
    });
    expect(resolveNote(before, rev, report, { ...note, whole: 1, exact: null })).toEqual({
      kind: 'whole',
    });
  });
});
