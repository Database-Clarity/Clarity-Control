// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { parseMarkup } from '@clarity/core';
import { markupEntries, rowEntries } from './markupRow/entries';
import { requestItems, suggestContext } from './suggest/source';
import { helpRows } from './help/reference';

describe('base/enhanced insertion scope', () => {
  it.each([true, false])('uses category scope %s in the row, All, and Ctrl+Space', (allowed) => {
    const globals = { variables: '', titles: '', allowBaseEnhanced: allowed };
    const all = markupEntries(globals);
    expect(all.some((entry) => entry.id === 'base-enhanced-pair')).toBe(allowed);
    expect(
      rowEntries(all).some((entry) => entry !== '|' && entry.id === 'base-enhanced-pair'),
    ).toBe(allowed);
    for (const doc of ['', 'base enhanced']) {
      const state = EditorState.create({ doc });
      const items = requestItems(suggestContext(state, true)!, state, globals);
      expect(items.some((item) => item.id === 'snippet:base-enhanced-pair')).toBe(allowed);
    }
    expect(parseMarkup('{{10%}{15%}}', globals).diagnostics).toEqual([]);
  });
  it('still documents the markup', () => {
    expect(helpRows().some((row) => row.id === 'base-enhanced-pair')).toBe(true);
  });
});
