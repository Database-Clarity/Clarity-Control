// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useCompendiumCount } from './CompendiumBadge';
import { useCompendiumStore } from './store';
import { useDataStore, type EditorData } from '../../stores/data';

const original = { compendium: useCompendiumStore.getState(), data: useDataStore.getState() };
let host: HTMLDivElement;
let root: Root;
const load = vi.fn<(force?: boolean) => Promise<void>>(async () => {});
function Probe({ loads }: { loads?: boolean }) {
  useCompendiumCount(loads);
  return null;
}
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  load.mockClear();
  useCompendiumStore.setState({ data: null, load });
  const data = { bundle: { tooltips: {} }, items: {}, aliases: {} } as unknown as EditorData;
  useDataStore.setState({ data, status: 'ready' });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  useCompendiumStore.setState(original.compendium);
  useDataStore.setState(original.data);
});

it('never loads or prefetches the live sheet when it may not (translators)', async () => {
  await act(async () => root.render(createElement(Probe, { loads: false })));
  await act(async () => vi.runAllTimers());
  expect(load).not.toHaveBeenCalled();
});

it('loads it for everyone else, as before', async () => {
  await act(async () => root.render(createElement(Probe)));
  await act(async () => vi.runAllTimers());
  expect(load).toHaveBeenCalled();
});
