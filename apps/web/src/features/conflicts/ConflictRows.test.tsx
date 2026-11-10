// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { describe as describeConflict } from './ConflictRows';
import type { ConflictSession } from '../../stores/conflicts';

it('shows a Compendium link conflict as two sheet locations, never as JSON with a gid', () => {
  const link = (row: number) => ({
    gid: '1662574278',
    rowKey: 'Rampage',
    snapshot: { plain: 'x', runs: [{ text: 'x' }] },
    snapshotAt: '2026-11-01T00:00:00.000Z',
    sourceAnchor: { row, col: 0 },
    cells: [{ dRow: 0, dCol: 2 }],
  });
  const tooltip = (row: number) =>
    ({ hash: 1, associated: [], text: {}, compendium: link(row) }) as unknown as Tooltip;
  const session = { mine: tooltip(5), head: tooltip(9) } as unknown as ConflictSession;
  const text = describeConflict(session, 'compendium', null);
  expect(text.summary).not.toContain('1662574278');
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<>{'detail' in text ? text.detail : null}</>);
  expect(host.textContent).not.toContain('1662574278');
  expect([...host.querySelectorAll('a')].map((a) => a.getAttribute('href')!.split('#')[1])).toEqual(
    ['gid=1662574278&range=C5', 'gid=1662574278&range=C9'],
  );
});
