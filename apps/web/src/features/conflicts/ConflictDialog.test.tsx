import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import type { SaveConflict } from '../../services/api';
import { ConflictDialog } from './ConflictDialog';

function tooltip(text: string): Tooltip {
  return {
    hash: 7,
    text: { de: { text, updatedAt: '2026-10-27T00:00:00Z', updatedBy: 'owner' } },
    associated: [],
  };
}

const conflict: SaveConflict = {
  hash: 7,
  fields: ['text.de'],
  base: tooltip('BASE-TEXT'),
  head: tooltip('THEIRS-TEXT'),
  next: tooltip('MINE-TEXT'),
};

describe('ConflictDialog', () => {
  const html = renderToStaticMarkup(
    createElement(ConflictDialog, {
      changes: [],
      conflicts: [conflict],
      onResolve: () => undefined,
      onClose: () => undefined,
    }),
  );

  it('shows Theirs then Mine before Base', () => {
    const theirs = html.indexOf('THEIRS-TEXT');
    const mine = html.indexOf('MINE-TEXT');
    const base = html.indexOf('BASE-TEXT');
    expect(theirs).toBeGreaterThan(-1);
    expect(theirs).toBeLessThan(mine);
    expect(mine).toBeLessThan(base);
    expect(html.indexOf('<h4>Theirs</h4>')).toBeLessThan(html.indexOf('<h4>Mine</h4>'));
    expect(html).not.toContain('<h4>Base</h4>');
  });

  it('keeps Base inside a collapsed details element', () => {
    const inner = '(?:(?!</details>).)*';
    expect(html).toMatch(new RegExp(`<details[^>]*>${inner}BASE-TEXT${inner}</details>`, 's'));
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).not.toMatch(new RegExp(`<details[^>]*>${inner}(THEIRS|MINE)-TEXT`, 's'));
  });

  it('keeps the three decisions and puts the review button in the footer, disabled until resolved', () => {
    expect(html).toContain('Use theirs');
    expect(html).toContain('Use mine');
    expect(html).toContain('Edit merged text');
    expect(html).toMatch(
      /<footer[^>]*><button[^>]*disabled[^>]*>Review resolved changes<\/button>/,
    );
  });
});
