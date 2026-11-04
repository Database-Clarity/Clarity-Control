// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { CompendiumSheet } from '@clarity/core';
import { pickerRowIndex, pickerRows, warmPickerRowIndexes } from './pickerRows';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function idleQueue() {
  const callbacks = new Map<number, IdleRequestCallback>();
  let next = 0;
  vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
    callbacks.set(++next, callback);
    return next;
  });
  vi.stubGlobal('cancelIdleCallback', (id: number) => callbacks.delete(id));
  return {
    callbacks,
    run(timeRemaining = () => 50) {
      const [id, callback] = callbacks.entries().next().value!;
      callbacks.delete(id);
      callback({ didTimeout: false, timeRemaining });
    },
    drain() {
      let slices = 0;
      while (callbacks.size && slices++ < 10_000) this.run();
      expect(callbacks.size).toBe(0);
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

it('resumes normalization and sorting with the same complete index and search results', () => {
  const queue = idleQueue();
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => (clock += 0.05));
  const sheet = {
    ...tab,
    rows: Array.from({ length: 517 }, (_, i) =>
      row(['Écho', 'Alpha', 'Zèbre', 'Écho'][i % 4], (i * 37) % 19, `Section ${i % 3}`),
    ),
  };
  const expected = { ...sheet, rows: [...sheet.rows] };
  const cancel = warmPickerRowIndexes([sheet]);
  expect(queue.drain()).toBeGreaterThan(20);
  expect(pickerRowIndex(sheet)).toEqual(pickerRowIndex(expected));
  for (const query of ['', 'echo', 'Section 2']) {
    expect(pickerRows(sheet, 'weapon-trait', query, '')).toEqual(
      pickerRows(expected, 'weapon-trait', query, ''),
    );
  }
  cancel();
});

it('leaves work for another idle period when the deadline has less than two milliseconds', () => {
  const queue = idleQueue();
  const nameRead = vi.fn(() => 'Alpha');
  const sheet = {
    ...tab,
    rows: [
      {
        ...row('Alpha', 1),
        get name() {
          return nameRead();
        },
      },
    ],
  };
  const cancel = warmPickerRowIndexes([sheet]);
  queue.run(() => 1.5);
  expect(nameRead).not.toHaveBeenCalled();
  expect(queue.callbacks.size).toBe(1);
  queue.drain();
  expect(nameRead).toHaveBeenCalled();
  cancel();
});

it('pauses for pending input and a quiet period after typing, and cancels queued work', () => {
  vi.useFakeTimers();
  const queue = idleQueue();
  let pendingInput = true;
  vi.stubGlobal('navigator', { scheduling: { isInputPending: () => pendingInput } });
  const nameRead = vi.fn(() => 'Alpha');
  const sheet = {
    ...tab,
    rows: [
      {
        ...row('Alpha', 1),
        get name() {
          return nameRead();
        },
      },
    ],
  };
  const cancel = warmPickerRowIndexes([sheet]);
  queue.run();
  expect(nameRead).not.toHaveBeenCalled();
  pendingInput = false;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
  queue.run();
  expect(nameRead).not.toHaveBeenCalled();
  expect(queue.callbacks.size).toBe(0);
  vi.advanceTimersByTime(74);
  expect(queue.callbacks.size).toBe(0);
  vi.advanceTimersByTime(1);
  expect(queue.callbacks.size).toBe(1);
  cancel();
  expect(queue.callbacks.size).toBe(0);
  vi.runAllTimers();
  expect(nameRead).not.toHaveBeenCalled();
});

it('keeps a foreground-completed index when an unfinished warm-up resumes', () => {
  const queue = idleQueue();
  const sheet = { ...tab, rows: [...tab.rows] };
  const cancel = warmPickerRowIndexes([sheet]);
  let remaining = 3;
  queue.run(() => remaining--);
  const foreground = pickerRowIndex(sheet);
  queue.drain();
  expect(pickerRowIndex(sheet)).toBe(foreground);
  cancel();
});
