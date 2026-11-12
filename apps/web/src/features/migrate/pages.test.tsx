// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MovedPage } from './MovedPage';
import { MigratePage } from './MigratePage';
import { type ReceiverHandlers, type SenderHandlers, stamp } from './protocol';
import { type Snapshot } from './snapshot';
import * as storage from './storage';
import { downloadSnapshot } from './file';

const wire = vi.hoisted(() => ({
  sender: undefined as SenderHandlers | undefined,
  receiver: undefined as ReceiverHandlers | undefined,
  reply: vi.fn(),
}));
vi.mock('./protocol', async (original) => ({
  ...(await original<typeof import('./protocol')>()),
  startSender: vi.fn(
    (_source, _target, _origin, payload: Promise<string>, handlers: SenderHandlers) => {
      wire.sender = handlers;
      void payload.then(
        () => handlers.onSent(),
        (error: Error) => handlers.onRefused(error.message),
      );
      handlers.onWaiting();
      return { stop: vi.fn(), checkClosed: () => false };
    },
  ),
  startReceiver: vi.fn((_source, _opener, _allowed, handlers: ReceiverHandlers) => {
    wire.receiver = handlers;
    return { stop: vi.fn(), announce: vi.fn(), reply: wire.reply };
  }),
}));
vi.mock('./storage', async (original) => ({
  ...(await original<typeof import('./storage')>()),
  browserIO: vi.fn(),
  collectSnapshot: vi.fn(),
  clearMoved: vi.fn(),
  previewMerge: vi.fn(),
  applySnapshot: vi.fn(),
}));
vi.mock('./file', () => ({ downloadSnapshot: vi.fn(), exportName: () => 'drafts.json' }));
const snapshot: Snapshot = {
  version: 1,
  buckets: {
    tooltips: {
      '1': {
        base: { hash: 1, text: {}, associated: [] },
        next: { hash: 1, text: {}, associated: [] },
      },
    },
  },
  prefs: {},
};
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(storage.collectSnapshot).mockResolvedValue({ snapshot, unreadable: [] });
  vi.spyOn(window, 'open').mockReturnValue({ closed: false } as Window);
  Object.defineProperty(window, 'opener', { configurable: true, value: {} });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const click = async (text: string) => {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === text);
  expect(button).toBeDefined();
  await act(async () => button!.click());
};
it('moves and exports readable drafts while naming unreadable buckets', async () => {
  vi.mocked(storage.collectSnapshot).mockResolvedValue({
    snapshot,
    unreadable: ['tooltips:user:7'],
  });
  await act(async () => root.render(<MovedPage />));
  expect(host.textContent).toContain('1 unreadable draft bucket');
  expect(host.textContent).toContain('Tooltip drafts, account 7');
  await click('Export to file');
  expect(downloadSnapshot).toHaveBeenCalledWith(snapshot, 'drafts.json');
  await click('Move my drafts');
  expect(host.textContent).toContain('Sent.');
});
it('requires two explicit clicks before clearing confirmed drafts', async () => {
  await act(async () => root.render(<MovedPage />));
  await click('Move my drafts');
  await act(async () => wire.sender!.onDone({ tooltips: ['1'] }, 0));
  await click('Remove local copies…');
  expect(storage.clearMoved).not.toHaveBeenCalled();
  await click('Keep them');
  expect(storage.clearMoved).not.toHaveBeenCalled();
  await click('Remove local copies…');
  vi.mocked(storage.clearMoved).mockResolvedValue(1);
  await click('Yes, remove moved drafts');
  expect(storage.clearMoved).toHaveBeenCalledWith(snapshot, { tooltips: ['1'] }, undefined);
  expect(host.textContent).toContain('Removed 1 moved draft');
});
it('keeps an empty browser with unreadable buckets on the moved page', async () => {
  vi.mocked(storage.collectSnapshot).mockResolvedValue({
    snapshot: { version: 1, buckets: {}, prefs: {} },
    unreadable: ['tooltips'],
  });
  await act(async () => root.render(<MovedPage />));
  expect(host.textContent).toContain('Tooltip drafts, signed out');
  expect(host.textContent).toContain('There are no readable drafts');
  expect(host.querySelector('button')).toBeNull();
});
it.each(['preview', 'merge'])('replies refused when %s fails', async (phase) => {
  const outcome = { added: 1, identical: 0, keptSeparate: 0, writes: {}, stored: {}, unplaced: {} };
  vi.mocked(storage.previewMerge).mockResolvedValue({ outcome, prefs: { writes: {}, skipped: 0 } });
  if (phase === 'preview') vi.mocked(storage.previewMerge).mockRejectedValue(new Error('blocked'));
  else vi.mocked(storage.applySnapshot).mockRejectedValue(new Error('blocked'));
  await act(async () => root.render(<MigratePage />));
  await act(async () => wire.receiver!.onSnapshot(snapshot));
  if (phase === 'merge') await click('Merge into this browser');
  expect(wire.reply).toHaveBeenCalledWith({
    ...stamp,
    type: 'refused',
    reason: expect.stringContaining('Nothing was removed'),
  });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Nothing was removed');
});
it('replies with the cancellation message without applying drafts', async () => {
  vi.mocked(storage.previewMerge).mockResolvedValue({
    outcome: { added: 1, identical: 0, keptSeparate: 0, writes: {}, stored: {}, unplaced: {} },
    prefs: { writes: {}, skipped: 0 },
  });
  await act(async () => root.render(<MigratePage />));
  await act(async () => wire.receiver!.onSnapshot(snapshot));
  await click('Cancel');
  expect(wire.reply).toHaveBeenCalledWith({
    ...stamp,
    type: 'refused',
    reason: 'Cancelled on the new site.',
  });
  expect(storage.applySnapshot).not.toHaveBeenCalled();
});

it('redirects an empty readable browser to the new origin and preserves the route', async () => {
  vi.mocked(storage.collectSnapshot).mockResolvedValue({
    snapshot: { version: 1, buckets: {}, prefs: {} },
    unreadable: [],
  });
  const replace = vi.fn();
  const actual = window;
  vi.stubGlobal(
    'window',
    new Proxy(actual, {
      get(target, key) {
        return key === 'location' ? { hash: '#/migrate', replace } : Reflect.get(target, key);
      },
    }),
  );
  await act(async () => root.render(<MovedPage />));
  expect(replace).toHaveBeenCalledWith('https://control.d2clarity.com/#/migrate');
});

it('shows cancellation as neutral status and leaves retry available', async () => {
  await act(async () => root.render(<MovedPage />));
  await click('Move my drafts');
  await act(async () => wire.sender!.onRefused('Cancelled on the new site.'));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector('[role="status"]')?.textContent).toBe(
    'Move cancelled. Nothing was changed; your drafts are still here.',
  );
  expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Try again')).toBe(
    true,
  );
});
