// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { DraftsContent } from './DraftButton';

vi.mock('../../services/save/SavePanel', () => ({
  SavePanel: ({ children }: { children: React.ReactNode }) => children,
}));

function Where() {
  const { pathname, search } = useLocation();
  return <output>{pathname + search}</output>;
}

it('reopens a draft of an enhanced version on that version, not on its base', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const item = (hash: number, extra = {}) => ({ hash, name: `Perk ${hash}`, ...extra });
  const text = (value: string) =>
    ({
      hash: 11,
      associated: [],
      text: { en: { text: value, updatedAt: '2026-11-01T00:00:00Z' } },
    }) as unknown as Tooltip;
  useDataStore.setState({
    data: {
      categories: [],
      aliases: {},
      items: { 10: item(10), 11: item(11, { baseHash: 10 }) },
      bundle: { tooltips: {} },
    } as unknown as EditorData,
  });
  useDraftStore.setState({ drafts: { 11: { base: text('a'), next: text('b') } } });
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/review']}>
        <Where />
        <DraftsContent onClose={() => {}} />
      </MemoryRouter>,
    ),
  );
  const row = [...host.querySelectorAll<HTMLElement>('button, [role="treeitem"]')].find((node) =>
    node.textContent?.startsWith('Perk 11'),
  )!;
  await act(async () => row.click());
  expect(host.querySelector('output')!.textContent).toBe('/t/10?variant=11');
  await act(async () => root.unmount());
  host.remove();
});
