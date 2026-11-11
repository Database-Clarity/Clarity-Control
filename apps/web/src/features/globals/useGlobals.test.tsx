// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import * as model from './model';
import { useGlobalCatalog, useGlobalDefinition } from './useGlobals';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import type { EditorData } from '../../stores/data';

const data = {
  bundle: {
    tooltips: {
      2: {
        hash: 2,
        text: {
          en: { text: 'var Alpha = one', updatedBy: 'test', updatedAt: '2026-11-11T00:00:00Z' },
        },
        associated: [],
      },
    },
  },
} as unknown as EditorData;
const original = useDraftStore.getState();
const host = document.createElement('div');
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  await act(async () => root.unmount());
  useDraftStore.setState(original);
  vi.restoreAllMocks();
  host.remove();
});
it('does no draft extraction on the input path, and refreshes visible globals after paint', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useDraftStore.setState({ drafts: {}, hydrated: true });
  document.body.append(host);
  root = createRoot(host);
  function Surface({ visible }: { visible: boolean }) {
    const entries = useGlobalCatalog(data, visible);
    return <output>{entries.map((entry) => entry.name).join(',')}</output>;
  }
  const extract = vi.spyOn(model, 'globalDefinitions');
  await act(async () => root.render(<Surface visible={false} />));
  extract.mockClear();
  useDraftStore
    .getState()
    .edit(data.bundle.tooltips[2], 'en', 'var Alpha = two\nvar Beta = new', 'test');
  expect(extract).not.toHaveBeenCalled();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
  expect(extract).not.toHaveBeenCalled();
  expect(host.textContent).toBe('Alpha');
  await act(async () => root.render(<Surface visible />));
  expect(host.textContent).toBe('Alpha,Beta');
  extract.mockClear();
  useDraftStore
    .getState()
    .edit(data.bundle.tooltips[2], 'en', 'var Alpha = three\nvar Gamma = new', 'test');
  expect(extract).not.toHaveBeenCalled();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
  expect(extract).toHaveBeenCalled();
  expect(host.textContent).toBe('Alpha,Gamma');
});

it('does not rerender a selected declaration for edits elsewhere in its aggregate', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const saved = useDataStore.getState();
  useDataStore.setState({ data });
  useDraftStore.setState({ drafts: {}, hydrated: true });
  document.body.append(host);
  root = createRoot(host);
  let renders = 0;
  function Surface() {
    renders++;
    const entry = useGlobalDefinition(2, 'Alpha');
    return <output>{entry?.definitions.en}</output>;
  }
  try {
    await act(async () => root.render(<Surface />));
    const before = renders;
    useDraftStore
      .getState()
      .edit(data.bundle.tooltips[2], 'en', 'var Alpha = one\nvar Other = changed', 'test');
    expect(renders).toBe(before);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(renders).toBe(before);
    expect(host.textContent).toBe('one');
  } finally {
    useDataStore.setState(saved);
  }
});
