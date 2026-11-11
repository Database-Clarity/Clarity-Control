// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { RenderedWordDiff } from './RenderedWordDiff';
import { renderedDiff } from './renderedDiff';
import { editorData, english } from '../../services/save/fixtures.testSupport';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';

it('renders long content immediately, ignores obsolete worker replies, and retains content on failure', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const requests: { id: number; before: string; after: string }[] = [];
  const instances: FakeWorker[] = [];
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: () => void;
    constructor() {
      instances.push(this);
    }
    postMessage(request: (typeof requests)[number]) {
      requests.push(request);
    }
    terminate() {}
  }
  vi.stubGlobal('Worker', FakeWorker);
  const host = document.createElement('div'),
    root = createRoot(host);
  const before = 'Old '.repeat(600),
    after = 'New '.repeat(600);
  const show = (left: string, right: string) => (
    <RenderedWordDiff before={left} after={right} lang="en" hash={10} />
  );
  try {
    await act(async () => root.render(show(before, after)));
    expect(requests).toHaveLength(1);
    expect(host.querySelector('del')?.textContent).toBe(before.trimEnd());
    expect(host.querySelector('ins')?.textContent).toBe(after.trimEnd());
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () => root.render(show('Small old', 'Small new')));
    await act(async () =>
      instances[0].onmessage?.({
        data: {
          id: requests[0].id,
          result: renderedDiff(before, after, { variables: '', titles: '' }),
        },
      }),
    );
    expect(host.textContent).not.toContain('Old Old');
    expect(host.querySelector('ins')?.textContent).toBe('new');
    await act(async () => root.render(show(before, after)));
    await act(async () => instances[0].onerror?.());
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    expect(host.querySelector('ins')?.textContent).toBe(after.trimEnd());
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it('uses the preview draft globals without subscribing the comparison to typing', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const originalData = useDataStore.getState(),
    originalDrafts = useDraftStore.getState();
  const data = editorData();
  const base = { hash: 2, associated: [], text: { en: { ...english, text: 'var amount = 10' } } };
  const value = (amount: number) => ({
    ...base,
    text: { en: { ...english, text: `var amount = ${amount}` } },
  });
  data.bundle.tooltips[2] = base;
  useDataStore.setState({ data });
  useDraftStore.setState({ drafts: { 2: { base, next: value(20) } } });
  const host = document.createElement('div'),
    root = createRoot(host);
  const show = (after: string) => (
    <RenderedWordDiff before="#amount damage" after={after} lang="en" hash={123} />
  );
  try {
    await act(async () => root.render(show('#amount damage!')));
    expect(host.textContent).toContain('20 damage');
    expect(host.textContent).not.toContain('10 damage');
    await act(async () => useDraftStore.setState({ drafts: { 2: { base, next: value(40) } } }));
    expect(host.textContent).toContain('20 damage');
    await act(async () => root.render(show('#amount damage!!')));
    expect(host.textContent).toContain('40 damage');
  } finally {
    await act(async () => root.unmount());
    useDataStore.setState(originalData);
    useDraftStore.setState(originalDrafts);
  }
});
