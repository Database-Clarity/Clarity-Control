// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { useConflictStore } from '../../stores/conflicts';
import { useDraftStore } from '../../stores/drafts';
import { useShellNotices } from './useShellNotices';

const entry = (text: string) => ({
  text,
  updatedAt: '2026-11-03T10:00:00.000Z',
  updatedBy: 'alice',
});
const tooltip = (text: string): Tooltip => ({
  hash: 10,
  text: { en: entry(text) },
  associated: [],
});
const marked = '<<<<<<< mine\nm\n=======\nt\n>>>>>>> theirs';

function Probe() {
  renders++;
  const notices = useShellNotices();
  return createElement(
    'ul',
    null,
    notices.map((notice) =>
      createElement(
        'li',
        { key: notice.id, 'data-id': notice.id },
        notice.text,
        ...(notice.actions ?? []).map((action) =>
          createElement('button', { key: action.label, onClick: action.onClick }, action.label),
        ),
      ),
    ),
  );
}

let host: HTMLDivElement;
let root: Root;
let renders = 0;
const original = useDraftStore.getState();
const ids = () => [...host.querySelectorAll('li')].map((li) => li.getAttribute('data-id'));
const render = () =>
  act(() => root.render(createElement(MemoryRouter, null, createElement(Probe))));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  renders = 0;
  useDraftStore.setState({ drafts: {}, hydrated: true, external: false, error: null, pending: 0 });
  useConflictStore.setState({ scope: '1', sessions: {} });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useDraftStore.setState(original);
  useConflictStore.setState({ scope: null, sessions: {} });
  vi.useRealTimers();
});

describe('conflict notices', () => {
  it('keeps brief draft writes out of shell renders and preserves slow-write and error notices', () => {
    vi.useFakeTimers();
    render();
    const initial = renders;
    for (let i = 0; i < 3; i++) {
      act(() => useDraftStore.setState({ pending: 1 }));
      act(() => vi.advanceTimersByTime(100));
      act(() => useDraftStore.setState({ pending: 0 }));
    }
    expect(renders).toBe(initial);
    expect(ids()).toEqual([]);
    act(() => useDraftStore.setState({ pending: 1 }));
    act(() => vi.advanceTimersByTime(799));
    expect(renders).toBe(initial);
    act(() => vi.advanceTimersByTime(1));
    expect(ids()).toEqual(['draft-saving']);
    act(() => useDraftStore.setState({ pending: 0 }));
    expect(ids()).toEqual([]);
    act(() => useDraftStore.setState({ pending: 1, error: 'Storage failed' }));
    expect(ids()).toEqual(['draft-storage']);
    expect(host.textContent).toContain('Storage failed');
  });

  it('says nothing about text blocks (the editor shows those)', () => {
    useDraftStore.setState({ drafts: { 10: { base: tooltip('a'), next: tooltip(marked) } } });
    render();
    expect(ids()).toEqual([]);
  });

  it('points to the rows when a conflict needs a choice', () => {
    useDraftStore.setState({ drafts: { 10: { base: tooltip('a'), next: tooltip('b') } } });
    useConflictStore.setState({
      sessions: {
        10: {
          hash: 10,
          base: tooltip('a'),
          head: null,
          mine: tooltip('b'),
          rows: { $exists: null },
        },
      },
    });
    render();
    expect(ids()).toEqual(['conflict-rows']);
    expect(host.textContent).toContain('1 conflict needs your choice before saving');
  });

  it('asks Reload or Keep mine when another tab wrote and conflicts are open', () => {
    useDraftStore.setState({
      external: true,
      drafts: { 10: { base: tooltip('a'), next: tooltip(marked) } },
    });
    render();
    expect(ids()).toEqual(['drafts-other-tab']);
    const labels = [...host.querySelectorAll('button')].map((button) => button.textContent);
    expect(labels).toEqual(['Reload', 'Keep mine']);
    // Without an open conflict another tab's write asks nothing.
    act(() => useDraftStore.setState({ drafts: {} }));
    expect(ids()).toEqual([]);
  });

  it('Reload and Keep mine call the draft store', () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    const keep = vi.fn().mockResolvedValue(undefined);
    useDraftStore.setState({
      external: true,
      drafts: { 10: { base: tooltip('a'), next: tooltip(marked) } },
      reloadFromStorage: reload,
      keepMine: keep,
    });
    render();
    const [reloadButton, keepButton] = [...host.querySelectorAll('button')];
    act(() => reloadButton!.click());
    expect(reload).toHaveBeenCalledTimes(1);
    act(() => keepButton!.click());
    expect(keep).toHaveBeenCalledTimes(1);
  });
});
