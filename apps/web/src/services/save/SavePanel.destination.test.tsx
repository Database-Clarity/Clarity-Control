// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { createBatchFixture, type BatchFixture } from '../scheduled/fixtureWorker.testSupport';
import { editorData, tooltip } from './fixtures.testSupport';

const mocks = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  apiUrl: 'https://worker.example',
  save: mocks.save,
}));
vi.mock('../session', () => ({ sessionToken: () => 'token-a' }));
vi.mock('./pipeline', () => ({
  permissionError: () => null,
  validateChanges: () => [],
  prepareChanges: async (changes: unknown) => changes,
}));
vi.mock('./validationWorker', () => ({ requestSaveValidation: async () => [] }));
vi.mock('./SaveSummary', () => ({ SaveSummary: () => null }));
vi.mock('../../ui/Dialog', () => ({
  Dialog: ({ children, footer }: { children: ReactNode; footer?: ReactNode }) =>
    createElement('div', null, children, footer),
}));

const edited: Tooltip = {
  ...tooltip,
  text: { en: { ...tooltip.text.en!, text: 'Batch English' } },
};
const extra = (hash: number): Tooltip => ({
  ...tooltip,
  hash,
  text: { en: { ...tooltip.text.en!, text: `T${hash}` } },
});

let fixture: BatchFixture;
let root: Root;
let host: HTMLDivElement;
let onSave: (() => void) | undefined;
/** Wraps each POST /batches/:id/save (count from 1); default: forward it. */
let saveHook: ((count: number, forward: () => Promise<Response>) => Promise<Response>) | undefined;
let saves = 0;

async function setup(role: 'editor' | 'translator', enabled = '1') {
  vi.resetModules();
  vi.stubEnv('VITE_API_URL', 'https://worker.example/');
  vi.stubEnv('VITE_SCHEDULED_ENABLED', enabled);
  const { SaveController } = await import('./SavePanel');
  const { useSaveState } = await import('./state');
  const { useSaveNotice } = await import('./notice');
  const { useAuthStore } = await import('../../stores/auth');
  const { useDataStore } = await import('../../stores/data');
  const { useDraftStore } = await import('../../stores/drafts');
  const user = { id: 1, login: 'alice', role, languages: ['de' as const] };
  useAuthStore.setState({ user, token: 'token-a', loading: false });
  useDataStore.setState({ data: editorData() });
  useDraftStore.setState({
    drafts: { 123: { base: tooltip, next: edited } },
    hydrated: true,
    error: null,
    generation: 3,
    owner: '1',
    external: false,
    flush: async () => {},
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(SaveController)));
  await act(async () =>
    useSaveState.setState({
      locked: true,
      review: {
        changes: [{ hash: 123, base: tooltip, next: edited }],
        submitted: { 123: { base: tooltip, next: edited } },
      },
    }),
  );
  const settle = async (done: () => boolean = () => true) => {
    for (let i = 0; i < 300 && !done(); i++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const button = (text: string) =>
    [...host.querySelectorAll('button')].find((node) => node.textContent === text);
  const click = async (text: string) => {
    const target = button(text);
    if (!target) throw new Error(`No button "${text}" in: ${host.textContent}`);
    await act(async () => target.click());
  };
  const { useBatchDraftStore } = await import('../scheduled/batchDrafts');
  /** Opens a new review of these Current drafts (and keeps them as the drafts store's). */
  const review = async (drafts: Record<number, { base: Tooltip; next: Tooltip }>) => {
    useDraftStore.setState({ drafts });
    await act(async () =>
      useSaveState.setState({
        locked: true,
        review: {
          changes: Object.values(drafts).map(({ base, next }) => ({ hash: next.hash, base, next })),
          submitted: drafts,
        },
      }),
    );
  };
  return {
    settle,
    button,
    click,
    review,
    useDraftStore,
    useSaveNotice,
    useSaveState,
    useBatchDraftStore,
    useDataStore,
  };
}

async function type(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(input, value);
  await act(async () => {
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}

async function call(path: string, body: unknown) {
  const response = await fixture.handle(
    new Request(`https://worker.example${path}`, { method: 'POST', body: JSON.stringify(body) }),
  );
  if (!response!.ok) throw new Error(`${path}: ${response!.status}`);
  return (await response!.json()) as { batch: { id: string; revision: number } };
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  for (const name of ['localStorage', 'sessionStorage'])
    vi.stubGlobal(name, { getItem: () => null, setItem() {}, removeItem() {} });
  mocks.save.mockReset();
  onSave = undefined;
  saveHook = undefined;
  saves = 0;
  fixture = createBatchFixture({
    current: { 123: tooltip, ...Object.fromEntries([200, 201].map((hash) => [hash, extra(hash)])) },
    user: { id: 1, login: 'alice', role: 'editor' },
  });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === 'POST' && request.url.endsWith('/save')) {
      onSave?.();
      const forward = () => fixture.fetch(request);
      return saveHook ? saveHook(++saves, forward) : (saves++, forward());
    }
    return fixture.fetch(request);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Review save destination (scheduled changes)', () => {
  it('saves into a new batch, leaves current saved alone, and moves the draft into the batch', async () => {
    const view = await setup('editor');
    await view.settle(() => Boolean(view.button('New batch…')));
    expect(view.button('Current')?.getAttribute('aria-pressed')).toBe('true');
    expect(view.button('Batch')?.disabled).toBe(true); // no open batch yet
    await view.click('New batch…');
    expect(view.button('Save to batch')?.disabled).toBe(true); // a name first
    await type(
      host.querySelector<HTMLInputElement>('input[aria-label="New batch name"]')!,
      'January',
    );
    await view.click('Save to batch');
    await view.settle(() => view.useSaveState.getState().review === null);
    expect(mocks.save).not.toHaveBeenCalled();
    const [batch] = [...fixture.batches.values()];
    expect(batch.name).toBe('January');
    expect(fixture.members.get(batch.id)?.get(123)?.proposed.text.en?.text).toBe('Batch English');
    expect(view.useDraftStore.getState().drafts).toEqual({});
    // Current saved is untouched by a batch save.
    expect(view.useDataStore.getState().data?.bundle.tooltips[123]).toEqual(tooltip);
    expect(view.useSaveNotice.getState().notice).toBe(
      'Saved 1 tooltip to January; not published before a time is set (Review → Batches → Schedule…).',
    );
  });

  it('names the zoned not-before time of a scheduled batch, and keeps a draft edited during the save', async () => {
    const { batch } = await call('/batches', { name: 'December patch' });
    await call(`/batches/${batch.id}/save`, {
      revision: batch.revision,
      changes: [{ hash: 200, base: extra(200), next: { ...extra(200), associated: [5] } }],
    });
    await call(`/batches/${batch.id}/schedule`, {
      revision: 2,
      notBefore: '2026-12-03T16:00:00.000Z',
      zone: 'UTC',
    });
    const view = await setup('editor');
    await view.settle(() => Boolean(view.button('Batch') && !view.button('Batch')!.disabled));
    await view.click('Batch');
    expect(host.querySelector('[data-destination-note]')?.textContent).toContain(
      'A scheduled batch takes translation edits only.',
    );
    // A translation edit goes into the scheduled batch; the draft is edited while it saves.
    const german: Tooltip = {
      ...tooltip,
      text: {
        ...tooltip.text,
        de: { text: 'Deutsch', updatedAt: tooltip.text.en!.updatedAt, updatedBy: 'alice' },
      },
    };
    await act(async () =>
      view.useSaveState.setState({
        locked: true,
        review: {
          changes: [{ hash: 123, base: tooltip, next: german }],
          submitted: { 123: { base: tooltip, next: german } },
        },
      }),
    );
    // 123 is not a member: a scheduled batch refuses adds, verbatim.
    await view.click('Save to batch');
    await view.settle(() => host.textContent!.includes('Unschedule to edit'));
    expect(host.textContent).toContain('Nothing was saved to December patch. Unschedule to edit');
    expect(view.useDraftStore.getState().drafts[123]).toBeTruthy();
    // A member's translation: saved, and a draft edited meanwhile stays in Current.
    const member: Tooltip = {
      ...extra(200),
      associated: [5],
      text: { ...extra(200).text, de: german.text.de },
    };
    const after = { ...member, text: { ...member.text, fr: german.text.de } };
    await act(async () =>
      view.useSaveState.setState({
        locked: true,
        review: {
          changes: [{ hash: 200, base: { ...extra(200), associated: [5] }, next: member }],
          submitted: { 200: { base: { ...extra(200), associated: [5] }, next: member } },
        },
      }),
    );
    view.useDraftStore.setState({
      drafts: { 200: { base: { ...extra(200), associated: [5] }, next: member } },
    });
    onSave = () =>
      view.useDraftStore.setState({
        drafts: { 200: { base: { ...extra(200), associated: [5] }, next: after } },
      });
    await view.click('Save to batch');
    await view.settle(() => view.useSaveState.getState().review === null);
    const notice = view.useSaveNotice.getState().notice!;
    expect(notice).toMatch(/^Saved 1 tooltip to December patch; not published before .*UTC\./);
    expect(notice).toContain('1 draft changed during the save and stayed in Current.');
    expect(view.useDraftStore.getState().drafts[200]?.next).toEqual(after);
    expect(fixture.members.get(batch.id)?.get(200)?.proposed.text.de?.text).toBe('Deutsch');
  });

  it('refuses before writing when the batch would pass the member cap', async () => {
    const { batch } = await call('/batches', { name: 'Full' });
    const hashes = Array.from({ length: 15 }, (_, i) => 300 + i);
    for (const hash of hashes) fixture.setCurrent(hash, extra(hash));
    await call(`/batches/${batch.id}/save`, {
      revision: batch.revision,
      changes: hashes.map((hash) => ({
        hash,
        base: extra(hash),
        next: { ...extra(hash), associated: [1] },
      })),
    });
    const view = await setup('editor');
    await view.settle(() => Boolean(view.button('Batch') && !view.button('Batch')!.disabled));
    await view.click('Batch');
    expect(host.querySelector('[data-over-cap]')?.textContent).toContain(
      'A batch holds at most 15 tooltips; this save would make 16.',
    );
    const writes = fixture.log.length;
    await view.click('Save to batch');
    await view.settle(() => host.textContent!.includes('Nothing was saved'));
    expect(fixture.log.slice(writes).every((entry) => entry.method === 'GET')).toBe(true);
    expect(view.useDraftStore.getState().drafts[123]).toBeTruthy();
  });

  it('keeps every unconfirmed draft after a partial chunk failure and names them', async () => {
    // A batch of 12, scheduled: translation saves go 10 per request.
    const hashes = Array.from({ length: 12 }, (_, i) => 400 + i);
    for (const hash of hashes) fixture.setCurrent(hash, extra(hash));
    const staged = (hash: number): Tooltip => ({ ...extra(hash), associated: [1] });
    const { batch } = await call('/batches', { name: 'Twelve' });
    await call(`/batches/${batch.id}/save`, {
      revision: batch.revision,
      changes: hashes.map((hash) => ({ hash, base: extra(hash), next: staged(hash) })),
    });
    await call(`/batches/${batch.id}/schedule`, {
      revision: 2,
      notBefore: '2026-12-03T16:00:00.000Z',
      zone: 'UTC',
    });
    const view = await setup('editor');
    const lang = (hash: number, code: 'de' | 'fr', text: string): Tooltip => ({
      ...staged(hash),
      text: {
        ...staged(hash).text,
        [code]: { text, updatedAt: tooltip.text.en!.updatedAt, updatedBy: 'alice' },
      },
    });
    await view.review(
      Object.fromEntries(
        hashes.map((hash) => [hash, { base: staged(hash), next: lang(hash, 'de', `D${hash}`) }]),
      ),
    );
    await view.settle(() => Boolean(view.button('Batch') && !view.button('Batch')!.disabled));
    await view.click('Batch');
    // Another tab writes to the batch between the two chunks: the second is refused (CAS).
    saveHook = async (count, forward) => {
      if (count === 2)
        await call(`/batches/${batch.id}/save`, {
          revision: fixture.batches.get(batch.id)!.revision,
          changes: [{ hash: 400, base: lang(400, 'de', 'D400'), next: lang(400, 'fr', 'F') }],
        });
      return forward();
    };
    await view.click('Save to batch');
    await view.settle(() => host.textContent!.includes('Not saved, drafts kept'));
    expect(host.textContent).toContain('Saved 10 of 12 to Twelve.');
    expect(host.textContent).toContain('Tooltip 410 (410), Tooltip 411 (411)');
    expect(host.textContent).toContain('The batch changed; reload it and retry');
    // Confirmed drafts left; the unconfirmed ones stay exactly as they were.
    expect(Object.keys(view.useDraftStore.getState().drafts).sort()).toEqual(['410', '411']);
    expect(saves).toBe(2);
  });

  it('keeps drafts when the response is lost, then confirms them on the next save', async () => {
    const view = await setup('editor');
    await view.settle(() => Boolean(view.button('New batch…')));
    await view.click('New batch…');
    await type(host.querySelector<HTMLInputElement>('input[aria-label="New batch name"]')!, 'Lost');
    // The Worker commits, but the page never sees the answer (reload, network).
    saveHook = async (_, forward) => {
      await forward();
      throw new TypeError('Failed to fetch');
    };
    await view.click('Save to batch');
    await view.settle(() => host.textContent!.includes('Failed to fetch'));
    expect(host.textContent).toContain('Created Lost, but nothing was saved to it.');
    expect(view.useDraftStore.getState().drafts[123]).toBeTruthy();
    // Saving again: the batch already holds it (no write), confirmed from the member file.
    saveHook = undefined;
    await view.settle(() => Boolean(view.button('Batch') && !view.button('Batch')!.disabled));
    await view.click('Batch');
    await view.click('Save to batch');
    await view.settle(() => view.useSaveState.getState().review === null);
    expect(view.useDraftStore.getState().drafts).toEqual({});
    expect(view.useSaveNotice.getState().notice).toMatch(/^Saved 1 tooltip to Lost;/);
  });

  it('shows a conflict with another tab saving the same tooltip verbatim and keeps the draft', async () => {
    const { batch } = await call('/batches', { name: 'Shared' });
    // Another tab already staged different English for 123.
    await call(`/batches/${batch.id}/save`, {
      revision: batch.revision,
      changes: [
        {
          hash: 123,
          base: tooltip,
          next: { ...tooltip, text: { en: { ...tooltip.text.en!, text: 'Theirs' } } },
        },
      ],
    });
    const view = await setup('editor');
    await view.settle(() => Boolean(view.button('Batch') && !view.button('Batch')!.disabled));
    await view.click('Batch');
    await view.click('Save to batch');
    await view.settle(() => host.textContent!.includes('Nothing was saved to Shared'));
    expect(host.textContent).toContain(
      'These tooltips changed in the batch or in current meanwhile',
    );
    expect(host.textContent).toContain('Perk (123): English');
    expect(view.useDraftStore.getState().drafts[123]?.next).toEqual(edited);
    expect(fixture.members.get(batch.id)?.get(123)?.proposed.text.en?.text).toBe('Theirs');
    expect(saves).toBe(1);
  });

  it('saves the staged drafts of the batch in the same request and reconciles them', async () => {
    const { batch } = await call('/batches', { name: 'Staged' });
    const proposal = { ...extra(200), associated: [2] };
    await call(`/batches/${batch.id}/save`, {
      revision: batch.revision,
      changes: [{ hash: 200, base: extra(200), next: proposal }],
    });
    const view = await setup('editor');
    const more = { ...proposal, associated: [2, 3] };
    view.useBatchDraftStore.setState({
      drafts: { [`batch:${batch.id}:200`]: { base: proposal, next: more } },
      hydrated: true,
      owner: '1',
      error: null,
    });
    await view.settle(() => Boolean(view.button('Batch') && !view.button('Batch')!.disabled));
    await view.click('Batch');
    expect(host.querySelector('[data-destination-note]')?.textContent).toContain(
      'Also saves 1 draft already staged for this batch.',
    );
    await view.click('Save to batch');
    await view.settle(() => view.useSaveState.getState().review === null);
    expect(saves).toBe(1);
    expect(fixture.members.get(batch.id)?.get(200)?.proposed.associated).toEqual([2, 3]);
    expect(fixture.members.get(batch.id)?.get(123)?.proposed.text.en?.text).toBe('Batch English');
    expect(view.useBatchDraftStore.getState().drafts).toEqual({});
    expect(view.useDraftStore.getState().drafts).toEqual({});
    expect(view.useSaveNotice.getState().notice).toMatch(/^Saved 2 tooltips to Staged;/);
  });

  it('offers no destination to translators, nor with the switch OFF', async () => {
    let view = await setup('translator');
    await view.settle(() => Boolean(view.button('Save changes')));
    expect(host.querySelector('[data-destination]')).toBeNull();
    expect(view.button('Batch')).toBeUndefined();
    expect(fixture.log).toEqual([]);
    await act(async () => root.unmount());
    host.remove();
    fixture.log.length = 0;
    view = await setup('editor', '0');
    await view.settle();
    expect(view.button('New batch…')).toBeUndefined();
    expect(fixture.log).toEqual([]);
  });
});
