// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseMarkup } from '@clarity/core';
import { GlobalEntryWorkspace } from '../src/features/globals/GlobalEntryWorkspace';
import {
  GlobalImpactComparison,
  globalImpactLines,
  validGlobalImpact,
} from '../src/features/globals/GlobalImpactComparison';
import type { GlobalSnapshot, GlobalsService } from '../src/services/globals';
import { globalFixtureSnapshot } from './globals-entries-fixture';

let change: (value: string) => void;
vi.mock('../src/features/editor/ClarityEditor', () => ({
  ClarityEditor: (props: { onChange(value: string): void; value: string }) => {
    change = props.onChange;
    return <textarea value={props.value} readOnly />;
  },
}));

let root: Root | undefined;
let host: HTMLDivElement;
const stored = new Map<string, string>();
beforeEach(() => {
  stored.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await act(async () => root?.unmount());
  root = undefined;
  host?.remove();
});

const button = (text: string) => {
  const value = [...document.querySelectorAll('button')].find((node) => node.textContent === text);
  if (!value) throw new Error(`Missing button: ${text}`);
  return value;
};

function mockService(first: GlobalSnapshot, latest = first) {
  return {
    read: vi
      .fn<GlobalsService['read']>()
      .mockResolvedValueOnce({ kind: 'ok', value: first })
      .mockResolvedValue({ kind: 'ok', value: latest }),
    mutate: vi
      .fn<GlobalsService['mutate']>()
      .mockResolvedValue({ kind: 'invalid', message: 'No fixture write.' }),
    retrySync: vi.fn<GlobalsService['retrySync']>(),
  };
}

async function mount(service: GlobalsService) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <MemoryRouter>
        <GlobalEntryWorkspace
          service={service}
          actor={{ role: 'maintainer', languages: [] }}
          entryId=""
        />
      </MemoryRouter>,
    ),
  );
}

it.each(['Discard', 'Reload and discard draft'])(
  'keeps further typing on a stale draft blocked until explicit %s',
  async (resolution) => {
    const first = structuredClone(globalFixtureSnapshot);
    const latest = structuredClone(first);
    latest.head = 'a'.repeat(40);
    latest.entries[0].revision = 'r2';
    latest.entries[0].definitions.en!.body = 'REMOTE BODY';
    const service = mockService(first, latest);
    await mount(service);
    await act(async () => change('LOCAL DRAFT'));
    // Reopening the page reads the newer revision; the kept draft is now stale.
    await act(async () => root!.unmount());
    host.remove();
    await mount(service);
    await act(async () => change('LOCAL DRAFT plus one key'));
    expect(host.querySelector('textarea')!.value).toBe('LOCAL DRAFT plus one key');
    expect(host.textContent).toContain('saved revision changed');
    expect(button('Save').disabled).toBe(true);
    await act(async () => button('Save').click());
    expect(service.mutate).not.toHaveBeenCalled();

    await act(async () => button(resolution).click());
    expect(host.querySelector('textarea')!.value).toBe('REMOTE BODY');
    expect(host.textContent).not.toContain('saved revision changed');
    await act(async () => change('FRESH LOCAL'));
    expect(button('Save').disabled).toBe(false);
    const committed = structuredClone(latest);
    committed.head = 'b'.repeat(40);
    committed.entries[0].revision = 'r3';
    committed.entries[0].definitions.en!.body = 'FRESH LOCAL';
    service.mutate.mockResolvedValueOnce({ kind: 'ok', value: committed });
    await act(async () => button('Save').click());
    expect(service.mutate).toHaveBeenLastCalledWith({
      expectedHead: latest.head,
      mutation: {
        operation: 'edit',
        id: first.entries[0].id,
        revision: 'r2',
        lang: 'en',
        body: 'FRESH LOCAL',
      },
    });
    await act(async () => change('FRESH LOCAL plus one key'));
    expect(button('Save').disabled).toBe(false);
    await act(async () => button('Save').click());
    expect(service.mutate).toHaveBeenLastCalledWith({
      expectedHead: committed.head,
      mutation: {
        operation: 'edit',
        id: first.entries[0].id,
        revision: 'r3',
        lang: 'en',
        body: 'FRESH LOCAL plus one key',
      },
    });
  },
);

it('fails closed for malformed nested pinned data in rendered and Raw views', () => {
  const malformed = [
    null,
    {},
    [null],
    [[]],
    [{ linesContent: [null] }],
    [{ linesContent: {} }],
    [{ linesContent: [{ text: {} }] }],
    [{ linesContent: [{ link: [] }] }],
    [{ linesContent: [{ title: [{ linesContent: [null] }] }] }],
    [{ linesContent: [{ classNames: [false] }] }],
    [{ classNames: 'bold' }],
    [{ classNames: [{}] }],
    [{ table: [null] }],
    [{ table: [{ rowContent: [null] }] }],
    [{ table: [{ rowContent: [{}] }] }],
    [{ table: [{ rowContent: [{ cellContent: [null] }] }] }],
    [{ table: [{ rowContent: [{ cellContent: [], colSpan: '2' }] }] }],
    [{ table: [{ rowContent: [{ cellContent: [], rowSpan: {} }] }] }],
    [{ isFormula: {} }],
  ];
  for (const tree of malformed) {
    const row = structuredClone(globalFixtureSnapshot.impacts.g_damage0001[0]);
    row.before!.rendered = JSON.stringify(tree);
    expect(validGlobalImpact(row), row.before!.rendered).toBe(false);
    for (const raw of [false, true])
      expect(renderToStaticMarkup(<GlobalImpactComparison row={row} raw={raw} />)).toContain(
        'Pinned render unavailable. Reload before reviewing.',
      );
  }
});

it('preserves valid empty lines, class slots, nested titles, and real parser tables', () => {
  const row = structuredClone(globalFixtureSnapshot.impacts.g_damage0001[0]);
  const parsed = parseMarkup(
    '<bold Strong />\n\n<solar/> text\n< table >\n|2 Alpha|r-2 Beta\n<$>',
    {
      variables: '',
      titles: '',
    },
  ).lines;
  const lines = [
    {},
    { linesContent: [] },
    {
      linesContent: [
        {
          text: 'Title',
          title: [{ linesContent: [{ text: 'Nested title', classNames: ['bold', null] }] }],
        },
      ],
    },
    ...parsed,
  ];
  row.before!.rendered = JSON.stringify(lines);
  expect(validGlobalImpact(row)).toBe(true);
  expect(globalImpactLines(row.before)).toHaveLength(lines.length);
  expect(parsed.some((line) => line.table)).toBe(true);
  const html = renderToStaticMarkup(<GlobalImpactComparison row={row} raw={false} />);
  expect(html).toContain('Nested title');
  expect(html).toContain('<table');
  expect(html).toContain('Alpha');
  row.before!.rendered = '[]';
  expect(globalImpactLines(row.before)).toEqual([]);
});

it('disables confirmation and acknowledgement for a malformed pinned render', async () => {
  const snapshot = structuredClone(globalFixtureSnapshot);
  snapshot.impacts.g_damage0001[0].before!.rendered = '[{"linesContent":[null]}]';
  const service = mockService(snapshot);
  await mount(service);
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Review Focused Fury"]')!.click(),
  );
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
    'Pinned render unavailable.',
  );
  expect(
    document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!.disabled,
  ).toBe(true);
  expect(button('Acknowledge review').disabled).toBe(true);
  await act(async () => button('Acknowledge review').click());
  expect(service.mutate).not.toHaveBeenCalled();
});
