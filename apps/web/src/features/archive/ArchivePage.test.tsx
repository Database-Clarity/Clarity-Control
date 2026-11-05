// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { ArchivePage } from './ArchivePage';
import { ArchiveIcon } from './ArchiveIcon';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useAuthStore } from '../../stores/auth';
import { useSettingsStore } from '../../stores/settings';
import { useSaveState } from '../../services/save/state';
import { getHistory } from '../../services/history';

vi.mock('../../services/api', async (original) => ({
  ...(await original<typeof import('../../services/api')>()),
  apiUrl: 'https://editor.test',
}));
vi.mock('../../services/history', () => ({
  getHistory: vi.fn(async () => ({ commits: [] })),
  getVersion: vi.fn(),
}));
const time = '2026-11-02T00:00:00Z';
const archived: Tooltip = {
  hash: 4000000000,
  text: { en: { text: 'Preserved archived words', updatedAt: time, updatedBy: 'old' } },
  associated: [],
  archive: {
    removedAt: time,
    lastSeen: { name: 'Old catalog name', categoryId: 'old-category', manifestVersion: 'v1' },
  },
};
const data: EditorData = {
  items: {
    10: { hash: 10, name: 'Current', categoryId: 'trait', inGameDescription: '', icon: '' },
  },
  categories: [],
  aliases: {},
  bundle: {
    sourceCommit: 'abc',
    generatedAt: time,
    tooltips: { [archived.hash]: archived },
    permissions: { users: {} },
    pushed: {},
  },
};
/** The guard pauses when >5% of tracked tooltips newly vanish, so unconfirmed rows need a healthy bulk. */
function withHealthyBulk(tooltips: Tooltip[]): EditorData {
  const bulk = Array.from({ length: 40 }, (_, index) => 100 + index);
  return {
    ...data,
    items: {
      ...data.items,
      ...Object.fromEntries(
        bulk.map((hash) => [
          hash,
          { hash, name: `Bulk ${hash}`, categoryId: 'trait', inGameDescription: '', icon: '' },
        ]),
      ),
    },
    bundle: {
      ...data.bundle,
      tooltips: Object.fromEntries(
        [...bulk.map((hash) => ({ hash, text: {}, associated: [] }) as Tooltip), ...tooltips].map(
          (tooltip) => [tooltip.hash, tooltip],
        ),
      ),
    },
  };
}
let root: Root, host: HTMLDivElement;
const oldData = useDataStore.getState(),
  oldDrafts = useDraftStore.getState(),
  oldAuth = useAuthStore.getState(),
  oldSave = useSaveState.getState();
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  // 'auto' follows the runner's locale; pin it so the asserted text is stable.
  useSettingsStore.getState().update({ dateFormat: 'dmy', timeZone: 'UTC', timeDisplay: 'date' });
  useDataStore.setState({ data, status: 'ready', error: null });
  useAuthStore.setState({ user: { id: 1, login: 'person', role: 'maintainer' } });
  useDraftStore.setState({ drafts: {}, hydrated: true });
  useSaveState.setState({ locked: false });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useDataStore.setState(oldData);
  useDraftStore.setState(oldDrafts);
  useAuthStore.setState(oldAuth);
  useSaveState.setState(oldSave);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function button(text: string) {
  return [...host.querySelectorAll('button')].find((entry) => entry.textContent?.includes(text))!;
}
async function render(path = '/archive') {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <ArchivePage />
      </MemoryRouter>,
    ),
  );
}
it('renders preserved identity/text without an item/icon, loads history for the original hash, and restores phone list position', async () => {
  await render();
  Object.defineProperty(window, 'scrollY', { value: 640, configurable: true });
  await act(async () => button('Old catalog name').click());
  expect(host.textContent).toContain('Preserved archived words');
  expect([...host.querySelectorAll('h1')].map((entry) => entry.textContent)).toContain(
    'Old catalog name',
  );
  expect(host.querySelector('[aria-label="Icon no longer available"]')).not.toBeNull();
  expect(host.querySelector('[contenteditable="true"]')).toBeNull();
  const history = [...host.querySelectorAll('button')].find(
    (entry) => entry.textContent === 'History',
  )!;
  await act(async () => history.click());
  expect(getHistory).toHaveBeenCalledWith(archived.hash, 1, expect.any(AbortSignal));
  expect(getHistory).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('No commits found for this tooltip.');
  expect(button('Revert to this')).toBeUndefined();
  await act(async () => button('Back to Archive').click());
  expect(window.scrollTo).toHaveBeenLastCalledWith(0, 640);
  expect(host.querySelector('[hidden]')).toBeNull();
});
it('lets translators view direct archive links without actions', async () => {
  useAuthStore.setState({ user: { id: 1, login: 'translator', role: 'translator' } });
  await render(`/archive?item=${archived.hash}`);
  expect(host.textContent).toContain('Preserved archived words');
  expect(button('Confirm archival')).toBeUndefined();
  expect(button('Associate with new item')).toBeUndefined();
  expect(button('Restore')).toBeUndefined();
});
it('lets editors view but offers association only to maintainers', async () => {
  useAuthStore.setState({ user: { id: 1, login: 'editor', role: 'editor' } });
  await render(`/archive?item=${archived.hash}`);
  expect(button('Associate with new item')).toBeUndefined();
  await act(async () =>
    useAuthStore.setState({ user: { id: 1, login: 'maintainer', role: 'maintainer' } }),
  );
  expect(button('Associate with new item')).toBeDefined();
});
it('pauses failed/empty manifests and never creates drafts', async () => {
  useDataStore.setState({ data: { ...data, items: {} } });
  await render();
  expect(host.textContent).toContain('Manifest looks incomplete — archive view paused');
  expect(useDraftStore.getState().drafts).toEqual({});
  expect(host.querySelector('h1')?.textContent).toBe('Archive');
});
it('reports a load failure as a retryable outage, not an incomplete manifest, and keeps the heading', async () => {
  const load = vi.fn(async () => {});
  useDataStore.setState({ data: null, status: 'error', error: 'Generator HTTP 503', load });
  await render();
  expect(host.querySelector('h1')?.textContent).toBe('Archive');
  expect(host.textContent).toContain("Couldn't load data — retry");
  expect(host.textContent).not.toContain('Manifest looks incomplete');
  expect(host.querySelector('details')?.textContent).toContain('Generator HTTP 503');
  expect(host.querySelector('li')).toBeNull();
  await act(async () => button('Retry data loading').click());
  expect(load).toHaveBeenCalled();
});
it('lists readable dates, category labels, languages and confirmed/unconfirmed status', async () => {
  const unconfirmed: Tooltip = { hash: 4000000001, text: archived.text, associated: [] };
  useDataStore.setState({ data: withHealthyBulk([archived, unconfirmed]) });
  await render();
  const rows = [...host.querySelectorAll('li')].map((entry) => entry.textContent ?? '');
  expect(rows[0]).toContain('Confirmed');
  expect(rows[0]).toContain('Removed 2 Nov 2026');
  expect(host.querySelector('time')?.style.whiteSpace).toBe('nowrap');
  expect(rows[0]).toContain('English');
  expect(rows[0]).not.toContain('2026-11-02T');
  expect(rows[1]).toContain('Unconfirmed');
  expect(rows[1]).toContain('Category not yet snapshotted');
  expect(rows[1]).not.toMatch(/unknown/i);
});
it('opens the detail on a read-only preview with the notice visible, and explains confirmation', async () => {
  const unconfirmed: Tooltip = { hash: 4000000001, text: archived.text, associated: [] };
  useDataStore.setState({ data: withHealthyBulk([unconfirmed]) });
  await render(`/archive?item=${unconfirmed.hash}`);
  expect(host.querySelector('[data-panel="preview"]')?.getAttribute('data-active')).toBe('true');
  expect(host.textContent).not.toContain('Read-only details');
  expect(host.querySelector('[role="status"]')?.textContent).toContain(
    'Archived tooltip — read only',
  );
  expect(host.textContent).toContain('Unconfirmed');
  expect(host.textContent).toContain('Confirming saves the name and category');
  expect(button('Confirm archival')).toBeDefined();
  expect(host.textContent).toContain('Nothing is saved until review');
  expect(button('Associate with new item').disabled).toBe(true);
  expect(host.textContent).toContain('Confirm archival first');
  const updateDraft = vi.fn();
  await act(async () => useDraftStore.setState({ updateDraft }));
  await act(async () => button('Confirm archival').click());
  expect(updateDraft).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('Review changes and save');
});
it('hides Associate once a successor is set and explains the consequences before staging', async () => {
  await render(`/archive?item=${archived.hash}`);
  expect(host.textContent).toContain('copies chosen languages into a local draft');
  useDataStore.setState({
    data: {
      ...data,
      bundle: {
        ...data.bundle,
        tooltips: {
          [archived.hash]: { ...archived, archive: { ...archived.archive!, successor: 10 } },
        },
      },
    },
  });
  await render(`/archive?item=${archived.hash}`);
  expect(button('Associate with new item')).toBeUndefined();
  expect(host.textContent).toContain('Association saved.');
  expect(host.textContent).not.toContain('Association staged');
  expect(host.textContent).toContain('Superseded by');
});
it('never silently overwrites an existing draft on the destination', async () => {
  const updateDrafts = vi.fn();
  const targetTooltip: Tooltip = {
    hash: 10,
    text: { en: { text: 'Destination', updatedAt: time, updatedBy: 'other' } },
    associated: [],
  };
  useDraftStore.setState({
    updateDrafts,
    drafts: {
      10: { base: targetTooltip, next: { ...targetTooltip, associated: [5] } },
    } as never,
  });
  await render(`/archive?item=${archived.hash}`);
  await act(async () => button('Associate with new item').click());
  const input = [...host.querySelectorAll('input')].find((entry) =>
    entry.closest('label')?.textContent?.includes('Search items'),
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'Current',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Current (10)').click());
  expect(host.textContent).toContain('already has a local draft');
  expect(button('Confirm association as drafts').disabled).toBe(true);
  await act(async () => button('Confirm association as drafts').click());
  expect(updateDrafts).not.toHaveBeenCalled();
  const replace = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
    (entry) => entry.closest('label')?.textContent?.includes('Replace the selected languages'),
  )!;
  await act(async () => replace.click());
  expect(button('Confirm association as drafts').disabled).toBe(false);
  await act(async () => button('Confirm association as drafts').click());
  expect(updateDrafts).toHaveBeenCalledTimes(1);
  expect(updateDrafts.mock.calls[0][0][1].update(targetTooltip).associated).toEqual([5]);
});
async function search(text: string) {
  const input = [...host.querySelectorAll('input')].find((entry) =>
    entry.closest('label')?.textContent?.includes('Search items'),
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const replaceBox = () =>
  [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((entry) =>
    entry.closest('label')?.textContent?.includes('Replace the selected languages'),
  );
it('does not carry replace-draft consent to a different destination or a re-opened item', async () => {
  const second: Tooltip = {
    hash: 11,
    text: { en: { text: 'Second', updatedAt: time, updatedBy: 'other' } },
    associated: [],
  };
  const first: Tooltip = { ...second, hash: 10 };
  const updateDrafts = vi.fn();
  useDataStore.setState({
    data: {
      ...data,
      items: {
        ...data.items,
        11: {
          hash: 11,
          name: 'Current second',
          categoryId: 'trait',
          inGameDescription: '',
          icon: '',
        },
      },
    },
  });
  useDraftStore.setState({
    updateDrafts,
    drafts: {
      10: { base: first, next: { ...first, associated: [5] } },
      11: { base: second, next: { ...second, associated: [6] } },
    } as never,
  });
  await render(`/archive?item=${archived.hash}`);
  await act(async () => button('Associate with new item').click());
  await search('Current');
  await act(async () => button('Current (10)').click());
  await act(async () => replaceBox()!.click());
  expect(button('Confirm association as drafts').disabled).toBe(false);
  await act(async () => button('Current second (11)').click());
  expect(replaceBox()!.checked).toBe(false);
  expect(replaceBox()!.closest('label')?.textContent).toContain('Current second (11)');
  expect(button('Confirm association as drafts').disabled).toBe(true);
  await act(async () => button('Confirm association as drafts').click());
  expect(updateDrafts).not.toHaveBeenCalled();
  // Consent given for 10 does not come back when returning to 10 after 11.
  await act(async () => button('Current (10)').click());
  expect(replaceBox()!.checked).toBe(false);
  // Cancel and re-open also starts clean.
  await act(async () => replaceBox()!.click());
  await act(async () => button('Cancel association').click());
  await act(async () => button('Associate with new item').click());
  await search('Current');
  await act(async () => button('Current (10)').click());
  expect(replaceBox()!.checked).toBe(false);
});
it('drops the picker destination and consent when the archived item changes (browser Back)', async () => {
  const other: Tooltip = { ...archived, hash: 4000000001 };
  const targetTooltip: Tooltip = {
    hash: 10,
    text: { en: { text: 'Destination', updatedAt: time, updatedBy: 'other' } },
    associated: [],
  };
  useDataStore.setState({
    data: {
      ...data,
      bundle: { ...data.bundle, tooltips: { [archived.hash]: archived, [other.hash]: other } },
    },
  });
  useDraftStore.setState({
    drafts: { 10: { base: targetTooltip, next: { ...targetTooltip, associated: [5] } } } as never,
  });
  let go!: (to: string) => void;
  function Capture() {
    go = useNavigate();
    return null;
  }
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[`/archive?item=${archived.hash}`]}>
        <Capture />
        <ArchivePage />
      </MemoryRouter>,
    ),
  );
  await act(async () => button('Associate with new item').click());
  await search('Current');
  await act(async () => button('Current (10)').click());
  await act(async () => replaceBox()!.click());
  expect(button('Confirm association as drafts').disabled).toBe(false);
  await act(async () => go(`/archive?item=${other.hash}`));
  expect(host.querySelector('[contenteditable="true"]')).toBeNull();
  expect(replaceBox()).toBeUndefined();
  expect(button('Confirm association as drafts')).toBeUndefined();
  await act(async () => button('Associate with new item').click());
  await search('Current');
  await act(async () => button('Current (10)').click());
  expect(replaceBox()!.checked).toBe(false);
  expect(button('Confirm association as drafts').disabled).toBe(true);
});
it('replaces failed images with a neutral accessible glyph', async () => {
  await act(async () => root.render(<ArchiveIcon icon="/missing.png" />));
  await act(async () => host.querySelector('img')!.dispatchEvent(new Event('error')));
  expect(host.querySelector('img')).toBeNull();
  expect(host.textContent).toBe('◇');
});

it('requires explicit destination review before staging one target draft and the source successor', async () => {
  const updateDrafts = vi.fn();
  useDraftStore.setState({ updateDrafts });
  await render(`/archive?item=${archived.hash}`);
  await act(async () => button('Associate with new item').click());
  expect(updateDrafts).not.toHaveBeenCalled();
  const input = [...host.querySelectorAll('input')].find((entry) =>
    entry.closest('label')?.textContent?.includes('Search items'),
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'Current',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Current (10)').click());
  expect(host.textContent).toContain('Archived text');
  expect(host.textContent).toContain('Destination current text');
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  expect(updateDrafts).not.toHaveBeenCalled();
  await act(async () => button('Confirm association as drafts').click());
  expect(updateDrafts).toHaveBeenCalledTimes(1);
  const updates = updateDrafts.mock.calls[0][0];
  expect(updates).toHaveLength(2);
  expect(updates.map((entry: { base: Tooltip }) => entry.base.hash)).toEqual([archived.hash, 10]);
  expect(updates[0].update(archived).archive.successor).toBe(10);
  expect(updates[0].update(archived).text).toEqual(archived.text);
  expect(updates[1].update(updates[1].base).text.en.text).toBe('Preserved archived words');
});
it('stages restore through an editor draft while preserving every text language', async () => {
  const updateDraft = vi.fn();
  useDraftStore.setState({ updateDraft });
  useAuthStore.setState({ user: { id: 1, login: 'editor', role: 'editor' } });
  useDataStore.setState({
    data: {
      ...data,
      items: { ...data.items, [archived.hash]: { ...data.items[10], hash: archived.hash } },
    },
  });
  await render(`/archive?item=${archived.hash}`);
  await act(async () => button('Restore').click());
  expect(updateDraft).toHaveBeenCalledTimes(1);
  const [base, update] = updateDraft.mock.calls[0];
  const next = update(structuredClone(base));
  expect(next.archive).toBeUndefined();
  expect(next.text).toEqual(archived.text);
  expect(host.textContent).toContain('Restore staged');
  expect(host.textContent).toContain('Text is untouched');
});

it('shows staged only for a changed successor and follows save/discard state', async () => {
  const next = { ...archived, archive: { ...archived.archive!, successor: 10 } };
  await render(`/archive?item=${archived.hash}`);
  await act(async () =>
    useDraftStore.setState({
      drafts: { [archived.hash]: { base: archived, next } } as never,
    }),
  );
  expect(host.textContent).toContain('Association staged');
  await act(async () => {
    useDataStore.setState({
      data: { ...data, bundle: { ...data.bundle, tooltips: { [archived.hash]: next } } },
    });
    useDraftStore.setState({ drafts: {} });
  });
  expect(host.textContent).toContain('Association saved.');
  expect(host.textContent).not.toContain('Association staged');
  // An unrelated text draft must not make a saved successor look staged.
  await act(async () =>
    useDraftStore.setState({
      drafts: { [archived.hash]: { base: next, next: { ...next, text: {} } } } as never,
    }),
  );
  expect(host.textContent).not.toContain('Association staged');
  await act(async () => {
    useDataStore.setState({ data });
    useDraftStore.setState({ drafts: {} });
  });
  expect(host.textContent).not.toContain('Association staged');
  expect(button('Associate with new item')).toBeDefined();
});
