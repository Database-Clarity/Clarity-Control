// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import type { PendingTooltip } from './model';
import type { Kind } from './kinds';
import { PushConfirm } from './PushConfirm';
import { rowKey } from './globalRows';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute('open');
};

const unit: PendingTooltip = {
  tooltip: { hash: 1, text: {}, associated: [] },
  name: 'Global exports',
  category: 'Globals',
  categoryId: '~globals',
  categoryOrder: 0,
  markerOnly: false,
  isNew: false,
  pushed: 'marker',
};
const rowsOf = (count: number) => {
  const names = ['a', 'b', 'c'].slice(0, count);
  return names.map((name): PendingTooltip => ({
    ...unit,
    name,
    part: {
      kind: 'exports',
      name,
      unit,
      names,
      published: undefined,
      source: { before: {}, after: {} },
    },
  }));
};

it.each<[Kind[], string]>([
  [['Output unchanged', 'Output unchanged'], '1 tooltip with unchanged output goes live'],
  // One file, but "unchanged" holds only when it holds for every row.
  [['Output unchanged', 'Removed'], '1 tooltip with a changed definition goes live'],
  [['Output unchanged', 'Text changed', 'Removed'], '1 tooltip with changed text goes live'],
  [['Output unchanged', 'New'], '1 tooltip with a changed definition goes live'],
  // Its only changed entry being removed does not remove the file.
  [['Removed'], '1 tooltip with a changed definition goes live'],
])('names a globals file once, by what holds for every row: %s', async (words, text) => {
  const rows = rowsOf(words.length);
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <PushConfirm
        entries={[unit]}
        rows={rows}
        kinds={new Map(rows.map((row, index) => [rowKey(row), words[index]]))}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    ),
  );
  expect(host.textContent).toContain(text);
  expect(host.querySelectorAll('li')).toHaveLength(1);
  await act(async () => root.unmount());
  host.remove();
});
