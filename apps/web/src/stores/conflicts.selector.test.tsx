// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { useDraftStore } from './drafts';
import { useConflictStore, useOpenConflicts, usePausedForOtherTab } from './conflicts';

it('keeps ordinary typing out of conflict consumers and updates languages and other-tab pause', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const originals = { drafts: useDraftStore.getState(), conflicts: useConflictStore.getState() };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let renders = 0;
  const tip = (en: string, de?: string): Tooltip => ({
    hash: 10,
    associated: [],
    text: {
      en: { text: en, updatedAt: '2026-11-04T00:00:00Z', updatedBy: 'test' },
      ...(de === undefined
        ? {}
        : { de: { text: de, updatedAt: '2026-11-04T00:00:00Z', updatedBy: 'test' } }),
    },
  });
  const update = (en: string, de?: string) =>
    act(async () => {
      useDraftStore.setState({ drafts: { 10: { base: tip('saved'), next: tip(en, de) } } });
    });
  function Consumer() {
    const summary = useOpenConflicts();
    const paused = usePausedForOtherTab();
    renders++;
    return <output>{JSON.stringify({ summary, paused })}</output>;
  }
  try {
    useDraftStore.setState({ drafts: {}, external: false });
    useConflictStore.setState({ sessions: {} });
    await act(async () => root.render(<Consumer />));
    const initial = renders;
    await update('ordinary typing');
    await update('ordinary typing continues');
    expect(renders).toBe(initial);
    const marked = '<<<<<<< mine\nA\n=======\nB\n>>>>>>> theirs';
    await update(marked);
    expect(host.textContent).toContain('"byLanguage":{"en":1}');
    await update(marked, marked);
    expect(host.textContent).toContain('"byLanguage":{"en":1,"de":1}');
    await act(async () => useDraftStore.setState({ external: true }));
    expect(host.textContent).toContain('"paused":true');
    await update('resolved');
    expect(host.textContent).toBe('{"summary":[],"paused":false}');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    useDraftStore.setState(originals.drafts);
    useConflictStore.setState(originals.conflicts);
    vi.unstubAllGlobals();
  }
});
