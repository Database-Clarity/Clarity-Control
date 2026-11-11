// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { recoveryDraft, artifactSchema } from '../lost-text/model';
import artifact from '../lost-text/lost-text.json';
import { ReviewDetail } from '../review/ReviewDetail';
import { useDataStore, type EditorData } from '../../stores/data';
import { useAuthStore } from '../../stores/auth';
import { useDraftStore } from '../../stores/drafts';
import { useSaveState } from '../../services/save/state';

vi.mock('../../services/api', async (original) => ({
  ...(await original<typeof import('../../services/api')>()),
  apiUrl: 'https://api.test',
}));
vi.mock('../../services/history', () => ({
  getHistory: async () => ({ page: 1, commits: [] }),
  getPushedVersion: async () => ({ tooltip: pushed, pushedHash: 'pushed' }),
}));
vi.mock('./TooltipDiff', () => ({ TooltipDiff: () => null }));

const text = (value: string) => ({
  text: value,
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: 'test',
});
const tooltip = (label: string): Tooltip => ({
  hash: 10,
  text: { en: text(`${label} en`), de: text(`${label} de`), fr: text(`${label} fr`) },
  associated: [label.length],
});
const saved = tooltip('saved');
const pushed = tooltip('pushed');
const base = tooltip('base');
const local = tooltip('local');
const originals = {
  data: useDataStore.getState(),
  auth: useAuthStore.getState(),
  drafts: useDraftStore.getState(),
  save: useSaveState.getState(),
};
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  useDataStore.setState(originals.data);
  useAuthStore.setState(originals.auth);
  useDraftStore.setState(originals.drafts);
  useSaveState.setState(originals.save);
});

it.each(['de', 'es'] as const)(
  'recovers actual lost %s text without changing other languages',
  (lang) => {
    const record = artifactSchema.parse(artifact).records.find((entry) => entry.lang === lang)!;
    expect(record).toBeDefined();
    const current = { ...saved, hash: record.hash, text: { ...saved.text, [lang]: text('') } };
    const next = recoveryDraft(current, record, { id: 1, login: 'editor', role: 'editor' });
    expect(next.text[lang]?.text).toBe(record.text);
    expect(next.text.en).toEqual(current.text.en);
    expect(next.associated).toEqual(current.associated);
    expect(current.text[lang]?.text).toBe('');
  },
);

it.each(['maintainer', 'translator'] as const)(
  'loads Review pushed German and rebases for %s',
  async (role) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    useAuthStore.setState({ user: { id: 1, login: 'test', role, languages: ['de'] } });
    useDataStore.setState({
      data: {
        bundle: { tooltips: { 10: saved } },
        items: {},
        aliases: {},
        categories: [],
      } as unknown as EditorData,
    });
    useDraftStore.setState({
      drafts: { 10: { base, next: local } },
      hydrated: true,
      retry: vi.fn(),
    });
    useSaveState.setState({ locked: false });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <MemoryRouter>
          <ReviewDetail
            entry={{
              tooltip: saved,
              name: 'Test',
              category: 'Test',
              categoryId: 'test',
              categoryOrder: 0,
              markerOnly: false,
              isNew: false,
            }}
            included={false}
            selectionLocked={false}
            onInclude={() => {}}
          />
        </MemoryRouter>,
      ),
    );
    const button = (label: string) =>
      [...host!.querySelectorAll('button')].find((entry) => entry.textContent === label)!;
    await act(async () => button('Load last pushed as draft').click());
    await act(async () => button('Confirm load as draft').click());
    const draft = useDraftStore.getState().drafts[10];
    expect(draft.next.text.de).toEqual(pushed.text.de);
    expect(draft.base.text.de).toEqual(saved.text.de);
    if (role === 'maintainer') {
      expect(draft.next).toEqual(pushed);
      expect(draft.base).toEqual(saved);
    } else {
      expect(draft.next).toEqual({ ...local, text: { ...local.text, de: pushed.text.de } });
      expect(draft.base).toEqual({ ...base, text: { ...base.text, de: saved.text.de } });
    }
  },
);
