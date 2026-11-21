// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider, useSearchParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import {
  createBatchFixture,
  type BatchFixture,
  type FixtureRole,
} from '../../../services/scheduled/fixtureWorker.testSupport';

vi.mock('../../../ui/Dialog', () => ({
  Dialog: ({
    children,
    footer,
    title,
  }: {
    children: ReactNode;
    footer?: ReactNode;
    title: string;
  }) => createElement('div', { 'data-dialog': title }, children, footer),
}));
vi.mock('../../history/TooltipDiff', () => ({
  TooltipDiff: ({ before, current }: { before: Tooltip | null; current: Tooltip }) =>
    createElement('div', {
      'data-diff': `${before?.text.en?.text ?? 'none'} -> ${current.text.en?.text ?? ''}`,
    }),
}));

const stamp = { updatedAt: '2026-11-01T00:00:00.000Z', updatedBy: 'a' };
const tooltip = (hash: number, en: string, extra: Partial<Tooltip['text']> = {}): Tooltip => ({
  hash,
  associated: [],
  text: { en: { text: en, ...stamp }, ...extra },
});
const current: Record<number, Tooltip> = {
  10: tooltip(10, 'Ten'),
  11: tooltip(11, 'Eleven'),
  12: tooltip(12, 'Twelve'),
};
const data = {
  aliases: {},
  categories: [{ id: 'perks', label: 'Perks', group: 'Weapons', order: 1 }],
  items: {
    10: { hash: 10, name: 'Rampage', icon: '', categoryId: 'perks' },
    11: { hash: 11, name: 'Kill Clip', icon: '', categoryId: 'perks' },
    12: { hash: 12, name: 'Outlaw', icon: '', categoryId: 'perks' },
  },
  bundle: {
    sourceCommit: 'test',
    generatedAt: '2026-02-01T00:00:00Z',
    tooltips: current,
    permissions: { users: {} },
    // 10 and 12 were published before; 11 never was (a first publication).
    pushed: { 10: 'x', 12: 'y' },
  },
};

let fixture: BatchFixture;
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_API_URL', 'https://worker.example/');
  vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
  for (const name of ['localStorage', 'sessionStorage'])
    vi.stubGlobal(name, { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture = createBatchFixture({
    current: structuredClone(current),
    user: { id: 1, login: 'mia', role: 'maintainer' },
    pushed: [10, 12],
  });
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    fixture.fetch(input, init),
  );
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function call(path: string, body: unknown) {
  const response = await fixture.handle(
    new Request(`https://worker.example${path}`, { method: 'POST', body: JSON.stringify(body) }),
  );
  if (!response!.ok) throw new Error(`${path}: ${response!.status} ${await response!.text()}`);
  return (await response!.json()) as { batch: { id: string; revision: number } };
}

/** "December patch": new English for 10 (published before) and 11 (never published). */
async function seed() {
  const { batch } = await call('/batches', { name: 'December patch' });
  const saved = await call(`/batches/${batch.id}/save`, {
    revision: batch.revision,
    changes: [
      { hash: 10, base: current[10], next: tooltip(10, 'Ten, upcoming') },
      { hash: 11, base: current[11], next: tooltip(11, 'Eleven, upcoming') },
    ],
  });
  return saved.batch;
}

async function mount(role: FixtureRole, search = '?view=batches', initialPhone = false) {
  fixture.setUser({ id: 1, login: 'mia', role, languages: ['de'] });
  const { BatchesList, BatchesMain, BatchesHeader, SubviewSwitch } = await import('./BatchesPane');
  const { phoneQuery, useMedia } = await import('../../../ui/useMedia');
  const { resetBatches } = await import('./store');
  const { useAuthStore } = await import('../../../stores/auth');
  const { useDataStore } = await import('../../../stores/data');
  resetBatches();
  useDataStore.setState({ status: 'ready', data: structuredClone(data) as never });
  useAuthStore.setState({
    user: role ? { id: 1, login: 'mia', role, languages: ['de'] } : null,
    loading: false,
  });
  const media = Object.assign(new EventTarget(), { matches: initialPhone });
  vi.stubGlobal('matchMedia', () => media);
  function Workspace() {
    const phone = useMedia(phoneQuery);
    const [params] = useSearchParams();
    const batches = params.get('view') === 'batches';
    return (
      <>
        {batches && !phone && (
          <aside>
            <BatchesList />
          </aside>
        )}
        <header>
          <SubviewSwitch />
          {batches && <BatchesHeader />}
        </header>
        <main>{batches ? <BatchesMain phone={phone} /> : <p>Saved changes</p>}</main>
      </>
    );
  }
  const router = createMemoryRouter(
    [
      {
        path: '/review',
        element: <Workspace />,
      },
    ],
    { initialEntries: [`/review${search}`] },
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<RouterProvider router={router} />));
  const settle = async (done: () => boolean = () => true) => {
    for (let i = 0; i < 400 && !done(); i++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    for (let i = 0; i < 6; i++)
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
  const detail = () => host.querySelector<HTMLElement>('main [data-batch]');
  await settle(() => Boolean(detail()) || Boolean(host.querySelector('main p')));
  return {
    host,
    router,
    settle,
    button,
    click,
    detail,
    resize: (phone: boolean) =>
      act(async () => {
        media.matches = phone;
        media.dispatchEvent(new Event('change'));
      }),
    text: () => host.textContent ?? '',
    unmount: () => act(async () => root.unmount()),
  };
}

const setInput = async (input: HTMLInputElement | HTMLSelectElement, value: string) => {
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(input, value);
  await act(async () => {
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
};

/** The editor's current saved data (the data store) moves, as a reload would show. */
async function setCurrent(hash: number, next: Tooltip) {
  const { useDataStore } = await import('../../../stores/data');
  await act(async () =>
    useDataStore.setState((state) => ({
      data: {
        ...state.data!,
        bundle: {
          ...state.data!.bundle,
          tooltips: { ...state.data!.bundle.tooltips, [hash]: next },
        },
      },
    })),
  );
}

describe('Review → Batches', () => {
  it('enters the phone list and restores the selected row on both Back paths', async () => {
    const batch = await seed();
    const start = `?query=Rampage&kind=new&batch=${batch.id}`;
    const view = await mount('maintainer', start, true);
    const row = () => view.host.querySelector<HTMLAnchorElement>(`[data-batch-row="${batch.id}"]`);
    const backLabel = '‹ Back to batches';
    const listSearch = '?query=Rampage&kind=new&view=batches';
    await view.click('Batches');
    await view.settle(() => !!row());
    expect(view.router.state.location.search).toBe(listSearch);
    expect(view.detail()).toBeNull();
    expect(row()?.hasAttribute('aria-current')).toBe(false);

    await act(async () => row()!.click());
    await view.settle(() => !!view.detail());
    expect(view.detail()?.dataset.batch).toBe(batch.id);
    expect(view.router.state.location.search).toBe(`${listSearch}&batch=${batch.id}`);
    expect(row()).toBeNull();
    expect(document.activeElement).toBe(view.button(backLabel));

    await act(async () => view.router.navigate(-1));
    expect(document.activeElement).toBe(row());
    expect(view.router.state.location.search).toBe(listSearch);
    await act(async () => view.router.navigate(1));
    expect(view.detail()?.dataset.batch).toBe(batch.id);
    await view.click(backLabel);
    expect(document.activeElement).toBe(row());
    expect(view.router.state.location.search).toBe(listSearch);

    await act(async () => row()!.click());
    await view.click('Saved');
    expect(view.text()).toContain('Saved changes');
    expect(view.router.state.location.search).toBe(start);
    await view.click('Batches');
    expect(view.router.state.location.search).toBe(listSearch);
    expect(view.detail()).toBeNull();
    await view.unmount();
  });

  it('honors a direct batch link across resize and stays in Batches when going back to the list', async () => {
    const batch = await seed();
    const search = `?view=batches&batch=${batch.id}`;
    const view = await mount('maintainer', search, true);
    await view.settle(() => !!view.detail());
    const detail = view.detail();
    expect(detail?.dataset.batch).toBe(batch.id);
    await view.resize(false);
    expect(view.host.querySelector('aside [aria-current="true"]')).toBeTruthy();
    expect(view.button('‹ Back to batches')).toBeUndefined();
    await view.resize(true);
    expect(view.detail()).toBe(detail);
    expect(view.router.state.location.search).toBe(search);
    await view.click('‹ Back to batches');
    expect(view.router.state.location.search).toBe('?view=batches');
    expect(document.activeElement?.getAttribute('data-batch-row')).toBe(batch.id);
    await view.resize(false);
    expect(view.detail()?.dataset.batch).toBe(batch.id);
    await view.resize(true);
    expect(view.detail()).toBeNull();
    await view.unmount();
  });

  it('keeps the desktop split view and replaces the batch selection in its history entry', async () => {
    const first = await seed();
    const { batch: second } = await call('/batches', { name: 'Second batch' });
    const view = await mount('maintainer', `?batch=${first.id}`);
    await view.click('Batches');
    await view.settle(() => !!view.detail());
    expect(view.detail()?.dataset.batch).toBe(first.id);
    const row = view.host.querySelector<HTMLAnchorElement>(
      `aside [data-batch-row="${second.id}"]`,
    )!;
    await act(async () => row.click());
    await view.settle(() => view.detail()?.dataset.batch === second.id);
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(view.detail()?.dataset.batch).toBe(second.id);
    await act(async () => view.router.navigate(-1));
    expect(view.text()).toContain('Saved changes');
    await view.unmount();
  });

  it('keeps a deleted phone batch distinct from the empty list and focuses the list on Back', async () => {
    const view = await mount('maintainer', '?view=batches&batch=deleted', true);
    await view.settle(() => view.text().includes('That batch is no longer listed.'));
    expect(view.detail()).toBeNull();
    expect(view.text()).toContain('That batch is no longer listed.');
    await view.click('‹ Back to batches');
    expect(view.text()).toContain('No batches yet.');
    expect(document.activeElement).toBe(view.host.querySelector('[aria-label="Batch list"]'));
    await view.unmount();
  });

  it('lists a draft batch and shows its changes, first publications, and the task strip', async () => {
    const batch = await seed();
    const view = await mount('maintainer');
    await view.settle(() => view.text().includes('First publication'));
    const row = view.host.querySelector(`[data-batch-row="${batch.id}"]`)!;
    expect(row.textContent).toContain('December patch');
    expect(row.textContent).toContain('Draft');
    expect(row.textContent).toContain('No time set');
    expect(row.textContent).toContain('2 tooltips');
    expect(view.detail()?.dataset.status).toBe('draft');
    expect(view.text()).toContain('Created by @mia');
    expect(view.text()).toContain('rev 2 · content 1');
    const members = [...view.host.querySelectorAll<HTMLElement>('[data-member]')];
    expect(members.map((node) => node.dataset.member)).toEqual(['10', '11']);
    // 11 was never published: it publishes whole.
    expect(members[1].textContent).toContain('First publication');
    expect(members[0].textContent).not.toContain('First publication');
    expect(view.button('Schedule…')?.disabled).toBe(false);
    expect(view.button('Publish now')).toBeTruthy();
    expect(view.button('Cancel batch…')).toBeTruthy();
    expect(view.button('Unschedule')).toBeUndefined();
    // The diff vs current saved opens in place.
    await act(async () => members[0].querySelector('button')!.click());
    expect(members[0].querySelector('[data-diff]')?.getAttribute('data-diff')).toBe(
      'Ten -> Ten, upcoming',
    );
    await view.unmount();
  });

  it('marks stale members, blocks scheduling, and rebases with a choice per field', async () => {
    const batch = await seed();
    fixture.setCurrent(10, tooltip(10, 'Ten, edited in current'));
    const view = await mount('maintainer');
    await setCurrent(10, tooltip(10, 'Ten, edited in current'));
    await view.settle(() => Boolean(view.host.querySelector('[data-stale-block]')));
    expect(view.host.querySelector(`[data-batch-row="${batch.id}"]`)?.textContent).toContain(
      '1 stale',
    );
    expect(view.button('Schedule…')?.disabled).toBe(true);
    expect(view.text()).toContain('Rebase 1 stale tooltip first.');
    const block = view.host.querySelector<HTMLElement>('[data-stale-block]')!;
    // The conflict block: mine = batch, theirs = current.
    expect(block.textContent).toContain('Batch (mine)');
    expect(block.textContent).toContain('Current (theirs)');
    // Each caption sits above its own lines.
    const pre = block.querySelector('pre')!.textContent!;
    const order = ['Batch (mine)', 'Ten, upcoming', 'Current (theirs)', 'Ten, edited in current'];
    expect(order.map((part) => pre.indexOf(part))).toEqual(
      order.map((part) => pre.indexOf(part)).sort((x, y) => x - y),
    );
    expect(view.button('Rebase')?.disabled).toBe(true);
    const keep = [...block.querySelectorAll('label')].find((node) =>
      node.textContent?.includes('Keep batch'),
    )!;
    await act(async () => keep.querySelector('input')!.click());
    await view.click('Rebase');
    await view.settle(() => !view.host.querySelector('[data-stale-block]'));
    const member = fixture.members.get(batch.id)!.get(10)!;
    expect(member.base?.text.en?.text).toBe('Ten, edited in current');
    expect(member.proposed.text.en?.text).toBe('Ten, upcoming');
    expect(view.button('Schedule…')?.disabled).toBe(false);
    await view.unmount();
  });

  it('schedules through the dialog (zoned time, UTC line) and shows the scheduled status', async () => {
    const batch = await seed();
    const view = await mount('maintainer');
    await view.settle(() => view.button('Schedule…')?.disabled === false);
    await view.click('Schedule…');
    const dialog = view.host.querySelector<HTMLElement>('[data-dialog]')!;
    expect(dialog.textContent).toContain('Kill Clip');
    const [date, time] = dialog.querySelectorAll('input');
    const zone = dialog.querySelector('select')!;
    await setInput(zone, 'Europe/Berlin');
    await setInput(date, '2026-12-03');
    await setInput(time, '17:00');
    expect(dialog.querySelector('[data-utc]')?.textContent).toBe('16:00 UTC · UTC+01:00');
    // A time Berlin skips is refused before anything is sent.
    await setInput(date, '2027-03-28');
    await setInput(time, '02:30');
    expect(dialog.querySelector('[data-time-error]')?.textContent).toContain('does not exist');
    expect(view.button('Schedule')?.disabled).toBe(true);
    await setInput(date, '2026-12-03');
    await setInput(time, '17:00');
    await view.click('Schedule');
    await view.settle(() => view.detail()?.dataset.status === 'scheduled');
    expect(fixture.batches.get(batch.id)).toMatchObject({
      status: 'scheduled',
      notBefore: '2026-12-03T16:00:00.000Z',
      zone: 'Europe/Berlin',
    });
    expect(view.text()).toContain('(chosen in Europe/Berlin)');
    expect(view.button('Reschedule…')).toBeTruthy();
    expect(view.button('Unschedule')).toBeTruthy();
    await view.click('Unschedule');
    await view.settle(() => view.detail()?.dataset.status === 'draft');
    expect(fixture.batches.get(batch.id)?.status).toBe('draft');
    await view.unmount();
  });

  it('cancels only after the in-place confirmation by its trigger', async () => {
    const batch = await seed();
    const view = await mount('maintainer');
    await view.settle(() => Boolean(view.button('Cancel batch…')));
    await view.click('Cancel batch…');
    expect(view.text()).toContain('It stops for good');
    expect(view.button('Schedule…')).toBeUndefined();
    await view.click('Keep batch');
    expect(fixture.batches.get(batch.id)?.status).toBe('draft');
    await view.click('Cancel batch…');
    await view.click('Cancel batch');
    await view.settle(() => view.detail()?.dataset.status === 'cancelled');
    expect(fixture.batches.get(batch.id)?.status).toBe('cancelled');
    expect(view.text()).toContain('Published and cancelled');
    expect(view.button('Cancel batch…')).toBeUndefined();
    await view.unmount();
  });

  it('confirms Publish now for the revision shown, and drops the confirmation when it moves (code review round 2)', async () => {
    const batch = await seed();
    const view = await mount('maintainer');
    await view.settle(() => view.button('Publish now')?.disabled === false);
    await view.click('Publish now');
    expect(view.text()).toContain('live now, through the publisher?');
    // Race: another editor adds a tooltip before this page re-lists. Confirming sends rev 2.
    await call(`/batches/${batch.id}/save`, {
      revision: 2,
      changes: [{ hash: 12, base: current[12], next: tooltip(12, 'Twelve, upcoming') }],
    });
    await view.click('Publish now');
    await view.settle(() => view.text().includes('The batch changed; reload it and retry'));
    expect(fixture.batches.get(batch.id)?.status).toBe('draft');
    // A new confirmation at rev 3; the batch moves to rev 4 while it is open.
    await view.settle(() => view.text().includes('rev 3') && Boolean(view.button('Publish now')));
    await view.click('Publish now');
    await call(`/batches/${batch.id}/remove`, { revision: 3, hashes: [12] });
    const { refreshBatches } = await import('./store');
    await act(async () => refreshBatches());
    await view.settle(() => view.text().includes('changed while you were confirming'));
    expect(view.text()).toContain('rev 3 → rev 4');
    expect(view.host.querySelector('[aria-label="Confirm publish now"]')).toBeNull();
    expect(fixture.batches.get(batch.id)?.status).toBe('draft');
    await view.unmount();
  });

  it('shows the Worker refusal verbatim when the batch changed meanwhile, then the new state', async () => {
    const batch = await seed();
    const view = await mount('maintainer');
    await view.settle(() => Boolean(view.button('Cancel batch…')));
    // Another editor removes a tooltip after this page read the batch.
    await call(`/batches/${batch.id}/remove`, { revision: 2, hashes: [11] });
    await view.click('Cancel batch…');
    await view.click('Cancel batch');
    await view.settle(() => view.text().includes('The batch changed; reload it and retry'));
    expect(fixture.batches.get(batch.id)?.status).toBe('draft');
    // The refusal re-listed: the detail now shows revision 3 with one member.
    await view.settle(() => view.text().includes('rev 3'));
    expect(view.host.querySelectorAll('[data-member]')).toHaveLength(1);
    await view.unmount();
  });

  it('picks up a batch change arriving while open', async () => {
    const batch = await seed();
    const view = await mount('maintainer');
    await view.settle(() => view.text().includes('rev 2'));
    await call(`/batches/${batch.id}/save`, {
      revision: 2,
      changes: [{ hash: 12, base: current[12], next: tooltip(12, 'Twelve, upcoming') }],
    });
    await view.click('Refresh');
    await view.settle(() => view.text().includes('rev 3'));
    expect(view.host.querySelectorAll('[data-member]')).toHaveLength(3);
    await view.unmount();
  });

  it('shows Publishing, then Overdue with Kick, then Published with its completion time', async () => {
    const batch = await seed();
    await call(`/batches/${batch.id}/schedule`, {
      revision: 2,
      notBefore: '2026-11-13T12:10:00.000Z',
      zone: 'UTC',
    });
    fixture.claim(batch.id);
    fixture.setNow(() => new Date('2026-11-13T12:20:00.000Z'));
    vi.setSystemTime(new Date('2026-11-13T12:20:00.000Z'));
    try {
      const view = await mount('maintainer');
      await view.settle(() => view.detail()?.dataset.status === 'publishing');
      expect(view.text()).toContain('Overdue');
      expect(view.text()).toContain('Publishing: started');
      expect(view.button('Schedule…')).toBeUndefined();
      await view.click('Kick');
      await view.settle(() => view.text().includes('Kicked'));
      expect(fixture.kicks).toEqual([batch.id]);
      fixture.publish(batch.id, 'observed', '2026-11-13T12:21:00.000Z');
      await view.click('Refresh');
      await view.settle(() => view.detail()?.dataset.status === 'published');
      const status = view.host.querySelector('[data-status-line]')!.textContent!;
      expect(status).toContain('Published');
      expect(status).toContain('first observed after an interrupted run');
      expect(view.button('Kick')).toBeUndefined();
      await view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a failed run to draft with the reason per tooltip', async () => {
    const batch = await seed();
    await call(`/batches/${batch.id}/schedule`, {
      revision: 2,
      notBefore: '2026-12-03T16:00:00.000Z',
      zone: 'UTC',
    });
    fixture.failRun(batch.id, 'stale', [{ hash: 10, status: 'stale', fields: ['text.en'] }]);
    const view = await mount('maintainer');
    await view.settle(() => view.text().includes('Last run failed'));
    const status = view.host.querySelector('[data-status-line]')!.textContent!;
    expect(status).toContain('Last run failed: Current changed under the batch');
    expect(status).toContain('Rampage 10 stale: English');
    expect(view.detail()?.dataset.status).toBe('draft');
    await view.unmount();
  });

  it('resolves an activation conflict with Apply upcoming / Keep current', async () => {
    const batch = await seed();
    await call(`/batches/${batch.id}/schedule`, {
      revision: 2,
      notBefore: '2026-12-03T16:00:00.000Z',
      zone: 'UTC',
    });
    fixture.publish(batch.id);
    fixture.addConflict(batch.id, 10, tooltip(10, 'Ten, edited before RECORD'));
    const view = await mount('maintainer');
    // The editor's current saved is what the fixture holds now.
    await setCurrent(10, tooltip(10, 'Ten, edited before RECORD'));
    await view.settle(() => Boolean(view.host.querySelector('[data-conflict="10"]')));
    const block = view.host.querySelector<HTMLElement>('[data-conflict="10"]')!;
    expect(view.text()).toContain('Activation conflicts (1)');
    // Published: no stale block or rebase talk for the member, only a pointer to the conflict.
    expect(view.host.querySelector('[data-stale-block]')).toBeNull();
    expect(view.host.querySelector('[data-member="10"]')?.textContent).toContain(
      'Activation conflict',
    );
    expect(view.text()).not.toContain('Unschedule the batch to rebase it.');
    expect(view.button('Resolve')?.disabled).toBe(true);
    const apply = [...block.querySelectorAll('label')].find((node) =>
      node.textContent?.includes('Apply upcoming'),
    )!;
    await act(async () => apply.querySelector('input')!.click());
    await view.click('Resolve');
    await view.settle(() => !view.host.querySelector('[data-conflict="10"]'));
    expect(fixture.conflicts.size).toBe(0);
    // The resolution is current saved in the editor now (data store and saved overlay).
    const { useDataStore } = await import('../../../stores/data');
    expect(useDataStore.getState().data?.bundle.tooltips[10]?.text.en?.text).toBe('Ten, upcoming');
    await view.unmount();
  });

  it('approves only the revision the Schedule dialog opened on (code review round 1)', async () => {
    const batch = await seed();
    const view = await mount('maintainer');
    await view.settle(() => view.button('Schedule…')?.disabled === false);
    await view.click('Schedule…');
    const dialog = view.host.querySelector<HTMLElement>('[data-dialog]')!;
    const [date, time] = dialog.querySelectorAll('input');
    await setInput(dialog.querySelector('select')!, 'UTC');
    await setInput(date, '2026-12-03');
    await setInput(time, '16:00');
    // Another editor adds a tooltip while the dialog is open; the listing picks it up.
    await call(`/batches/${batch.id}/save`, {
      revision: 2,
      changes: [{ hash: 12, base: current[12], next: tooltip(12, 'Twelve, upcoming') }],
    });
    const { refreshBatches } = await import('./store');
    await act(async () => refreshBatches());
    await view.settle(() => Boolean(view.host.querySelector('[data-batch-moved]')));
    expect(view.host.querySelector('[data-batch-moved]')?.textContent).toContain('rev 2 → rev 3');
    // The first-publication list stays the one opened (Kill Clip), and nothing can be sent.
    expect(
      [...dialog.querySelectorAll('[aria-label="First publications"] li')].map(
        (node) => node.textContent,
      ),
    ).toEqual(['Kill Clip 11']);
    expect(view.button('Schedule')?.disabled).toBe(true);
    expect(fixture.batches.get(batch.id)?.status).toBe('draft');
    await view.unmount();
  });

  it('re-lists after a Schedule refusal, so a removed member cannot be scheduled blind', async () => {
    const batch = await seed();
    const view = await mount('maintainer');
    await view.settle(() => view.button('Schedule…')?.disabled === false);
    await view.click('Schedule…');
    const dialog = view.host.querySelector<HTMLElement>('[data-dialog]')!;
    const [date, time] = dialog.querySelectorAll('input');
    await setInput(dialog.querySelector('select')!, 'UTC');
    await setInput(date, '2026-12-03');
    await setInput(time, '16:00');
    // Another tab removes 11 without this page noticing.
    await call(`/batches/${batch.id}/remove`, { revision: 2, hashes: [11] });
    await view.click('Schedule');
    await view.settle(() => Boolean(view.host.querySelector('[data-batch-moved]')));
    expect(dialog.textContent).toContain('The batch changed; reload it and retry');
    expect(view.button('Schedule')?.disabled).toBe(true);
    expect(fixture.batches.get(batch.id)?.status).toBe('draft');
    await view.unmount();
  });

  it('adopts the current a resolve refusal returns, then resolves against it', async () => {
    const batch = await seed();
    await call(`/batches/${batch.id}/schedule`, {
      revision: 2,
      notBefore: '2026-12-03T16:00:00.000Z',
      zone: 'UTC',
    });
    fixture.publish(batch.id);
    fixture.addConflict(batch.id, 10, tooltip(10, 'Ten, edited before RECORD'));
    const view = await mount('maintainer');
    await setCurrent(10, tooltip(10, 'Ten, edited before RECORD'));
    // Current moves again on the server; this page still shows the RECORD one.
    fixture.setCurrent(10, tooltip(10, 'Ten, moved again'));
    await view.settle(() => Boolean(view.host.querySelector('[data-conflict="10"]')));
    const choose = async (label: string) => {
      const block = view.host.querySelector<HTMLElement>('[data-conflict="10"]')!;
      const option = [...block.querySelectorAll('label')].find((node) =>
        node.textContent?.includes(label),
      )!;
      await act(async () => option.querySelector('input')!.click());
    };
    await choose('Apply upcoming');
    await view.click('Resolve');
    await view.settle(() => view.text().includes('Current changed; review the conflict again'));
    const { useDataStore } = await import('../../../stores/data');
    expect(useDataStore.getState().data?.bundle.tooltips[10]?.text.en?.text).toBe(
      'Ten, moved again',
    );
    // The old choice is void: choose again against the new current.
    expect(view.button('Resolve')?.disabled).toBe(true);
    expect(view.host.querySelector('[data-conflict="10"]')?.textContent).toContain(
      'Ten, moved again',
    );
    await choose('Apply upcoming');
    await view.click('Resolve');
    await view.settle(() => !view.host.querySelector('[data-conflict="10"]'));
    expect(fixture.conflicts.size).toBe(0);
    expect(useDataStore.getState().data?.bundle.tooltips[10]?.text.en?.text).toBe('Ten, upcoming');
    await view.unmount();
  });

  it('loads archived audit events on demand', async () => {
    const batch = await seed();
    fixture.addEvents(batch.id, 203);
    const view = await mount('maintainer');
    await view.settle(() => Boolean(view.button('Load older events')));
    expect(view.text()).toContain('Events (20+)');
    await view.click('Load older events');
    await view.settle(() => view.text().includes('Events (205)'));
    expect(view.text()).toContain('created the batch');
    await view.unmount();
  });

  it('gives translators the list and detail without any write action', async () => {
    await seed();
    const view = await mount('translator');
    await view.settle(() => view.text().includes('First publication'));
    expect(view.button('New batch…')).toBeUndefined();
    expect(view.button('Schedule…')).toBeUndefined();
    expect(view.button('Remove')).toBeUndefined();
    await view.unmount();
  });

  it('creates a batch from the list (maintainers and editors)', async () => {
    const view = await mount('editor');
    await view.settle(() => view.text().includes('No batches yet'));
    await view.click('New batch…');
    const input = view.host.querySelector<HTMLInputElement>('input[aria-label="New batch name"]')!;
    await setInput(input, 'January');
    await view.click('Create');
    await view.settle(() => Boolean(view.detail()));
    expect([...fixture.batches.values()].map((batch) => batch.name)).toEqual(['January']);
    expect(view.router.state.location.search).toContain('batch=');
    await view.unmount();
  });

  it('keeps the current phone detail when a batch created from a previous entry finishes', async () => {
    const batch = await seed();
    const view = await mount('maintainer', '?view=batches', true);
    const row = () => view.host.querySelector<HTMLAnchorElement>(`[data-batch-row="${batch.id}"]`);
    await view.settle(() => !!row());
    let finishCreate!: () => void;
    const release = new Promise<void>((resolve) => {
      finishCreate = resolve;
    });
    const fetchBatch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://worker.example/batches' && init?.method === 'POST')
        await release;
      return fixture.fetch(input, init);
    });
    vi.stubGlobal('fetch', fetchBatch);
    await view.click('New batch…');
    await setInput(view.host.querySelector('input[aria-label="New batch name"]')!, 'January');
    await view.click('Create');
    expect(view.button('Creating...')?.disabled).toBe(true);

    await act(async () => row()!.click());
    await view.settle(() => !!view.detail());
    await act(async () => finishCreate());
    const { useBatches } = await import('./store');
    await view.settle(
      () => useBatches.getState().entries?.some(({ name }) => name === 'January') === true,
    );
    expect(view.detail()?.dataset.batch).toBe(batch.id);
    await view.click('‹ Back to batches');
    expect(view.router.state.location.search).toBe('?view=batches');
    expect(document.activeElement).toBe(row());
    expect(view.text()).toContain('January');
    await view.unmount();
  });
});

describe('Review → Batches: prepared requests (scheduling off the Worker)', () => {
  const requestId = '01JF00000000000000000000RQ';
  async function requestSchedule(
    id: string,
    revision: number,
    notBefore = '2026-12-03T16:00:00.000Z',
  ) {
    await call(`/batches/${id}/schedule`, { requestId, revision, notBefore, zone: 'UTC' });
  }

  it('shows Preparing, then Needs attention with exact reasons, run link, and Unschedule', async () => {
    const batch = await seed();
    await requestSchedule(batch.id, 2);
    const view = await mount('maintainer');
    await view.settle(() => view.text().includes('Preparing: schedule requested'));
    const row = view.host.querySelector(`[data-batch-row="${batch.id}"]`)!;
    expect(row.textContent).toContain('Preparing');
    expect(view.text()).toContain('Not published before');
    // Nothing that would bypass the outstanding request is offered.
    expect(view.button('Schedule…')).toBeUndefined();
    expect(view.button('Publish now')).toBeUndefined();
    expect(view.button('Kick')).toBeUndefined();
    expect(view.button('Retry')).toBeUndefined();
    expect(view.button('Unschedule')).toBeDefined();
    fixture.failRequest(
      requestId,
      [{ reason: 'current changed', hash: 10, fields: ['text.en'] }],
      false,
      'https://github.com/o/r/actions/runs/7',
    );
    await view.click('Refresh');
    await view.settle(() => view.text().includes('Needs attention: the requested schedule'));
    expect(row.textContent).toContain('Needs attention');
    expect(view.text()).toContain('Rampage (10) English: current changed');
    expect(view.text()).toContain('last attempt');
    const link = view.host.querySelector<HTMLAnchorElement>('[data-preparation] a')!;
    expect(link.href).toBe('https://github.com/o/r/actions/runs/7');
    expect(link.rel).toBe('noreferrer');
    expect(view.button('Retry')).toBeUndefined();
    await view.click('Unschedule');
    await view.settle(() => view.detail()?.dataset.status === 'draft');
    expect(fixture.requests.get(requestId)?.record.status).toBe('cancelled');
    expect(view.button('Schedule…')).toBeDefined();
    await view.unmount();
  });

  it('retries an infrastructure failure with the same request, then shows Scheduled', async () => {
    const batch = await seed();
    await requestSchedule(batch.id, 2);
    fixture.failRequest(requestId, [{ reason: 'Runner lost' }], true);
    const view = await mount('maintainer');
    await view.settle(() => Boolean(view.button('Retry')));
    expect(view.text()).toContain('failed for an infrastructure reason');
    await view.click('Retry');
    await view.settle(() => view.text().includes('attempt 2'));
    expect(view.detail()?.dataset.status).toBe('preparing');
    expect(posts(fixture).filter((path) => path.endsWith('/retry'))).toHaveLength(1);
    fixture.completeRequest(requestId);
    await view.click('Refresh');
    await view.settle(() => view.detail()?.dataset.status === 'scheduled');
    expect(view.host.querySelector('[data-preparation]')).toBeNull();
    expect(view.button('Reschedule…')).toBeDefined();
    await view.unmount();
  });

  it('shows "Preparing · overdue" with Retry (never Kick) past the target time', async () => {
    const batch = await seed();
    await requestSchedule(batch.id, 2, '2026-11-13T12:10:00.000Z');
    vi.setSystemTime(new Date('2026-11-13T12:20:00.000Z'));
    try {
      const view = await mount('maintainer');
      await view.settle(() => view.text().includes('Preparing · overdue'));
      expect(view.text()).toContain('nothing publishes yet');
      expect(view.button('Retry')).toBeDefined();
      expect(view.button('Kick')).toBeUndefined();
      expect(view.text()).toContain('1 overdue');
      await view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers Edit for a queued draft save, Cancel after confirmation, and translators only their own Retry', async () => {
    const batch = await seed();
    await call(`/batches/${batch.id}/save`, {
      requestId,
      revision: 2,
      changes: [{ hash: 12, base: current[12], next: tooltip(12, 'Twelve, upcoming') }],
      message: 'Stage',
    });
    fixture.failRequest(requestId, [{ reason: 'Runner lost' }], true);
    const translator = await mount('translator');
    await translator.settle(() => translator.text().includes('Needs attention: the queued save'));
    // The fixture's requester is user 1, the translator here: own save, so Retry only.
    expect(translator.button('Retry')).toBeDefined();
    expect(translator.button('Edit')).toBeUndefined();
    expect(translator.button('Cancel batch…')).toBeUndefined();
    await translator.unmount();
    document.body.innerHTML = '';
    const view = await mount('maintainer');
    await view.settle(() => Boolean(view.button('Edit')));
    await view.click('Cancel batch…');
    await view.click('Cancel batch');
    await view.settle(() => view.detail()?.dataset.status === 'cancelled');
    expect(fixture.requests.get(requestId)?.record.status).toBe('cancelled');
    await view.unmount();
  });
});

describe('Review → Batches: a failed background save that kept the batch scheduled', () => {
  it('shows FAILED with the request reasons and keeps Scheduled and its actions', async () => {
    const batch = await seed();
    const scheduled = await call(`/batches/${batch.id}/schedule`, {
      revision: 2,
      notBefore: '2026-12-03T16:00:00.000Z',
      zone: 'UTC',
    });
    const requestId = '01JF00000000000000000000TS';
    await call(`/batches/${batch.id}/save`, {
      requestId,
      revision: scheduled.batch.revision,
      changes: [
        { hash: 10, base: tooltip(10, 'Ten, upcoming'), next: tooltip(10, 'Ten, upcoming') },
      ],
      message: 'Translate',
    });
    fixture.failSaveKeepScheduled(requestId, [
      { reason: 'German stamp is older than English', hash: 10 },
    ]);
    const view = await mount('maintainer');
    await view.settle(() => view.text().includes('Save failed'));
    expect(view.detail()?.dataset.status).toBe('scheduled');
    const line = view.host.querySelector('[data-failed-save]')!.textContent!;
    expect(line).toContain('nothing from it was applied');
    expect(line).toContain('Rampage (10): German stamp is older than English');
    expect(view.detail()?.textContent).not.toContain('Saved');
    expect(view.button('Reschedule…')).toBeDefined();
    await view.unmount();
  });
});

/** POST paths the fixture answered. */
const posts = (worker: BatchFixture) =>
  worker.log.filter(({ method }) => method === 'POST').map(({ path }) => path);

describe('Batches subview gate', () => {
  it('is Saved, with no switch and no Batches chunk, when the build switch is OFF', async () => {
    vi.stubEnv('VITE_SCHEDULED_ENABLED', '0');
    const subview = await import('../subview');
    const user = { id: 1, login: 'mia', role: 'maintainer' as const };
    expect(subview.reviewSubview(new URLSearchParams('view=batches'), user)).toBe('saved');
    expect(subview.SubviewSwitch).toBeNull();
    expect(subview.BatchesMain).toBeNull();
    expect(subview.BatchesList).toBeNull();
  });

  it('is Saved for trials and signed-out visitors (Q3), Batches for readers', async () => {
    const { reviewSubview } = await import('../subview');
    const params = new URLSearchParams('view=batches');
    expect(reviewSubview(params, { id: 1, login: 't', role: 'trial' })).toBe('saved');
    expect(reviewSubview(params, null)).toBe('saved');
    for (const role of ['maintainer', 'editor', 'translator'] as const)
      expect(reviewSubview(params, { id: 1, login: 'x', role })).toBe('batches');
    expect(reviewSubview(new URLSearchParams(), { id: 1, login: 'x', role: 'editor' })).toBe(
      'saved',
    );
  });
});
