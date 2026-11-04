import { afterEach, expect, it, vi } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { emptyProgress } from './reviewProgress';
import { sendWorkerResult } from './workerReplies';

afterEach(() => vi.unstubAllGlobals());
it('shares a worker across views and avoids resending results for empty guidance or selection changes', async () => {
  vi.resetModules();
  const requests: Record<string, unknown>[] = [];
  const terminate = vi.fn();
  class FakeWorker {
    onmessage?: (event: MessageEvent) => void;
    terminate = terminate;
    postMessage(data: Record<string, unknown>) {
      requests.push(data);
      queueMicrotask(() =>
        sendWorkerResult(
          (reply) => this.onmessage?.({ data: reply } as MessageEvent),
          data.id as number,
          data.editor ? new Map() : { matches: new Map(), decisions: [] },
        ),
      );
    }
  }
  vi.stubGlobal('Worker', FakeWorker);
  const { matchingSession } = await import('./matchingSession');
  const f = guidedFixture();
  const first = matchingSession(f.editor, f.source);
  expect(matchingSession(f.editor, f.source)).toBe(first);
  const input = { drafts: {}, progress: emptyProgress(), scope: f.scope };
  const a = first.display(input);
  await a;
  const b = first.display({
    ...input,
    progress: { ...input.progress, selected: 101, query: 'sample' },
    local: { version: 1, scope: f.scope, baseline: '', categories: {} },
  });
  expect(b).toBe(a);
  expect(requests).toHaveLength(2); // Initial proposals plus one display result.
  await first.display({ ...input, local: f.document });
  expect(requests).toHaveLength(3);
  const reloaded = matchingSession(f.editor, { ...f.source });
  expect(reloaded).not.toBe(first);
  expect(terminate).toHaveBeenCalledTimes(1);
  await reloaded.proposals;
});
