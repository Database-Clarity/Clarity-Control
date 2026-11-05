// @vitest-environment jsdom
import { act, Component, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompendiumCell } from '@clarity/core';
import { usePreparedPaneDiff } from './usePreparedPaneDiff';
import * as projection from './compendiumDiffProjection';
import { preparedLines } from './compendiumDiffCache';
import * as cache from './compendiumDiffCache';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cell = (plain: string): CompendiumCell => ({ plain, runs: [{ text: plain }] });
class FakeWorker {
  static instances: FakeWorker[] = [];
  requests: { id: number; before: CompendiumCell; after: CompendiumCell }[] = [];
  onmessage?: (event: { data: unknown }) => void;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(request: FakeWorker['requests'][number]) {
    this.requests.push(request);
  }
  terminate() {}
  complete(index = this.requests.length - 1) {
    const request = this.requests[index];
    this.onmessage?.({
      data: {
        id: request.id,
        lines: projection.projectCompendiumDiff(request.before, request.after),
      },
    });
  }
}
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function View({
  before,
  after,
  paused,
}: {
  before?: CompendiumCell;
  after?: CompendiumCell;
  paused?: boolean;
}) {
  const prepared = usePreparedPaneDiff(before, after, 'changes', paused);
  return createElement(
    'output',
    { 'aria-busy': prepared.pending },
    prepared.pair?.after.plain ?? 'retained',
  );
}

it('does not prepare during stepping and resumes only the newest source pair', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  const prepare = vi.spyOn(cache, 'prepareCompendiumDiff');
  const inspect = vi.spyOn(cache, 'hasPreparedDiff');
  const host = document.createElement('div');
  root = createRoot(host);
  const before = cell('Paused snapshot');
  await act(async () =>
    root!.render(
      createElement(View, { before, after: cell('Obsolete paused source'), paused: true }),
    ),
  );
  const after = cell('Newest paused source');
  await act(async () => root!.render(createElement(View, { before, after, paused: true })));
  expect(prepare).not.toHaveBeenCalled();
  expect(inspect).not.toHaveBeenCalled();
  await act(async () => root!.render(createElement(View, { before, after, paused: false })));
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(prepare.mock.calls[0][1]).toBe(after);
  await act(async () => FakeWorker.instances[0].complete());
  expect(host.textContent).toBe('Newest paused source');
});

it('prepares a late source reply without running its projection during render', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  const project = vi.spyOn(projection, 'projectCompendiumDiff');
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(View)));
  await act(async () =>
    root!.render(
      createElement(View, { before: cell('Late saved A'), after: cell('Late current A') }),
    ),
  );
  expect(host.firstElementChild?.getAttribute('aria-busy')).toBe('true');
  expect(project).not.toHaveBeenCalled();
  await act(async () => FakeWorker.instances[0].complete());
  expect(host.firstElementChild?.getAttribute('aria-busy')).toBe('false');
  expect(host.textContent).toBe('Late current A');
});

it('never commits a superseded late reply', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const before = cell('Late saved B');
  await act(async () =>
    root!.render(createElement(View, { before, after: cell('Obsolete late B') })),
  );
  await act(async () =>
    root!.render(createElement(View, { before, after: cell('Latest late B') })),
  );
  const worker = FakeWorker.instances[0];
  await act(async () => worker.complete());
  expect(host.firstElementChild?.getAttribute('aria-busy')).toBe('true');
  expect(host.textContent).not.toContain('Obsolete');
  await act(async () => worker.complete());
  expect(host.firstElementChild?.getAttribute('aria-busy')).toBe('false');
  expect(host.textContent).toBe('Latest late B');
});

it('prepares the visible comparison again after shared cache eviction', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const before = cell('Evicted saved'),
    after = cell('Evicted current');
  await act(async () => root!.render(createElement(View, { before, after })));
  const worker = FakeWorker.instances[0];
  await act(async () => worker.complete());
  expect(host.firstElementChild?.getAttribute('aria-busy')).toBe('false');
  for (let index = 0; index < 35; index++)
    preparedLines(cell(`Cache saved ${index}`), cell(`Cache current ${index}`));
  await act(async () => root!.render(createElement(View, { before, after })));
  expect(host.firstElementChild?.getAttribute('aria-busy')).toBe('true');
  await act(async () => worker.complete());
  expect(host.firstElementChild?.getAttribute('aria-busy')).toBe('false');
  expect(host.textContent).toBe('Evicted current');
});

it('surfaces a failed projection instead of retaining a busy pane forever', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(cache, 'prepareCompendiumDiff').mockRejectedValue(new Error('Projection failed'));
  class Boundary extends Component<{ children: ReactNode }, { error?: Error }> {
    state: { error?: Error } = {};
    static getDerivedStateFromError(error: Error) {
      return { error };
    }
    render() {
      return this.state.error?.message ?? this.props.children;
    }
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      createElement(Boundary, {
        children: createElement(View, {
          before: cell('Failed saved'),
          after: cell('Failed current'),
        }),
      }),
    ),
  );
  expect(host.textContent).toBe('Projection failed');
});
