// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../../services/api';
import type { PaneReport } from './api';

const calls = vi.hoisted(() => ({
  fetch: [] as { hash: number; lang: string }[],
  actions: [] as { id: string; expected: number; action: unknown }[],
  reports: [] as unknown[],
  actionResult: null as null | (() => unknown),
  shots: {} as Record<number, string>,
}));
vi.mock('./api', async (original) => {
  const actual = await original<typeof import('./api')>();
  return {
    ...actual,
    fetchTooltipReports: vi.fn(async (hash: number, lang: string) => {
      calls.fetch.push({ hash, lang });
      return structuredClone(calls.reports);
    }),
    postReportAction: vi.fn(async (id: string, expected: number, action: { action: string }) => {
      calls.actions.push({ id, expected, action });
      if (calls.actionResult) return calls.actionResult();
      const status =
        action.action === 'reject'
          ? 'rejected'
          : action.action === 'reopen'
            ? 'open'
            : action.action === 'close'
              ? 'closed'
              : 'triaged';
      return { id, status, version: expected + 1 };
    }),
    deleteReport: vi.fn(async () => undefined),
    fetchScreenshot: vi.fn(async (_id: string, n: number) => calls.shots[n] ?? null),
  };
});
vi.mock('./indexStore', async (original) => ({
  ...(await original<typeof import('./indexStore')>()),
  refreshReportsIndex: vi.fn(),
}));

import { ReportsHttpError } from './api';
import { ReportsPane } from './ReportsPane';
import { useReportsIndex } from './indexStore';
import { useTooltipReports } from './reportsCache';
import { useReportsTab } from './tabStore';

const report = (id: string, patch: Partial<PaneReport> = {}): PaneReport => ({
  id,
  owner_hash: 10,
  viewed_hash: 10,
  variant: 'base',
  lang: 'en',
  seen_lang: null,
  rev: 'a'.repeat(16),
  data_commit: '1'.repeat(40),
  status: 'open',
  version: 3,
  category: 'wrong-value',
  note: '',
  source_url: null,
  src: null,
  reporter_id: null,
  reporter_login: null,
  trust: 'anonymous',
  created_at: Math.floor(Date.now() / 1000) - 3 * 86400,
  updated_at: Math.floor(Date.now() / 1000),
  claimed_by: null,
  links: [],
  files_count: 0,
  duplicate_of: null,
  same_count: 0,
  closed_note: null,
  notes: [
    {
      n: 1,
      category: 'wrong-value',
      text: 'Gives 10%, not 7.5%.',
      exact: '7.5% Light',
      prefix: '',
      suffix: '',
      start: 0,
      end: 10,
      line: 0,
      whole: 0,
      rev: 'a'.repeat(16),
    },
  ],
  reporter_history: null,
  ...patch,
});

let host: HTMLDivElement;
let root: Root;
const maintainer: User = { id: 1, login: 'owner', role: 'maintainer' };
const editor: User = { id: 2, login: 'hazel', role: 'editor' };

async function settle() {
  for (let i = 0; i < 4; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
}
async function render(
  user: User,
  options: {
    count: number;
    suspended?: boolean;
    text?: string;
    variants?: { hash: number; text: string; globals: { variables: string; titles: string } }[];
  } = { count: 2 },
) {
  useReportsIndex.setState({ open: new Map([[10, { en: options.count }]]), owner: 'x' });
  await act(async () =>
    root.render(
      <ReportsPane
        hash={10}
        lang="en"
        user={user}
        text={options.text ?? '7.5% Light'}
        globals={{ variables: '', titles: '' }}
        variants={options.variants}
        previewHost={createRef()}
        suspended={options.suspended ?? false}
        ready
      />,
    ),
  );
  await settle();
}
const buttons = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
    (button) => button.textContent?.trim() === label,
  );
const click = async (element: HTMLElement | undefined) => {
  await act(async () => element!.click());
  await settle();
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  calls.fetch.length = 0;
  calls.actions.length = 0;
  calls.actionResult = null;
  calls.shots = {};
  vi.stubGlobal('URL', Object.assign(URL, { revokeObjectURL: vi.fn() }));
  calls.reports = [
    report('r-aaaaaaaa'),
    report('r-bbbbbbbb', {
      status: 'triaged',
      claimed_by: 'hazel',
      category: 'outdated',
      trust: 'account',
      reporter_login: 'kyber3000',
      reporter_history: { filed: 4, accepted: 3, rejected: 0 },
      links: ['https://youtu.be/x9Qa'],
    }),
    report('r-cccccccc', { status: 'closed' }),
  ];
  useTooltipReports.getState().clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('Reports pane', () => {
  it('makes no request for a tooltip whose index count is 0, until resolved ones are asked for', async () => {
    await render(editor, { count: 0 });
    expect(calls.fetch).toEqual([]);
    expect(host.textContent).toContain('No open reports in English');
    await click(buttons('Show resolved reports')[0]);
    expect(calls.fetch).toEqual([{ hash: 10, lang: 'en' }]);
  });

  it('focuses the list when opened by Alt+R or the header entry, even before it mounts', async () => {
    act(() => useReportsTab.getState().openAndFocus());
    await render(editor);
    expect(document.activeElement?.getAttribute('role')).toBe('listbox');
    expect(useReportsTab.getState().focusPending).toBe(false);
  });

  it('waits for the stepper to settle before fetching', async () => {
    await render(editor, { count: 2, suspended: true });
    expect(calls.fetch).toEqual([]);
    expect(host.textContent).toContain('2 open reports');
    await render(editor, { count: 2 });
    expect(calls.fetch).toEqual([{ hash: 10, lang: 'en' }]);
  });

  it('lists open reports with notes and the trust signal; resolved ones on request', async () => {
    await render(editor);
    const rows = [...host.querySelectorAll('[role="option"]')];
    expect(rows.map((row) => row.getAttribute('data-report'))).toEqual([
      'r-aaaaaaaa',
      'r-bbbbbbbb',
    ]);
    expect(rows[0]!.getAttribute('aria-selected')).toBe('true');
    expect(rows[0]!.textContent).toContain('○ anonymous');
    expect(rows[0]!.textContent).toContain('Gives 10%, not 7.5%.');
    expect(rows[1]!.textContent).toContain('● kyber3000 · filed 4, accepted 3');
    expect(rows[1]!.textContent).toContain('claimed by hazel');
    const video = rows[1]!.querySelector('a')!;
    expect(video.getAttribute('rel')).toBe('noopener noreferrer');
    await click(buttons('Show 1 resolved')[0]);
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(3);
  });

  it('offers maintainer-only actions to maintainers only', async () => {
    await render(editor);
    await click(document.querySelector<HTMLButtonElement>('[aria-label="More report actions"]')!);
    expect(buttons('Close')).toHaveLength(1);
    expect(buttons('Spam')).toHaveLength(0);
    expect(buttons('Delete…')).toHaveLength(0);
    act(() => root.unmount());
    root = createRoot(host);
    await render(maintainer);
    await click(document.querySelector<HTMLButtonElement>('[aria-label="More report actions"]')!);
    expect(buttons('Spam')).toHaveLength(1);
    expect(buttons('Delete…')).toHaveLength(1);
  });

  it('acts with the expected version, keeps the result, and undoes with the new version', async () => {
    await render(editor);
    await click(buttons('Triage')[0]);
    expect(calls.actions[0]).toEqual({
      id: 'r-aaaaaaaa',
      expected: 3,
      action: { action: 'triage' },
    });
    expect(host.querySelector('[data-report="r-aaaaaaaa"]')?.textContent).toContain('triaged');
    // Reject with a reason (version 4 now), then Undo = reopen expecting version 5.
    await click(buttons('Reject ▾')[0]);
    await click(buttons('Works as described')[0]);
    expect(calls.actions[1]).toEqual({
      id: 'r-aaaaaaaa',
      expected: 4,
      action: { action: 'reject', reason: 'works-as-described' },
    });
    expect(host.textContent).toContain('r-aaaaaaaa rejected.');
    await click(buttons('Undo')[0]);
    expect(calls.actions[2]).toEqual({
      id: 'r-aaaaaaaa',
      expected: 5,
      action: { action: 'reopen' },
    });
  });

  it('a 409 (someone changed it first) reloads the reports', async () => {
    await render(editor);
    calls.actionResult = () => {
      throw new ReportsHttpError(409, 'Report changed; reload');
    };
    await click(buttons('Claim')[0]);
    expect(host.textContent).toContain('r-aaaaaaaa: Report changed; reload. Reloaded.');
    expect(calls.fetch).toHaveLength(2);
  });

  it('says that undoing spam restores the status only', async () => {
    await render(maintainer);
    calls.actionResult = () => ({ id: 'r-aaaaaaaa', status: 'spam', version: 4 });
    await click(document.querySelector<HTMLButtonElement>('[aria-label="More report actions"]')!);
    await click(buttons('Spam')[0]);
    expect(host.textContent).toContain(
      'r-aaaaaaaa marked spam; its screenshots are deleted. Undo restores the status only.',
    );
  });

  it('keys reach the list only from the list: T in the screenshot lightbox posts nothing', async () => {
    calls.reports = [report('r-aaaaaaaa', { files_count: 1 })];
    calls.shots = { 2: 'blob:shot-2' };
    // jsdom has no modal dialogs.
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
    await render(editor, { count: 1 });
    const list = host.querySelector<HTMLElement>('[role="listbox"]')!;
    await click(buttons('▸ 1 screenshot')[0]);
    // Slot 1 was deleted: the one that survives is slot 2, shown under its own number.
    const thumb = document.querySelector<HTMLButtonElement>('[aria-label="Open screenshot 2"]');
    expect(thumb).not.toBeNull();
    await click(thumb!);
    const dialog = document.querySelector<HTMLElement>('dialog')!;
    expect(dialog).not.toBeNull();
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
      thumb!.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
    });
    await settle();
    expect(calls.actions).toHaveLength(0);
    // On the list itself, T triages.
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
    });
    await settle();
    expect(calls.actions).toEqual([
      { id: 'r-aaaaaaaa', expected: 3, action: { action: 'triage' } },
    ]);
  });

  it('spam drops the screenshots from the cached report and the row', async () => {
    calls.reports = [report('r-aaaaaaaa', { files_count: 2 })];
    calls.shots = { 1: 'blob:1', 2: 'blob:2' };
    await render(maintainer, { count: 1 });
    await click(buttons('▸ 2 screenshots')[0]);
    calls.actionResult = () => ({ id: 'r-aaaaaaaa', status: 'spam', version: 4 });
    await click(document.querySelector<HTMLButtonElement>('[aria-label="More report actions"]')!);
    await click(buttons('Spam')[0]);
    const cached = useTooltipReports.getState().entries['10:en']!.reports!;
    expect(cached[0]).toMatchObject({ status: 'spam', files_count: 0 });
    expect(document.querySelector('[aria-label^="Open screenshot"]')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:2');
  });

  it('anchors a note to the version it was made on; resolved notes get a state too', async () => {
    calls.reports = [
      // Quotes the enhanced version's text, which the base does not have.
      report('r-aaaaaaaa', {
        variant: 'enhanced',
        viewed_hash: 11,
        notes: [{ ...report('x').notes[0]!, exact: 'Heavy 12%', start: 0, end: 9 }],
      }),
      // Resolved, and its quote is gone from today's base text.
      report('r-cccccccc', {
        status: 'closed',
        notes: [{ ...report('x').notes[0]!, exact: 'Vanished words', start: 20, end: 34 }],
      }),
    ];
    await render(editor, {
      count: 1,
      text: 'Base text only',
      variants: [{ hash: 11, text: 'Heavy 12%', globals: { variables: '', titles: '' } }],
    });
    const enhanced = host.querySelector('[data-report="r-aaaaaaaa"]')!;
    expect(enhanced.textContent).toContain('Heavy 12%');
    expect(enhanced.textContent).not.toContain('Text changed since this report.');
    await click(buttons('Show 1 resolved')[0]);
    expect(host.querySelector('[data-report="r-cccccccc"]')!.textContent).toContain(
      'Text changed since this report.',
    );
  });
});
