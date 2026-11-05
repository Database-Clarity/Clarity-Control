// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { CompendiumSheet } from '@clarity/core';
import {
  pickerIdleScheduler,
  pickerRowDetail,
  pickerRows,
  warmPickerRowIndexes,
} from './pickerRows';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function idleQueue() {
  const callbacks = new Map<number, IdleRequestCallback>();
  const messages: (() => void)[] = [];
  let next = 0;
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1 = { onmessage: undefined as (() => void) | undefined, close: vi.fn() };
      port2 = { postMessage: () => messages.push(() => this.port1.onmessage?.()), close: vi.fn() };
    },
  );
  vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
    callbacks.set(++next, callback);
    return next;
  });
  vi.stubGlobal('cancelIdleCallback', (id: number) => callbacks.delete(id));
  return {
    callbacks,
    run(timeRemaining = () => 50) {
      messages.splice(0).forEach((message) => message());
      const first = callbacks.entries().next().value;
      if (!first) return;
      const [id, callback] = first;
      callbacks.delete(id);
      callback({ didTimeout: false, timeRemaining });
    },
    drain() {
      let slices = 0;
      while ((messages.length || callbacks.size) && slices++ < 10_000) this.run();
      expect(callbacks.size).toBe(0);
      expect(messages.length).toBe(0);
      return slices;
    },
  };
}
const row = (name: string, rowIndex: number, section = 'Traits') => ({
  name,
  nameNorm: name.toLowerCase(),
  rowIndex,
  section,
  cell: { plain: 'Description', runs: [{ text: 'Description' }] },
});
const tab: CompendiumSheet = {
  gid: 'test',
  name: 'Test',
  rows: [
    row('Beta', 4, 'Alpha reference'),
    row('Alphabet', 3),
    row('Alpha', 10),
    row('A Alpha', 5),
    row('Alpha', 2),
  ],
};
it('shows all rows alphabetically and breaks duplicate-name ties by physical row', () => {
  const result = pickerRows(tab, 'weapon-trait', '', '');
  expect(result.rows.map((r) => r.rowIndex)).toEqual([5, 2, 10, 3, 4]);
  expect(result.exact.size).toBe(0);
});
it('promotes exact identifiers while retaining partial name and section search results', () => {
  const result = pickerRows(tab, 'weapon-trait', 'Alpha', '');
  expect(result.rows.map((r) => r.rowIndex)).toEqual([2, 10, 5, 3, 4]);
  expect([...result.exact].map((r) => r.rowIndex)).toEqual([2, 10]);
  expect(pickerRows(tab, 'weapon-trait', 'Alpha', 'Traits').rows.map((r) => r.rowIndex)).toEqual([
    2, 10, 5, 3,
  ]);
});
it('uses refreshed sheet names rather than an earlier source index', () => {
  const refreshed = {
    ...tab,
    rows: tab.rows.map((r) => (r.name === 'Alpha' ? { ...r, name: 'Gamma' } : r)),
  };
  expect(pickerRows(refreshed, 'weapon-trait', 'Gamma', '').rows.map((r) => r.rowIndex)).toEqual([
    2, 10,
  ]);
  expect(pickerRows(refreshed, 'weapon-trait', 'Alpha', '').exact.size).toBe(0);
});

it('computes only requested row fields and reuses them for the same source row', () => {
  const sectionRead = vi.fn(() => 'Traits');
  const sheetRow = {
    ...row('Écho', 1),
    get section() {
      return sectionRead();
    },
  };
  const details = pickerRowDetail(sheetRow);
  expect(details.name).toBe('echo');
  expect(details.identifiers).toEqual(['echo', 'echo']);
  expect(sectionRead).not.toHaveBeenCalled();
  expect(details.search).toBe('echo traits');
  expect(details.search).toBe('echo traits');
  expect(sectionRead).toHaveBeenCalledTimes(1);
  expect(pickerRowDetail(sheetRow)).toBe(details);
});

it('does not normalize unused fields when showing an unfiltered tab', () => {
  const sectionRead = vi.fn(() => 'Traits');
  const sheet = {
    ...tab,
    rows: [
      {
        ...row('Alpha', 1),
        get section() {
          return sectionRead();
        },
      },
    ],
  };
  expect(pickerRows(sheet, 'weapon-trait', '', '').rows).toEqual(sheet.rows);
  expect(sectionRead).not.toHaveBeenCalled();
});

it('uses real idle callbacks, yields through a message task, and respects a short deadline', () => {
  vi.useFakeTimers();
  const queue = idleQueue();
  const work = vi.fn();
  const idle = pickerIdleScheduler(work);
  idle.schedule();
  expect(work).not.toHaveBeenCalled();
  queue.run();
  vi.advanceTimersByTime(250);
  queue.run(() => 1);
  expect(work).not.toHaveBeenCalled();
  queue.run();
  expect(work).toHaveBeenCalledOnce();
  idle.cancel();
});

it('keeps clock reads off input callbacks and pauses through editing and pending input', () => {
  vi.useFakeTimers();
  const queue = idleQueue();
  let pending = true;
  vi.stubGlobal('navigator', { scheduling: { isInputPending: () => pending } });
  const work = vi.fn();
  const idle = pickerIdleScheduler(work);
  idle.schedule();
  const clock = vi.spyOn(performance, 'now');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
  expect(clock).not.toHaveBeenCalled();
  queue.run();
  expect(work).not.toHaveBeenCalled();
  pending = false;
  const input = document.createElement('textarea');
  document.body.append(input);
  input.focus();
  vi.advanceTimersByTime(1000);
  queue.run();
  expect(work).not.toHaveBeenCalled();
  input.remove();
  vi.advanceTimersByTime(250);
  queue.run();
  expect(work).toHaveBeenCalledOnce();
  idle.cancel();
});

it('cancels idle work and keeps an on-demand fallback when workers are unavailable', () => {
  const queue = idleQueue();
  const work = vi.fn();
  const idle = pickerIdleScheduler(work);
  idle.schedule();
  idle.cancel();
  queue.drain();
  expect(work).not.toHaveBeenCalled();
  vi.stubGlobal('Worker', undefined);
  const sheet = { ...tab, rows: [...tab.rows] };
  const cancel = warmPickerRowIndexes([sheet]);
  queue.drain();
  expect(pickerRows(sheet, 'weapon-trait', 'Alpha', '').rows.map((r) => r.rowIndex)).toEqual([
    2, 10, 5, 3, 4,
  ]);
  cancel();
});

it('transfers bounded worker batches, installs off-thread fields during idle, and terminates on cancel', () => {
  vi.useFakeTimers();
  const queue = idleQueue();
  const posts: { name: string; section?: string }[][] = [];
  const instances: FakeWorker[] = [];
  class FakeWorker {
    onmessage?: (event: MessageEvent) => void;
    onerror?: () => void;
    terminate = vi.fn();
    constructor() {
      instances.push(this);
    }
    postMessage(rows: { name: string; section?: string }[]) {
      posts.push(rows);
    }
  }
  vi.stubGlobal('Worker', FakeWorker);
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(
    () => vi.getMockedSystemTime()!.getTime() + (clock += 0.05),
  );
  const rows = Array.from({ length: 35 }, (_, i) => row(`Name ${i}`, i));
  const cancel = warmPickerRowIndexes([{ ...tab, rows }]);
  queue.run();
  vi.advanceTimersByTime(250);
  queue.drain();
  expect(posts).toHaveLength(1);
  expect(posts[0]).toHaveLength(16);
  instances[0].onmessage?.({
    data: posts[0].map(() => ({
      name: 'worker name',
      identifiers: ['worker identifier'],
      search: 'worker search',
    })),
  } as MessageEvent);
  expect(pickerRowDetail(rows[0]).name).toBe('name 0');
  queue.drain();
  expect(pickerRowDetail(rows[0]).name).toBe('worker name');
  expect(pickerRowDetail(rows[0]).identifiers).toEqual(['worker identifier']);
  expect(posts).toHaveLength(2);
  expect(posts[1]).toHaveLength(16);
  cancel();
  expect(instances[0].terminate).toHaveBeenCalledOnce();
});

it('the worker returns the same normalized names, identifiers, and section search text', async () => {
  const posted = vi.fn();
  const scope = {
    postMessage: posted,
    onmessage: undefined as ((event: MessageEvent) => void) | undefined,
  };
  vi.stubGlobal('self', scope);
  await import('./pickerRows.worker');
  scope.onmessage?.({
    data: [
      { name: 'Écho', section: 'Traits' },
      {
        name: 'Ignored',
        cached: { name: 'cached', identifiers: ['cached'], search: 'cached search' },
      },
    ],
  } as MessageEvent);
  expect(posted).toHaveBeenCalledWith([
    { name: 'echo', identifiers: ['echo', 'echo'], search: 'echo traits' },
    { name: 'cached', identifiers: ['cached'], search: 'cached search' },
  ]);
});

it('defers cache work across hash/back navigation until the workspace is ready and quiet', () => {
  vi.useFakeTimers();
  const queue = idleQueue();
  const work = vi.fn();
  const idle = pickerIdleScheduler(work);
  idle.schedule();
  const article = document.createElement('article');
  article.setAttribute('aria-busy', 'true');
  document.body.append(article);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  queue.run();
  vi.advanceTimersByTime(500);
  queue.run();
  expect(work).not.toHaveBeenCalled();
  article.remove();
  window.dispatchEvent(new PopStateEvent('popstate'));
  vi.advanceTimersByTime(250);
  queue.run();
  expect(work).not.toHaveBeenCalled();
  vi.advanceTimersByTime(250);
  queue.run();
  expect(work).toHaveBeenCalledOnce();
  idle.cancel();
});
