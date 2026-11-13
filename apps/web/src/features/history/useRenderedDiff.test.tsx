// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { RenderedWordDiff } from './RenderedWordDiff';
import { renderedDiff } from './renderedDiff';
import { editorData, english } from '../../services/save/fixtures.testSupport';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { analyzeSourceOnly } from './sourceOnlyChanges';
import type { RenderedDiffRequest } from './renderedDiff.worker';
const settleWorker = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 210));
  });

it.each([
  ['Same\nvar unused = 1', 'Same\nvar unused = 2', 'variable'],
  ['Same', 'Same\nvar unused = 1', 'variable'],
  ['Same\n// Old comment', 'Same\n// New comment', 'comment'],
  ['Same\nenhanced (\nvar d = 1\nExtra\n)', 'Same\nenhanced (\nvar d = 2\nExtra\n)', 'enhanced'],
])(
  'locates a source-only %s change without a generic note on ordinary diffs',
  async (before, after, kind) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const instances: AutoWorker[] = [];
    class AutoWorker {
      onmessage?: (event: { data: unknown }) => void;
      onerror?: () => void;
      constructor() {
        instances.push(this);
      }
      terminate() {}
      postMessage(request: RenderedDiffRequest) {
        if ('cancel' in request) return;
        const { id, before, after, globals } = request;
        // Same order as the worker: the diff, then the complete source check.
        const diff = renderedDiff(before, after, globals);
        const sourceAnalysis = analyzeSourceOnly(before, after, globals, diff);
        queueMicrotask(() => {
          this.onmessage?.({ data: { id, result: diff } });
          this.onmessage?.({ data: { id, sourceAnalysis } });
        });
      }
    }
    vi.stubGlobal('Worker', AutoWorker);
    const host = document.createElement('div'),
      root = createRoot(host);
    try {
      await act(async () =>
        root.render(<RenderedWordDiff before={before} after={after} lang="en" hash={10} />),
      );
      const marker = [...host.querySelectorAll('[data-source-change]')].find((marker) =>
        marker.textContent?.toLowerCase().includes(kind.toLowerCase()),
      );
      expect(marker?.textContent).toContain('Source changed');
      expect(marker?.textContent).toContain(kind === 'enhanced' ? 'lines 2–5' : 'line 2');
      expect(host.querySelector('ins, del')).toBeNull();
      await act(async () =>
        root.render(<RenderedWordDiff before="Old" after="New" lang="en" hash={10} />),
      );
      await settleWorker();
      expect(host.querySelector('[data-source-change]')).toBeNull();
      await act(async () =>
        root.render(<RenderedWordDiff before="" after="New" lang="en" hash={10} working />),
      );
      await settleWorker();
      expect(host.textContent).toContain('(not present)');
      expect([...host.querySelectorAll('strong')].map((x) => x.textContent)).toEqual([
        'Saved',
        'Unsaved',
      ]);
      expect(host.querySelector('[data-source-change]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      instances.at(-1)?.onerror?.();
      vi.unstubAllGlobals();
    }
  },
);

it('hides provisional long content, ignores obsolete worker replies, and retains content on failure', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const requests: { id: number; before: string; after: string }[] = [];
  const cancels: number[] = [];
  const instances: FakeWorker[] = [];
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: () => void;
    constructor() {
      instances.push(this);
    }
    postMessage(request: RenderedDiffRequest) {
      if ('cancel' in request) cancels.push(request.cancel);
      else requests.push(request);
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
    expect(host.querySelector('del')).toBeNull();
    expect(host.querySelector('ins')).toBeNull();
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    const openingRequests = requests.length;
    await act(async () => root.render(show('Small old', 'Small new1')));
    // A newer diff cancels the open check in the worker.
    expect(cancels).toEqual([requests[0].id]);
    await act(async () => root.render(show('Small old', 'Small new2')));
    await act(async () => root.render(show('Small old', 'Small new')));
    expect(requests).toHaveLength(openingRequests);
    await settleWorker();
    expect(requests).toHaveLength(openingRequests + 1);
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
    await settleWorker();
    await act(async () => instances[0].onerror?.());
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    expect(host.querySelector('ins')?.textContent).toBe(after.trimEnd());
    const requested = requests.length;
    await act(async () => root.render(show('', after)));
    await settleWorker();
    expect(requests).toHaveLength(requested + 1);
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    expect(host.querySelector('ins')?.textContent).toBe(after.trimEnd());
    await act(async () => root.render(show(before, '')));
    await settleWorker();
    expect(requests).toHaveLength(requested + 2);
    expect(host.querySelector('del')?.textContent).toBe(before.trimEnd());
  } finally {
    await act(async () => root.unmount());
    instances.at(-1)?.onerror?.();
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
