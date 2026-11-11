// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { openSearchPanel, search } from '@codemirror/search';
import { findWidgetExtension, findWidgetPanel } from '../findWidget';
import { globalFindExtension } from './host';
import { FindIndex } from './index';
import { useDataStore, type EditorData } from '../../../stores/data';
import type { Tooltip } from '@clarity/core';

it('sweeps entry/category/all, pending/committed query, keyboard/button activation, empty restore, and cancel', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  class WorkerMock {
    index = new FindIndex();
    onmessage?: (event: { data: unknown }) => void;
    postMessage(message: {
      type: string;
      entries: Parameters<FindIndex['update']>[0];
      removed: number[];
      id: number;
      options: Parameters<FindIndex['query']>[0];
    }) {
      if (message.type === 'update') this.index.update(message.entries, message.removed);
      else
        queueMicrotask(() =>
          this.onmessage?.({ data: { id: message.id, ...this.index.query(message.options) } }),
        );
    }
    terminate() {}
  }
  vi.stubGlobal('Worker', WorkerMock);
  const make = (hash: number, categoryId: string): Tooltip => ({
    hash,
    associated: [],
    custom: { name: `Entry ${hash}`, categoryId },
    text: { en: { text: 'cat', updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'test' } },
  });
  const one = make(1, 'a'),
    two = make(2, 'b');
  useDataStore.setState({
    data: {
      bundle: { tooltips: { 1: one, 2: two } },
      categories: [],
      items: {},
      aliases: {},
    } as unknown as EditorData,
  });
  const navigate = vi.fn();
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: 'cat',
      extensions: [
        search({ createPanel: findWidgetPanel }),
        findWidgetExtension,
        globalFindExtension({
          lang: 'en',
          globals: { variables: '', titles: '' },
          selfHash: () => 1,
          sources: () => undefined,
          navigate: () => navigate,
        }),
      ],
    }),
  });
  try {
    await act(async () => {
      openSearchPanel(view);
    });
    const input = view.dom.querySelector<HTMLInputElement>('input[name="search"]')!;
    const type = async (text: string) => {
      await act(async () => {
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    const scope = async (label: string) => {
      await act(async () => {
        [...view.dom.querySelectorAll('button')]
          .find((button) => button.textContent === label)!
          .click();
      });
    };
    await type('cat');
    await scope('Category');
    expect(document.querySelector('[role="dialog"] [role="status"]')?.textContent).toContain(
      'Updating',
    );
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(document.activeElement).toBe(input);
    await scope('All');
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(2);
    await act(async () => {
      const next = view.dom.querySelector<HTMLButtonElement>('button[name="next"]')!;
      next.focus();
      next.click();
    });
    expect(document.activeElement).toBe(input);
    // Return to the first row before exercising ArrowDown below.
    await act(async () => {
      view.dom.querySelector<HTMLButtonElement>('button[name="prev"]')!.click();
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(navigate).toHaveBeenCalledWith({ type: 'tooltip', hash: 2, lang: 'en', line: 1 });
    await type('');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await type('cat');
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[role="option"]')!.click();
    });
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 3 });
    expect(view.state.doc.toString()).toBe('cat');
    await scope('Category');
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(input);
    await scope('This entry');
    expect(view.dom.querySelector('.cm-search')?.getAttribute('data-scope')).toBe('entry');
  } finally {
    await act(async () => {
      view.destroy();
      await Promise.resolve();
    });
    useDataStore.setState({ data: null });
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
