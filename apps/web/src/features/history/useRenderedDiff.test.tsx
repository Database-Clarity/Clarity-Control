// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { RenderedWordDiff } from './RenderedWordDiff';
import { renderedDiff } from './renderedDiff';

it('renders long content immediately, ignores obsolete worker replies, and retains content on failure', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const requests: { id: number; before: string; after: string }[] = [];
  let worker: FakeWorker;
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: () => void;
    constructor() { worker = this; }
    postMessage(request: typeof requests[number]) { requests.push(request); }
    terminate() {}
  }
  vi.stubGlobal('Worker', FakeWorker);
  const host = document.createElement('div'), root = createRoot(host);
  const before = 'Old '.repeat(600), after = 'New '.repeat(600);
  const show = (left: string, right: string) => <RenderedWordDiff before={left} after={right} lang="en" hash={10} />;
  try {
    await act(async () => root.render(show(before, after)));
    expect(requests).toHaveLength(1);
    expect(host.querySelector('del')?.textContent).toBe(before);
    expect(host.querySelector('ins')?.textContent).toBe(after);
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () => root.render(show('Small old', 'Small new')));
    await act(async () => worker!.onmessage?.({data:{id:requests[0].id,result:renderedDiff(before, after, {variables:'',titles:''})}}));
    expect(host.textContent).not.toContain('Old Old');
    expect(host.querySelector('ins')?.textContent).toBe('new');
    await act(async () => root.render(show(before, after)));
    await act(async () => worker!.onerror?.());
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    expect(host.querySelector('ins')?.textContent).toBe(after);
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
