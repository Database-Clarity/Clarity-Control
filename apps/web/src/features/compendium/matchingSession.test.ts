import { afterEach, expect, it, vi } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { createWorkerBridge, bindSourceWorker } from './workerBridge';
import { sendWorkerResult } from './workerReplies';
import { matchingSession, prewarmMatchingSession } from './matchingSession';

const streams = vi.hoisted(() => ({ inputs: [] as unknown[] }));
vi.mock('./streamInputs', () => ({
  streamInputs: async (value: unknown) => {
    streams.inputs.push(value);
  },
}));
afterEach(() => vi.unstubAllGlobals());

it('initializes the retained worker before source delivery and reuses that session once bound', async () => {
  streams.inputs = [];
  const fixture = guidedFixture();
  const worker = { postMessage: vi.fn(), terminate: vi.fn() } as unknown as Worker;
  const bridge = createWorkerBridge(worker);
  // The source request is still outstanding: no main-thread source object is bound yet.
  prewarmMatchingSession(fixture.editor, bridge);
  prewarmMatchingSession(fixture.editor, bridge);
  await Promise.resolve();
  expect(streams.inputs).toEqual([{ editor: fixture.editor }]);
  const initialize = vi
    .mocked(worker.postMessage)
    .mock.calls.find(([value]) => value.initialize)?.[0];
  expect(initialize).toBeDefined();
  bindSourceWorker(fixture.source, bridge);
  const session = matchingSession(fixture.editor, fixture.source);
  expect(streams.inputs).toHaveLength(1);
  sendWorkerResult(
    (data) => worker.onmessage!.call(worker, { data } as MessageEvent),
    initialize.id,
    new Map(),
  );
  expect(await session.proposals).toEqual(new Map());
  expect(worker.terminate).not.toHaveBeenCalled();
  session.dispose();
});
