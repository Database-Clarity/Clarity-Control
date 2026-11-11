// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { useDataStore, type EditorData } from '../../../stores/data';
import { useDraftStore } from '../../../stores/drafts';
import { FindClient, entryFor } from './client';
import { FindIndex } from './index';

const tooltip: Tooltip = {
  hash: 1,
  associated: [],
  custom: { name: 'Custom', categoryId: 'perk' },
  text: {
    en: { text: 'cat', updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'test' },
  },
};
const data = {
  bundle: { tooltips: { 1: tooltip } },
  items: {},
  aliases: {},
  categories: [{ id: 'perk', label: 'Perks' }],
} as unknown as EditorData;
afterEach(() => {
  useDataStore.setState({ data: null });
  useDraftStore.setState({ drafts: {} });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('reports a worker startup failure to a query opened after the failed idle build', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        throw new Error('Worker unavailable');
      }
    },
  );
  const client = new FindClient('en');
  await vi.runAllTimersAsync();
  const failed = vi.fn();
  client.onError = failed;
  client.query({ search: 'cat', caseSensitive: false, wholeWord: false, raw: false }, vi.fn());
  expect(failed).toHaveBeenCalledOnce();
  client.destroy();
});
it('uses the view language or English, and preserves deliberately empty translation drafts', () => {
  expect(entryFor(tooltip, data, 'de')).toMatchObject({
    lang: 'en',
    text: 'cat',
    category: 'Perks',
  });
  expect(
    entryFor({ ...tooltip, custom: { name: 'Globals', categoryId: 'none' } }, data, 'en'),
  ).toMatchObject({ category: 'Other: none' });
  expect(
    entryFor(
      { ...tooltip, text: { ...tooltip.text, de: { ...tooltip.text.en!, text: '' } } },
      data,
      'de',
    ),
  ).toMatchObject({ lang: 'de', text: '' });
});
it('builds off the input path, overlays drafts, and refreshes results after discard', async () => {
  vi.useFakeTimers();
  const messages: unknown[] = [];
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
      messages.push(message);
      if (message.type === 'update') this.index.update(message.entries, message.removed);
      else
        queueMicrotask(() =>
          this.onmessage?.({ data: { id: message.id, ...this.index.query(message.options) } }),
        );
    }
    terminate() {}
  }
  vi.stubGlobal('Worker', WorkerMock);
  useDataStore.setState({ data });
  const client = new FindClient('en');
  const receive = vi.fn();
  client.query({ search: 'draft', caseSensitive: false, wholeWord: false, raw: false }, receive);
  expect(messages).toHaveLength(0);
  useDraftStore.setState({
    drafts: {
      1: {
        base: tooltip,
        next: { ...tooltip, text: { en: { ...tooltip.text.en!, text: 'draft' } } },
      },
    },
  });
  await vi.runAllTimersAsync();
  expect(receive).toHaveBeenLastCalledWith(
    expect.objectContaining({ results: [expect.objectContaining({ matched: 'draft' })] }),
  );
  useDraftStore.setState({ drafts: {} });
  await vi.runAllTimersAsync();
  expect(receive).toHaveBeenLastCalledWith(expect.objectContaining({ results: [] }));
  client.destroy();
});
