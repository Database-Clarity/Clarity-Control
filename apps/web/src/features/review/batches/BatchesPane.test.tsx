// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
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

async function mount(role: FixtureRole, search = '?view=batches') {
  fixture.setUser({ id: 1, login: 'mia', role, languages: ['de'] });
  const { BatchesList, BatchesMain, BatchesHeader } = await import('./BatchesPane');
  const { resetBatches } = await import('./store');
  const { useAuthStore } = await import('../../../stores/auth');
  const { useDataStore } = await import('../../../stores/data');
  resetBatches();
  useDataStore.setState({ status: 'ready', data: structuredClone(data) as never });
  useAuthStore.setState({
    user: role ? { id: 1, login: 'mia', role, languages: ['de'] } : null,
    loading: false,
  });
  const router = createMemoryRouter(
    [
      {
        path: '/review',
        element: (
          <>
            <aside>
              <BatchesList />
            </aside>
            <header>
              <BatchesHeader />
            </header>
            <main>
              <BatchesMain />
            </main>
          </>
        ),
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
    expect(view.button('Resolve')?.disabled).toBe(true);
    const apply = [...block.querySelectorAll('label')].find((node) =>
      node.textContent?.includes('Apply upcoming'),
    )!;
    await act(async () => apply.querySelector('input')!.click());
    await view.click('Resolve');
    await view.settle(() => !view.host.querySelector('[data-conflict="10"]'));
    expect(fixture.conflicts.size).toBe(0);
    await view.unmount();
  });

  it('loads archived audit events on demand', async () => {
    const batch = await seed();
    fixture.addEvents(batch.id, 203);
    const view = await mount('maintainer');
    await view.settle(() => Boolean(view.button('Load older events')));
    expect(view.text()).toContain('Events (200+)');
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
});

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
