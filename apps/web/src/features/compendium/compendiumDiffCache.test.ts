import { afterEach, expect, it, vi } from 'vitest';
import type { CompendiumCell } from '@clarity/core';
import { projectCompendiumDiff } from './compendiumDiffProjection';

const cell = (plain: string): CompendiumCell => ({ plain, runs: [{ text: plain }] });
class FakeWorker {
  static instances: FakeWorker[] = [];
  requests: { id: number; before: CompendiumCell; after: CompendiumCell }[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
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
      data: { id: request.id, lines: projectCompendiumDiff(request.before, request.after) },
    });
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  FakeWorker.instances = [];
});
async function setup() {
  vi.stubGlobal('Worker', FakeWorker);
  return import('./compendiumDiffCache');
}

it('reuses identical immutable content and computes a new projection for revised source', async () => {
  const { prepareCompendiumDiff, preparedLines } = await setup();
  const before = cell('A saved line'),
    after = cell('A current line');
  const first = prepareCompendiumDiff(before, after, new AbortController().signal);
  const worker = FakeWorker.instances[0];
  worker.complete();
  await first;
  expect(preparedLines(before, after)).toEqual(projectCompendiumDiff(before, after));
  expect(
    prepareCompendiumDiff(
      structuredClone(before),
      structuredClone(after),
      new AbortController().signal,
    ),
  ).toBeUndefined();
  const revised = cell('A revised current line');
  const second = prepareCompendiumDiff(before, revised, new AbortController().signal);
  expect(worker.requests).toHaveLength(2);
  worker.complete();
  await second;
  expect(preparedLines(before, revised)).toEqual(projectCompendiumDiff(before, revised));
});

it('removes superseded queued targets so only the current target follows running work', async () => {
  const { prepareCompendiumDiff, preparedLines } = await setup();
  const before = cell('Saved'),
    first = cell('First'),
    obsolete = cell('Obsolete'),
    latest = cell('Latest');
  const running = prepareCompendiumDiff(before, first, new AbortController().signal);
  const controller = new AbortController();
  const cancelled = prepareCompendiumDiff(before, obsolete, controller.signal)!;
  const rejection = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  const current = prepareCompendiumDiff(before, latest, new AbortController().signal);
  const worker = FakeWorker.instances[0];
  worker.complete();
  await running;
  expect(worker.requests.map((r) => r.after.plain)).toEqual(['First', 'Latest']);
  worker.complete();
  await current;
  await rejection;
  expect(preparedLines(before, latest)).toEqual(projectCompendiumDiff(before, latest));
});

it('ignores a stale worker fallback after that result has already completed', async () => {
  const { prepareCompendiumDiff, preparedLines } = await setup();
  const before = cell('Saved'),
    first = cell('First'),
    latest = cell('Latest');
  const running = prepareCompendiumDiff(before, first, new AbortController().signal);
  const current = prepareCompendiumDiff(before, latest, new AbortController().signal);
  const worker = FakeWorker.instances[0];
  worker.onerror?.();
  worker.complete();
  await running;
  await new Promise((resolve) => setTimeout(resolve, 5));
  FakeWorker.instances[1].complete();
  await current;
  expect(preparedLines(before, latest)).toEqual(projectCompendiumDiff(before, latest));
});

it('keeps queued shared preparation when one consumer is cancelled', async () => {
  const { prepareCompendiumDiff } = await setup();
  const first = prepareCompendiumDiff(
    cell('Saved A'),
    cell('Current A'),
    new AbortController().signal,
  );
  const a = new AbortController(),
    b = new AbortController();
  const shared = prepareCompendiumDiff(cell('Saved B'), cell('Current B'), a.signal);
  expect(prepareCompendiumDiff(cell('Saved B'), cell('Current B'), b.signal)).toBe(shared);
  a.abort();
  const worker = FakeWorker.instances[0];
  worker.complete();
  await first;
  expect(worker.requests).toHaveLength(2);
  worker.complete();
  await shared;
});
