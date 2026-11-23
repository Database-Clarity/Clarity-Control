// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import { useMarksStore } from '../marks/store';
import type { QueueRow } from './queueRows';
import { EarlierChoices } from './SharedDecisionNotices';
import { useSharedSaves } from './sharedDecisions';

it('leaves earlier choices that now have a match unticked, and saves only the ticked ones', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // Saving stays in flight: what is sent is what is pending.
  useMarksStore.setState({ writable: true, save: () => new Promise(() => {}) });
  useSharedSaves.setState({ pending: new Map(), error: null });
  const row = (hash: number, matches?: true): QueueRow => ({
    hash,
    name: `Entry ${hash}`,
    category: 'a',
    kind: 'not-needed',
    excluded: 'local',
    ...(matches ? { matches } : {}),
  });
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() =>
    root.render(
      <MemoryRouter>
        <EarlierChoices rows={[row(1), row(2, true), row(3)]} />
      </MemoryRouter>,
    ),
  );
  const boxes = [...host.querySelectorAll<HTMLInputElement>('input')];
  const save = host.querySelector('button')!;
  expect(boxes.map((box) => box.checked)).toEqual([true, false, true]);
  expect(host.textContent).toContain('matched now');
  expect(save.textContent).toBe('Save 2 earlier Not needed choices for everyone');
  act(() => boxes[0].click());
  act(() => boxes[2].click());
  expect(save.disabled).toBe(true);
  act(() => boxes[2].click());
  expect(save.textContent).toBe('Save 1 earlier Not needed choice for everyone');
  expect(useSharedSaves.getState().pending.size).toBe(0);
  act(() => save.click());
  expect([...useSharedSaves.getState().pending]).toEqual([[3, 'not-needed']]);
  act(() => root.unmount());
});
