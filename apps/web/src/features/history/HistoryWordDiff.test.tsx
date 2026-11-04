// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { HistoryWordDiff } from './HistoryWordDiff';

it('moves large diffs to a worker, preserves text immediately and ignores obsolete results', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const messages: { id: number; before: string; after: string }[] = [];
  const instances: FakeWorker[] = [];
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void;
    postMessage(data: (typeof messages)[number]) {
      messages.push(data);
    }
    constructor() {
      instances.push(this);
    }
  }
  vi.stubGlobal('Worker', FakeWorker);
  const host = document.createElement('div');
  const root = createRoot(host);
  const before = 'old '.repeat(600),
    after = 'new '.repeat(600);
  try {
    await act(async () => root.render(<HistoryWordDiff before={before} after={after} />));
    expect(messages).toHaveLength(1);
    expect(host.querySelector('del')?.textContent).toBe(before);
    expect(host.querySelector('ins')?.textContent).toBe(after);
    await act(async () => root.render(<HistoryWordDiff before="same" after="same" />));
    await act(async () =>
      instances[0].onmessage?.({
        data: { id: messages[0].id, parts: [{ kind: 'insert', text: 'obsolete' }] },
      }),
    );
    expect(host.textContent).toBe('same');
    await act(async () => root.render(<HistoryWordDiff before={before} after={after} />));
    await act(async () =>
      instances[0].onmessage?.({
        data: { id: messages[1].id, parts: [{ kind: 'equal', text: 'computed' }] },
      }),
    );
    expect(host.textContent).toBe('computed');
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
