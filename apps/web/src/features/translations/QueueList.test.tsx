// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { it, expect, vi } from 'vitest';
import { QueueList, type ListRow } from './QueueList';
vi.mock('../queue/WorklistsMenu', () => ({
  AddToWorklist: ({ items }: { items: ListRow[] }) => (
    <button data-added={items[0]?.hash}>Add selected to worklist</button>
  ),
}));
it('binds Add and rendered selection to the same id after live shrink and reorder (F5)', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const rows = [1, 2, 3].map((hash) => ({ hash, key: String(hash), name: String(hash) }));
  const show = (rows: ListRow[]) =>
    act(async () =>
      root.render(
        <MemoryRouter>
          <QueueList
            rows={rows}
            signature="same-filter"
            label="Rows"
            linkTo={(row) => ({ to: `/t/${row.hash}`, state: null })}
            secondary={() => ''}
            rowState={() => ({ text: '', state: '' })}
          />
        </MemoryRouter>,
      ),
    );
  try {
    await show(rows);
    await act(async () => host.querySelectorAll<HTMLAnchorElement>('a')[2]!.focus());
    expect(host.querySelector('button')?.getAttribute('data-added')).toBe('3');
    await show(rows.slice(0, 2));
    expect(host.querySelector('a[data-selected]')?.getAttribute('href')).toBe('/t/2');
    expect(host.querySelector('button')?.getAttribute('data-added')).toBe('2');
    await show([rows[1]!, rows[0]!]);
    expect(host.querySelector('a[data-selected]')?.getAttribute('href')).toBe('/t/2');
    expect(host.querySelector('button')?.getAttribute('data-added')).toBe('2');
    await show([]);
    expect(host.querySelector('button')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
