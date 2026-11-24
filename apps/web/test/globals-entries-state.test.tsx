// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GlobalEntryWorkspace } from '../src/features/globals/GlobalEntryWorkspace';
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
    if (resolution === 'Discard') {
      // The header's Discard asks first, in place.
      const confirm = document.querySelector('[role="group"][aria-label="Discard this draft?"]');
      expect(host.querySelector('textarea')!.value).toBe('LOCAL DRAFT plus one key');
      await act(async () =>
        [...confirm!.querySelectorAll('button')].find((b) => b.textContent === 'Discard')!.click(),
      );
    }
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
